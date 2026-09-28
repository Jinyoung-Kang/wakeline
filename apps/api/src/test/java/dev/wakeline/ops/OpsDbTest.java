package dev.wakeline.ops;

import dev.wakeline.DbTestSupport;
import dev.wakeline.config.AppProperties;
import dev.wakeline.config.Problem;
import dev.wakeline.persist.MaintenanceJobs;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.node.JsonNodeFactory;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 운영 경로를 실제 PostGIS·Redis 로: 원자적 로그인 잠금(동시 실패), 설정 변경 + 감사 한 트랜잭션, Redis 전용 토글의 감사 원자성,
 * .env 관심 지역 반영 규칙, 관심 지역 캐시의 출처(Redis → DB).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpsDbTest {
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"));
    static GenericContainer<?> redisContainer;
    static LettuceConnectionFactory redisFactory;
    static LettuceConnectionFactory deadFactory;

    JdbcClient api;
    JdbcClient admin;
    StringRedisTemplate redis;
    StringRedisTemplate deadRedis;
    AuditService audit;

    @BeforeAll
    static void startRedis() {
        redisContainer = new GenericContainer<>(DockerImageName.parse("redis:8-alpine")).withExposedPorts(6379);
        redisContainer.start();
        redisFactory = factory(redisContainer.getHost(), redisContainer.getMappedPort(6379));
        deadFactory = factory("127.0.0.1", 1); // 닫힌 포트 — Redis 장애
    }

    static LettuceConnectionFactory factory(String host, int port) {
        var f = new LettuceConnectionFactory(new RedisStandaloneConfiguration(host, port),
                LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(2)).build());
        f.afterPropertiesSet();
        f.start();
        return f;
    }

    @AfterAll
    static void stopRedis() {
        if (redisFactory != null) redisFactory.destroy();
        if (deadFactory != null) deadFactory.destroy();
        if (redisContainer != null) redisContainer.stop();
    }

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        api = DbTestSupport.apiClient();
        admin = DbTestSupport.admin();
        redis = new StringRedisTemplate(redisFactory);
        deadRedis = new StringRedisTemplate(deadFactory);
        redis.delete(List.of(SettingsService.REDIS_KEY, "wakeline:provider:opensky", "wakeline:provider:adsbdb"));
        audit = new AuditService(api, DbTestSupport.JSON, PROPS);
    }

    RegionSettings region(StringRedisTemplate r) { return new RegionSettings(r, api, DbTestSupport.JSON, PROPS); }

    SettingsService settings(StringRedisTemplate r) { return new SettingsService(api, r, DbTestSupport.JSON, DbTestSupport.apiTx(), region(r)); }

    long auditCount(String action) {
        return admin.sql("SELECT count(*) FROM audit_log WHERE action = :a").param("a", action).query(Long.class).single();
    }

    static MockHttpServletRequest request() {
        var req = new MockHttpServletRequest("PUT", "/api/v1/ops/x");
        req.setRemoteAddr("127.0.0.1");
        return req;
    }

    // ---------- 로그인 잠금 ----------

    // ---------- 비밀번호 교체 → 세션 폐기(R-95) ----------

    /** 사용자 목록의 세션을 지운다(없는 id 는 세지 않는다). 목록 키에는 TTL(절대 수명 + 1 h)이 걸린다. 다른 사용자는 그대로. */
    @Test
    void passwordChangeDeletesTheUsersRegisteredSessions() {
        OpsSessionRegistry registry = new OpsSessionRegistry(redis, "wakeline:session", Duration.ofHours(8));
        OpsUserService users = new OpsUserService(api, registry);
        assertThat(users.upsert("alice", "correct-horse-battery")).as("new account: nothing to end").isZero();
        assertThat(users.upsert("bob", "correct-horse-battery")).isZero();
        int alice = api.sql("SELECT id FROM ops_user WHERE username = 'alice'").query(Integer.class).single();
        int bob = api.sql("SELECT id FROM ops_user WHERE username = 'bob'").query(Integer.class).single();
        for (String id : List.of("s-a1", "s-a2", "s-b1")) redis.opsForHash().put("wakeline:session:sessions:" + id, "creationTime", "x");
        registry.register(alice, "s-a1");
        registry.register(alice, "s-a2");
        registry.register(alice, "s-gone"); // 이미 끝난 세션
        registry.register(bob, "s-b1");
        Long ttl = redis.getExpire(OpsSessionRegistry.key(alice));
        assertThat(ttl).isBetween(Duration.ofHours(8).toSeconds(), Duration.ofHours(9).toSeconds());
        registry.unregister(alice, "s-gone");

        assertThat(users.upsert("alice", "a-new-correct-horse")).isEqualTo(2);
        assertThat(redis.hasKey("wakeline:session:sessions:s-a1")).isFalse();
        assertThat(redis.hasKey("wakeline:session:sessions:s-a2")).isFalse();
        assertThat(redis.hasKey(OpsSessionRegistry.key(alice))).isFalse();
        assertThat(redis.hasKey("wakeline:session:sessions:s-b1")).as("other operator").isTrue();
        assertThat(users.authenticate("alice", "a-new-correct-horse").user()).isPresent();
        redis.delete(List.of("wakeline:session:sessions:s-b1", OpsSessionRegistry.key(bob)));
    }

    /** Redis 장애: 비밀번호는 바뀐다(예전 비밀번호로 되돌리지 않는다) — 세션을 끝내지 못했다는 것은 예외로 알린다(CLI 가 종료 코드 3). */
    @Test
    void passwordChangeStillAppliesWhenSessionsCannotBeEnded() {
        OpsUserService users = new OpsUserService(api, new OpsSessionRegistry(deadRedis, "wakeline:session", Duration.ofHours(8)));
        assertThatThrownBy(() -> users.upsert("carol", "correct-horse-battery"))
                .isInstanceOf(OpsUserService.SessionsNotRevoked.class)
                .hasMessageContaining("carol").hasMessageNotContaining("correct-horse-battery");
        assertThat(users.authenticate("carol", "correct-horse-battery").user()).isPresent();
    }

    @Test
    void concurrentWrongPasswordsLockTheAccountAfterExactlyFiveFailures() throws Exception {
        OpsUserService users = new OpsUserService(api, new OpsSessionRegistry(redis, "wakeline:session", Duration.ofHours(8)));
        users.upsert("admin", "correct-horse-battery");
        ExecutorService pool = Executors.newFixedThreadPool(10);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<OpsUserService.AuthResult>> fs = new ArrayList<>();
        for (int i = 0; i < 10; i++) fs.add(pool.submit(() -> { go.await(); return users.authenticate("admin", "wrong-password-" + Math.random()); }));
        go.countDown();
        int lockedNow = 0;
        for (var f : fs) {
            var r = f.get();
            assertThat(r.user()).isEmpty();
            if (r.lockedNow()) lockedNow++;
        }
        pool.shutdown();
        // 이전의 읽고-쓰기 방식은 동시 실패가 서로 덮어써 10번 실패해도 잠기지 않을 수 있었다
        assertThat(lockedNow).isEqualTo(1);
        Map<String, Object> row = admin.sql("SELECT failed_count, locked_until > now() locked FROM ops_user WHERE username = 'admin'").query().singleRow();
        assertThat(row).containsEntry("locked", true);
        // 잠긴 동안에는 맞는 비밀번호도 실패(사유 LOCKED)
        var r = users.authenticate("admin", "correct-horse-battery");
        assertThat(r.user()).isEmpty();
        assertThat(r.failure()).isEqualTo(OpsUserService.Failure.LOCKED);
        // 잠금이 풀리면 성공하고 카운터가 0 으로
        admin.sql("UPDATE ops_user SET locked_until = now() - interval '1 second'").update();
        assertThat(users.authenticate("admin", "correct-horse-battery").user()).isPresent();
        assertThat(users.authenticate("nobody", "whatever-password").failure()).isEqualTo(OpsUserService.Failure.UNKNOWN_USER);
    }

    // ---------- 설정 변경 + 감사 ----------

    @Test
    void settingUpdateAndAuditCommitTogetherOrNotAtAll() {
        SettingsService s = settings(redis);
        var req = request();
        // 감사 기록이 실패하면 설정도 바뀌지 않는다
        assertThatThrownBy(() -> s.update("region_poll_s", JsonNodeFactory.instance.numberNode(20), 1, "ops",
                (b, a) -> { throw new IllegalStateException("audit down"); })).hasMessageContaining("audit down");
        assertThat(s.get("region_poll_s")).containsEntry("version", 1);
        // 정상: 설정·감사가 함께, 커밋 후 Redis 미러
        Map<String, Object> after = s.update("region_poll_s", JsonNodeFactory.instance.numberNode(20), 1, "ops",
                (b, a) -> audit.record(req, null, "SETTING_UPDATE", "region_poll_s", b, a));
        assertThat(after).containsEntry("version", 2).containsEntry("mirrored", true);
        assertThat(auditCount("SETTING_UPDATE")).isEqualTo(1);
        assertThat(redis.opsForHash().get(SettingsService.REDIS_KEY, "region_poll_s")).isEqualTo("20");
        // 버전 충돌 → 409, 감사 없음
        assertThatThrownBy(() -> s.update("region_poll_s", JsonNodeFactory.instance.numberNode(30), 1, "ops",
                (b, a) -> audit.record(req, null, "SETTING_UPDATE", "region_poll_s", b, a)))
                .isInstanceOf(Problem.class).hasMessageContaining("changed by someone else");
        assertThat(auditCount("SETTING_UPDATE")).isEqualTo(1);
    }

    @Test
    void mirrorFailureStillCommitsButReportsNotMirrored() {
        SettingsService s = settings(deadRedis);
        Map<String, Object> after = s.update("region_center", JsonNodeFactory.instance.stringNode("35.5,139.7"), 1, "ops",
                (b, a) -> audit.record(request(), null, "SETTING_UPDATE", "region_center", b, a));
        assertThat(after).containsEntry("mirrored", false);
        assertThat(auditCount("SETTING_UPDATE")).isEqualTo(1);
    }

    @Test
    void regionComesFromRuntimeSettingsLikeTheCollector() {
        SettingsService s = settings(redis);
        RegionSettings rs = region(redis);
        assertThat(rs.current()).isEqualTo(new RegionSettings.Region(36.5, 127.8, 250)); // 아직 못 읽음 → .env 기본값
        s.update("region_center", JsonNodeFactory.instance.stringNode("35.5,139.7"), 1, "ops", (b, a) -> { });
        assertThat(rs.refreshNow()).isEqualTo(new RegionSettings.Region(35.5, 139.7, 250)); // collector 가 보는 Redis 값
        // Redis 가 없으면 app_setting 에서
        assertThat(region(deadRedis).refreshNow()).isEqualTo(new RegionSettings.Region(35.5, 139.7, 250));
        // 범위를 벗어난 값은 저장되지 않는다(정규식만으로는 99,999 가 통과했다)
        assertThatThrownBy(() -> s.update("region_center", JsonNodeFactory.instance.stringNode("99,999"), 2, "ops", (b, a) -> { }))
                .isInstanceOf(Problem.class);
    }

    @Test
    void envRegionSeedsOnlyValuesNoOperatorChanged() {
        SettingsService s = settings(redis);
        assertThat(s.seedFromEnv("35.1,129.0", 200, audit)).containsExactly("region_center", "region_radius_nm");
        assertThat(s.get("region_center")).containsEntry("updated_by", "env");
        assertThat(auditCount("SETTING_SEED_ENV")).isEqualTo(2);
        assertThat(s.seedFromEnv("35.1,129.0", 200, audit)).isEmpty(); // 같은 값 — 다시 쓰지 않는다
        // 운영자가 바꾼 뒤에는 .env 가 덮어쓰지 않는다
        s.update("region_radius_nm", JsonNodeFactory.instance.numberNode(300), 2, "alice", (b, a) -> { });
        assertThat(s.seedFromEnv("35.1,129.0", 150, audit)).isEmpty();
        assertThat(s.get("region_radius_nm").get("value").toString()).isEqualTo("300");
        // 검증을 통과하지 못한 .env 값은 쓰지 않는다
        assertThat(s.seedFromEnv("123,456", 200, audit)).isEmpty();
    }

    // ---------- Redis 전용 토글 ----------

    /**
     * 계약 v4 §G A-2(리뷰 collector-route #5): 노선 조회 공급자 adsbdb 도 운영 화면에서 감사 기록과 함께 끄고 켠다 — 수집기가 읽는
     * wakeline:provider:adsbdb disabled 를 쓴다. 공급자 목록(/ops/providers)에 수집기가 쓴 호출 상태가 보인다(노선 내용은 해시에 없다).
     */
    @Test
    void adsbdbIsAnOpsProvider_toggledWithAudit_andListed() {
        var status = new dev.wakeline.rest.StatusService(null, null, null, null, redis, PROPS);
        var jobs = new MaintenanceJobs(api, PROPS, region(redis), DbTestSupport.apiTx());
        var auth = new OpsAuthentication(new OpsUserService.User(1, "alice", "OPS"), List.of(new SimpleGrantedAuthority("ROLE_OPS")));
        admin.sql("INSERT INTO ops_user (id, username, password_hash) VALUES (1, 'alice', 'x')").update();
        var ops = new OpsController(status, api, redis, settings(redis), audit, jobs, DbTestSupport.apiTx());

        assertThat(ops.toggleProvider("adsbdb", "disable", request(), auth).getStatusCode().value()).isEqualTo(204);
        assertThat(redis.opsForHash().get("wakeline:provider:adsbdb", "disabled")).isEqualTo("1");
        assertThat(admin.sql("SELECT target FROM audit_log WHERE action = 'PROVIDER_DISABLE'").query(String.class).single()).isEqualTo("adsbdb");
        ops.toggleProvider("adsbdb", "enable", request(), auth);
        assertThat(redis.opsForHash().get("wakeline:provider:adsbdb", "disabled")).isEqualTo("0");
        assertThat(auditCount("PROVIDER_ENABLE")).isEqualTo(1);

        redis.opsForHash().putAll("wakeline:provider:adsbdb", Map.of("last_error", "HTTP 503", "consecutive_failures", "2"));
        assertThat(status.providerStatuses()).filteredOn(p -> "adsbdb".equals(p.get("name"))).singleElement()
                .satisfies(p -> assertThat(p).containsEntry("disabled", "0").containsEntry("last_error", "HTTP 503"));
    }

    @Test
    void providerToggleIsAuditedAtomically() {
        var status = new dev.wakeline.rest.StatusService(null, null, null, null, redis, PROPS);
        var jobs = new MaintenanceJobs(api, PROPS, region(redis), DbTestSupport.apiTx());
        var auth = new OpsAuthentication(new OpsUserService.User(1, "alice", "OPS"), List.of(new SimpleGrantedAuthority("ROLE_OPS")));
        admin.sql("INSERT INTO ops_user (id, username, password_hash) VALUES (1, 'alice', 'x')").update();

        var ok = new OpsController(status, api, redis, settings(redis), audit, jobs, DbTestSupport.apiTx());
        ok.toggleProvider("opensky", "disable", request(), auth);
        assertThat(redis.opsForHash().get("wakeline:provider:opensky", "disabled")).isEqualTo("1");
        assertThat(auditCount("PROVIDER_DISABLE")).isEqualTo(1);

        // Redis 가 죽어 있으면: 변경도 감사 행도 없다(503 으로 번역되는 Redis 예외)
        var down = new OpsController(status, api, deadRedis, settings(deadRedis), audit, jobs, DbTestSupport.apiTx());
        assertThatThrownBy(() -> down.toggleProvider("opensky", "enable", request(), auth)).isInstanceOf(RedisConnectionFailureException.class);
        assertThat(auditCount("PROVIDER_ENABLE")).isZero();

        // 감사 INSERT 가 실패하면(DB 쪽 오류) Redis 값도 바뀌지 않는다
        var brokenAudit = new AuditService(api, DbTestSupport.JSON, PROPS) {
            @Override public void record(jakarta.servlet.http.HttpServletRequest req, Integer userId, String action, String target, Object before, Object after) {
                throw new org.springframework.dao.DataAccessResourceFailureException("db down");
            }
        };
        var noAudit = new OpsController(status, api, redis, settings(redis), brokenAudit, jobs, DbTestSupport.apiTx());
        assertThatThrownBy(() -> noAudit.toggleProvider("opensky", "enable", request(), auth)).hasMessageContaining("db down");
        assertThat(redis.opsForHash().get("wakeline:provider:opensky", "disabled")).isEqualTo("1");
    }
}
