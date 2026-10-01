package dev.wakeline.ops;

import dev.wakeline.DbTestSupport;
import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.web.Problem;
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
 * 운영 경로를 실제 PostGIS·Redis 로: 원자적 로그인 잠금(동시 실패), 설정 변경 + 감사 한 트랜잭션, 공급자 스위치(DB 원본 + 감사 한 트랜잭션,
 * Redis 미러·이관·주기 미러), .env 관심 지역 반영 규칙, 관심 지역 캐시의 출처(Redis → DB).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpsDbTest {
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"), List.of());
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
        List<String> keys = new ArrayList<>(List.of(SettingsService.REDIS_KEY));
        for (String p : dev.wakeline.rest.StatusService.PROVIDERS) keys.add(ProviderSwitchService.key(p));
        redis.delete(keys);
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

    // ---------- 공급자 스위치(R-94, 계약 v5 §D1): 원본은 DB provider_switch, Redis 는 미러 ----------

    ProviderSwitchService switches(StringRedisTemplate r) { return new ProviderSwitchService(api, r, DbTestSupport.apiTx(), audit); }

    OpsController ops(StringRedisTemplate r, AuditService a) {
        var status = new dev.wakeline.rest.StatusService(null, null, null, null, r, PROPS);
        var jobs = new MaintenanceJobs(api, PROPS, region(r), DbTestSupport.apiTx());
        return new OpsController(status, api, r, settings(r), a, jobs, DbTestSupport.apiTx(), switches(r),
                new ResolutionService(new ResolutionRepository(api), DbTestSupport.apiTx()));
    }

    /** 실제 상태 서비스(빈 스토어)를 쓰는 운영 컨트롤러 — /ops/providers 처럼 공개 상태도 읽는 응답용. */
    OpsController opsWithStatus(StringRedisTemplate r, AuditService a) {
        var snapshots = new dev.wakeline.ingest.SnapshotStore();
        var sigmets = new dev.wakeline.ingest.SigmetStore();
        var status = new dev.wakeline.rest.StatusService(snapshots, sigmets, new dev.wakeline.ingest.RadarStore(),
                new dev.wakeline.engine.EngineService(snapshots, sigmets, e -> { }, new io.micrometer.core.instrument.simple.SimpleMeterRegistry()), r, PROPS);
        return new OpsController(status, api, r, settings(r), a, new MaintenanceJobs(api, PROPS, region(r), DbTestSupport.apiTx()), DbTestSupport.apiTx(),
                switches(r), new ResolutionService(new ResolutionRepository(api), DbTestSupport.apiTx()));
    }

    /**
     * 리뷰 cto-2026-10 A4(B10): 수집기 자동 전환(wakeline:events)을 Redis 장애로 읽지 못하면 빈 목록과 함께 error — '전환 없음' 과 구별된다(같은 컨트롤러의
     * /ops/dlq 와 같은 모양). 예전에는 빈 목록뿐이었다.
     */
    @Test
    void providersSaysWhenTheSwitchEventsCouldNotBeRead() {
        Map<String, Object> down = opsWithStatus(deadRedis, audit).providers();
        assertThat(down).containsEntry("error", "redis unavailable");
        assertThat((List<?>) down.get("switches")).isEmpty();
        Map<String, Object> up = opsWithStatus(redis, audit).providers();
        assertThat(up).doesNotContainKey("error").containsKeys("providers", "active", "collector", "switches", "budget_days", "budget_day_zone",
                "provider_switch", "resolution_state", "generated_at");
    }

    static final OpsAuthentication ALICE = new OpsAuthentication(new OpsUserService.User(1, "alice", "OPS"), List.of(new SimpleGrantedAuthority("ROLE_OPS")));

    void alice() { admin.sql("INSERT INTO ops_user (id, username, password_hash) VALUES (1, 'alice', 'x')").update(); }

    Map<String, Object> switchRow(String provider) {
        return admin.sql("SELECT disabled, version, updated_by FROM provider_switch WHERE provider = :p").param("p", provider).query().singleRow();
    }

    long switchRows() { return admin.sql("SELECT count(*) FROM provider_switch").query(Long.class).single(); }

    Object redisFlag(String provider) { return redis.opsForHash().get(ProviderSwitchService.key(provider), "disabled"); }

    /**
     * 계약 v4 §G A-2(리뷰 collector-route #5): 노선 조회 공급자 adsbdb 도 운영 화면에서 감사 기록과 함께 끄고 켠다 — 수집기가 읽는
     * wakeline:provider:adsbdb disabled 는 DB 원본의 미러다. 공급자 목록(/ops/providers)에 수집기가 쓴 호출 상태가 보인다(노선 내용은 해시에 없다).
     */
    @Test
    void adsbdbIsAnOpsProvider_toggledWithAudit_andListed() {
        alice();
        var ops = ops(redis, audit);
        assertThat(ops.toggleProvider("adsbdb", "disable", request(), ALICE))
                .containsEntry("provider", "adsbdb").containsEntry("disabled", true).containsEntry("version", 1).containsEntry("mirrored", true);
        assertThat(redisFlag("adsbdb")).isEqualTo("1");
        assertThat(admin.sql("SELECT target FROM audit_log WHERE action = 'PROVIDER_DISABLE'").query(String.class).single()).isEqualTo("adsbdb");
        assertThat(ops.toggleProvider("adsbdb", "enable", request(), ALICE)).containsEntry("disabled", false).containsEntry("version", 2);
        assertThat(redisFlag("adsbdb")).isEqualTo("0");
        assertThat(auditCount("PROVIDER_ENABLE")).isEqualTo(1);
        assertThat(admin.sql("SELECT before::text || ' -> ' || after::text FROM audit_log WHERE action = 'PROVIDER_ENABLE'").query(String.class).single())
                .isEqualTo("{\"version\": 1, \"disabled\": true} -> {\"version\": 2, \"disabled\": false}"); // jsonb 는 짧은 키부터

        redis.opsForHash().putAll("wakeline:provider:adsbdb", Map.of("last_error", "HTTP 503", "consecutive_failures", "2"));
        var status = new dev.wakeline.rest.StatusService(null, null, null, null, redis, PROPS);
        assertThat(status.providerStatuses()).filteredOn(p -> "adsbdb".equals(p.get("name"))).singleElement()
                .satisfies(p -> assertThat(p).containsEntry("disabled", "0").containsEntry("last_error", "HTTP 503"));
        assertThatThrownBy(() -> ops.toggleProvider("nope", "disable", request(), ALICE)).isInstanceOf(Problem.class);
        assertThatThrownBy(() -> ops.toggleProvider("opensky", "explode", request(), ALICE)).isInstanceOf(Problem.class);
        assertThat(switchRows()).isEqualTo(1);
    }

    /** 토글 = 감사 행 + DB 갱신 한 트랜잭션. 감사가 실패하면 DB 도 Redis 도 그대로다. updated_by 는 운영자 id. */
    @Test
    void providerToggleCommitsTheSwitchAndItsAuditRowTogetherOrNotAtAll() {
        alice();
        ops(redis, audit).toggleProvider("opensky", "disable", request(), ALICE);
        assertThat(switchRow("opensky")).containsEntry("disabled", true).containsEntry("version", 1).containsEntry("updated_by", 1);
        assertThat(redisFlag("opensky")).isEqualTo("1");
        assertThat(auditCount("PROVIDER_DISABLE")).isEqualTo(1);

        // 감사 INSERT 가 실패하면(DB 쪽 오류) 스위치도 Redis 값도 바뀌지 않는다
        var brokenAudit = new AuditService(api, DbTestSupport.JSON, PROPS) {
            @Override public void record(jakarta.servlet.http.HttpServletRequest req, Integer userId, String action, String target, Object before, Object after) {
                throw new org.springframework.dao.DataAccessResourceFailureException("db down");
            }
        };
        assertThatThrownBy(() -> ops(redis, brokenAudit).toggleProvider("opensky", "enable", request(), ALICE)).hasMessageContaining("db down");
        assertThat(switchRow("opensky")).containsEntry("disabled", true).containsEntry("version", 1);
        assertThat(redisFlag("opensky")).isEqualTo("1");
        assertThat(auditCount("PROVIDER_ENABLE")).isZero();
    }

    /**
     * Redis 장애: 이전에는 Redis 가 원본이라 토글 자체가 503 이었다. 이제 원본(DB)과 감사는 커밋되고 응답이 mirrored=false 를 알린다 —
     * Redis 가 돌아오면 주기 미러(StartupMirror → sync)가 맞춘다.
     */
    @Test
    void redisOutageStillCommitsTheSwitchAndThePeriodicMirrorCatchesUp() {
        alice();
        ops(redis, audit).toggleProvider("opensky", "disable", request(), ALICE);
        assertThat(ops(deadRedis, audit).toggleProvider("opensky", "enable", request(), ALICE))
                .containsEntry("disabled", false).containsEntry("version", 2).containsEntry("mirrored", false);
        assertThat(auditCount("PROVIDER_ENABLE")).isEqualTo(1);
        assertThat(switchRow("opensky")).containsEntry("disabled", false);
        assertThat(redisFlag("opensky")).as("not mirrored yet").isEqualTo("1");
        assertThatThrownBy(() -> switches(deadRedis).sync()).isInstanceOf(RedisConnectionFailureException.class);

        assertThat(switches(redis).sync().corrected()).containsExactly("opensky");
        assertThat(redisFlag("opensky")).isEqualTo("0");
    }

    /**
     * 주기 미러: collector 는 같은 해시에 상태 필드를 쓰므로(ACL ~wakeline:provider:*) disabled 도 바꿀 수 있다 — 다음 주기(60 s)에 DB 값으로
     * 돌아온다. Redis 를 잃어도(볼륨 손실·AOF 복구) 꺼 둔 스위치가 조용히 '켜짐'으로 돌아가지 않는다. 켜진 스위치는 해시가 없으면 만들지 않는다
     * (없음 = 켜짐, collector status.py 와 같은 뜻 — 운영 목록에 호출한 적 없는 공급자가 생기지 않게).
     */
    @Test
    void periodicMirrorRevertsCollectorWritesAndRestoresALostRedis() {
        alice();
        var ops = ops(redis, audit);
        ops.toggleProvider("adsbdb", "disable", request(), ALICE);
        ops.toggleProvider("opensky", "disable", request(), ALICE);
        ops.toggleProvider("opensky", "enable", request(), ALICE);
        var s = switches(redis);
        s.sync(); // 이관(행이 없는 공급자) — 아래 비교를 위해 먼저 끝낸다
        assertThat(s.sync().corrected()).as("in sync").isEmpty();

        // collector 계정이 운영자 결정을 뒤집는다
        redis.opsForHash().put(ProviderSwitchService.key("adsbdb"), "disabled", "0");
        redis.opsForHash().put(ProviderSwitchService.key("opensky"), "disabled", "1");
        assertThat(s.sync().corrected()).containsExactlyInAnyOrder("adsbdb", "opensky");
        assertThat(redisFlag("adsbdb")).isEqualTo("1");
        assertThat(redisFlag("opensky")).isEqualTo("0");

        // Redis 를 잃었다
        redis.delete(List.of(ProviderSwitchService.key("adsbdb"), ProviderSwitchService.key("opensky")));
        assertThat(s.sync().corrected()).containsExactly("adsbdb");
        assertThat(redisFlag("adsbdb")).isEqualTo("1");
        assertThat(redis.hasKey(ProviderSwitchService.key("opensky"))).as("enabled + no hash: nothing to write").isFalse();
        assertThat(switchRows()).isEqualTo(dev.wakeline.rest.StatusService.PROVIDERS.size());
    }

    /**
     * 이관: 행이 없는 공급자는 그때의 Redis 값을 한 번 옮겨 담는다("1" = 꺼짐, 그 밖·없음 = 켜짐 — collector 와 같은 뜻). 모든 공급자에 행을 만들므로
     * 한 번뿐이다 — 이관 뒤 collector 가 쓴 값은 원본이 되지 않고 되돌려진다. 이관은 시스템 감사 행(user 없음)으로 남는다. Redis 장애면 행을 만들지 않는다
     * (값을 모르는 채로 '켜짐'을 지어내지 않는다).
     */
    @Test
    void rowlessProvidersImportTheCurrentRedisValueExactlyOnce() {
        redis.opsForHash().put(ProviderSwitchService.key("adsbdb"), "disabled", "1");   // v5 전에 운영자가 끈 공급자
        redis.opsForHash().put(ProviderSwitchService.key("opensky"), "disabled", "0");
        redis.opsForHash().put(ProviderSwitchService.key("awc"), "last_ok_at", "2026-09-29T00:00:00Z"); // 상태만 있는 공급자
        assertThatThrownBy(() -> switches(deadRedis).sync()).isInstanceOf(RedisConnectionFailureException.class);
        assertThat(switchRows()).as("redis down: nothing imported").isZero();

        var r = switches(redis).sync();
        assertThat(r.imported()).containsExactlyInAnyOrderElementsOf(dev.wakeline.rest.StatusService.PROVIDERS);
        assertThat(r.corrected()).isEmpty();
        assertThat(switchRow("adsbdb")).containsEntry("disabled", true).containsEntry("version", 1).containsEntry("updated_by", null);
        assertThat(switchRow("opensky")).containsEntry("disabled", false);
        assertThat(switchRow("awc")).containsEntry("disabled", false);
        assertThat(auditCount("PROVIDER_SWITCH_IMPORT")).isEqualTo(dev.wakeline.rest.StatusService.PROVIDERS.size());
        assertThat(admin.sql("SELECT coalesce(user_id::text, '-') || ' ' || before::text || ' -> ' || after::text FROM audit_log WHERE action = 'PROVIDER_SWITCH_IMPORT' AND target = 'adsbdb'")
                .query(String.class).single()).isEqualTo("- {\"redis_disabled\": \"1\"} -> {\"version\": 1, \"disabled\": true}");
        assertThat(admin.sql("SELECT before::text FROM audit_log WHERE action = 'PROVIDER_SWITCH_IMPORT' AND target = 'awc'").query(String.class).single())
                .isEqualTo("{\"redis_disabled\": null}");

        // 한 번뿐: 이관 뒤 collector 가 kma_radar 를 꺼도 원본이 되지 않는다
        redis.opsForHash().put(ProviderSwitchService.key("kma_radar"), "disabled", "1");
        var again = switches(redis).sync();
        assertThat(again.imported()).isEmpty();
        assertThat(again.corrected()).containsExactly("kma_radar");
        assertThat(switchRow("kma_radar")).containsEntry("disabled", false);
        assertThat(redisFlag("kma_radar")).isEqualTo("0");
        assertThat(auditCount("PROVIDER_SWITCH_IMPORT")).isEqualTo(dev.wakeline.rest.StatusService.PROVIDERS.size());
    }

    /**
     * 운영 목록(/ops/providers 의 provider_switch): 공급자마다 원본(DB)과 collector 가 따르는 Redis 미러를 나란히 보인다 — 운영자가 Redis 장애 중에
     * 끈 공급자를 collector 가 아직 부르고 있는지 화면에서 안다. mirror_differs 는 collector 가 따르는 값("1" 이면 꺼짐, 그 밖·없음은 켜짐)이
     * 원본과 다른가. 행이 없거나(이관 전) Redis 를 읽지 못하면 null(모름) — 같다고도 다르다고도 하지 않는다.
     */
    @Test
    void theProviderListShowsTheDatabaseSwitchNextToTheRedisMirror() {
        alice();
        var s = switches(redis);
        assertThat(s.states()).extracting(m -> m.get("provider")).containsExactlyElementsOf(dev.wakeline.rest.StatusService.PROVIDERS);
        assertThat(s.states()).allSatisfy(m -> assertThat(m).containsEntry("disabled", null).containsEntry("version", null)
                .containsEntry("mirror_differs", null).containsEntry("redis_error", null));

        ops(redis, audit).toggleProvider("adsbdb", "disable", request(), ALICE);
        assertThat(state(s, "adsbdb")).containsEntry("disabled", true).containsEntry("version", 1).containsEntry("updated_by", "alice")
                .containsEntry("redis_disabled", "1").containsEntry("mirror_differs", false).containsKey("updated_at");
        assertThat(state(s, "adsbdb").get("updated_at")).isInstanceOf(java.time.Instant.class);

        // collector 계정이 뒤집었다 → 다음 주기 미러까지 collector 는 켜진 것으로 따른다
        redis.opsForHash().put(ProviderSwitchService.key("adsbdb"), "disabled", "0");
        assertThat(state(s, "adsbdb")).containsEntry("redis_disabled", "0").containsEntry("mirror_differs", true);
        // Redis 장애 중 토글: 원본은 바뀌었고, 미러는 모른다(null)
        assertThat(ops(deadRedis, audit).toggleProvider("opensky", "disable", request(), ALICE)).containsEntry("mirrored", false);
        assertThat(state(switches(deadRedis), "opensky")).containsEntry("disabled", true).containsEntry("version", 1)
                .containsEntry("redis_disabled", null).containsEntry("redis_error", "redis unavailable").containsEntry("mirror_differs", null);
        assertThat(state(s, "opensky")).as("redis back, not yet mirrored").containsEntry("redis_disabled", null).containsEntry("mirror_differs", true);

        s.sync(); // 이관(행이 없던 공급자 — 시스템, updated_by 없음) + 미러
        assertThat(s.states()).allSatisfy(m -> assertThat(m.get("mirror_differs")).as(String.valueOf(m.get("provider"))).isEqualTo(false));
        assertThat(state(s, "awc")).containsEntry("disabled", false).containsEntry("updated_by", null).containsEntry("redis_disabled", null);
        assertThat(state(s, "opensky")).containsEntry("redis_disabled", "1");
    }

    static final String CORRECTED = "provider switch in redis differed from provider_switch";

    static List<String> lines(org.springframework.boot.test.system.CapturedOutput out, String... parts) {
        return out.getAll().lines().filter(l -> java.util.Arrays.stream(parts).allMatch(l::contains)).toList();
    }

    /**
     * 토글 직후의 미러는 모든 공급자를 원본으로 맞춘다 — 그때 다른 공급자의 Redis 값을 고쳤다면(collector 가 바꿨거나 Redis 를 잃었다) 주기 미러와 같은
     * 경고로 남긴다(ADR-019). 방금 토글한 공급자는 운영자의 변경이라 넣지 않는다. 이전에는 고친 목록을 버려 조용히 되돌렸다.
     */
    @Test
    @org.junit.jupiter.api.extension.ExtendWith(org.springframework.boot.test.system.OutputCaptureExtension.class)
    void theToggleTimeMirrorWarnsAboutOtherProvidersItRestored(org.springframework.boot.test.system.CapturedOutput output) {
        alice();
        var ops = ops(redis, audit);
        ops.toggleProvider("adsbdb", "disable", request(), ALICE);
        assertThat(lines(output, CORRECTED)).as("nothing restored yet").isEmpty();
        redis.opsForHash().put(ProviderSwitchService.key("adsbdb"), "disabled", "0"); // collector 계정이 뒤집었다
        ops.toggleProvider("opensky", "disable", request(), ALICE);
        assertThat(redisFlag("adsbdb")).isEqualTo("1");
        assertThat(lines(output, CORRECTED)).singleElement().satisfies(l -> assertThat(l).contains("WARN").contains("[adsbdb]").doesNotContain("opensky"));
    }

    /**
     * 주기 동기화(R-94 의 안전망)가 계속 실패하면 기본 로그 수준에서 보인다(v5 시스템 로그는 WARN·ERROR 만 모은다): 성공 뒤 첫 실패는 WARN,
     * 계속 실패하면 10분마다 WARN(그 사이는 DEBUG), 실패 뒤 첫 성공은 INFO 로 한 번. 이전에는 기동 뒤의 실패가 DEBUG 뿐이었다.
     */
    @Test
    @org.junit.jupiter.api.extension.ExtendWith(org.springframework.boot.test.system.OutputCaptureExtension.class)
    void aFailingPeriodicSwitchSyncWarnsOnceThenEveryTenMinutesAndReportsRecovery(org.springframework.boot.test.system.CapturedOutput output) {
        boolean[] down = {true};
        var flaky = new ProviderSwitchService(api, redis, DbTestSupport.apiTx(), audit) {
            @Override public synchronized SyncResult sync() {
                if (down[0]) throw new RedisConnectionFailureException("redis down (test)");
                return super.sync();
            }
        };
        var m = new StartupMirror(settings(redis), region(redis), audit, PROPS, flaky);
        long[] now = {1_000_000L};
        m.clock = () -> now[0];
        String failed = "provider switch sync failed";

        m.periodicMirror();
        assertThat(lines(output, "WARN", failed)).hasSize(1);
        now[0] += 60_000;
        m.periodicMirror();
        now[0] += 8 * 60_000;
        m.periodicMirror();
        assertThat(lines(output, "WARN", failed)).as("not every 60 s").hasSize(1);
        now[0] += 60_000; // 첫 경고 뒤 10분
        m.periodicMirror();
        assertThat(lines(output, "WARN", failed)).hasSize(2);
        assertThat(lines(output, "WARN", failed).get(1)).contains("4 in a row");

        down[0] = false;
        now[0] += 60_000;
        m.periodicMirror();
        assertThat(lines(output, "INFO", "provider switch sync recovered")).hasSize(1);
        now[0] += 60_000;
        m.periodicMirror();
        assertThat(lines(output, "provider switch sync recovered")).as("once").hasSize(1);

        down[0] = true; // 성공 뒤 첫 실패는 바로 경고
        now[0] += 60_000;
        m.periodicMirror();
        assertThat(lines(output, "WARN", failed)).hasSize(3);
    }

    static Map<String, Object> state(ProviderSwitchService s, String provider) {
        return s.states().stream().filter(m -> provider.equals(m.get("provider"))).findFirst().orElseThrow();
    }

    /** 이관 전에 운영자가 토글하면 그 결정이 원본이다 — 뒤이은 이관은 그 행을 건드리지 않는다. */
    @Test
    void anOperatorToggleBeforeTheImportWins() {
        alice();
        redis.opsForHash().put(ProviderSwitchService.key("adsbdb"), "disabled", "1");
        ops(redis, audit).toggleProvider("adsbdb", "enable", request(), ALICE);
        assertThat(admin.sql("SELECT before::text FROM audit_log WHERE action = 'PROVIDER_ENABLE'").query(String.class).single())
                .as("no row yet: the database value is unknown").isEqualTo("{\"version\": null, \"disabled\": null}");
        var r = switches(redis).sync();
        assertThat(r.imported()).doesNotContain("adsbdb").hasSize(dev.wakeline.rest.StatusService.PROVIDERS.size() - 1);
        assertThat(switchRow("adsbdb")).containsEntry("disabled", false).containsEntry("updated_by", 1);
        assertThat(redisFlag("adsbdb")).isEqualTo("0");
    }
}
