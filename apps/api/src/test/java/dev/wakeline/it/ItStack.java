package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;

import java.time.Duration;

/**
 * 통합 테스트 스택(JVM 당 1벌, 종료 시 Ryuk 가 정리) — 운영 compose 와 같은 초기화:
 * <ul>
 *   <li>PostGIS: {@link DbTestSupport} 컨테이너(실제 infra/db/init/01-roles.sh)에 전용 DB {@value #DB} 를 같은 방법으로 만들고
 *       --migrate(wakeline_migrator)로 스키마를 올린다. 앱은 DML 전용 wakeline_api 로 접속한다. 다른 DB 테스트(wakeline)와 섞이지 않게 DB 를 나눈다
 *       (Spring 컨텍스트는 테스트 사이에 캐시되어 스케줄 잡·쓰기 스레드가 계속 돈다).</li>
 *   <li>Redis: redis:8-alpine 에 실제 infra/redis/start.sh · redis.conf 를 compose 와 같은 경로에 넣고, 같은 사용자(999:1000)·엔트리포인트로 띄운다
 *       — ACL 사용자 default(관리) · wakeline_api · wakeline_collector · wakeline_ais. 앱은 wakeline_api, 테스트의 XADD 는 수집기와 같은 wakeline_collector
 *       (선박 스트림은 ais 수집기와 같은 wakeline_ais)로 한다.</li>
 * </ul>
 */
public final class ItStack {
    public static final String DB = "wakeline_it";
    public static final String REDIS_IMAGE = "redis:8-alpine";
    public static final String REDIS_ADMIN_PW = "redis-admin-test-pw";
    public static final String REDIS_API_PW = "redis-api-test-pw";
    public static final String REDIS_COLLECTOR_PW = "redis-collector-test-pw";
    public static final String REDIS_AIS_PW = "redis-ais-test-pw";

    private static GenericContainer<?> redis;
    private static StringRedisTemplate admin;
    private static StringRedisTemplate collector;
    private static StringRedisTemplate apiUser;
    private static StringRedisTemplate ais;

    private ItStack() {}

    public static synchronized void start() {
        DbTestSupport.createMigratedDatabase(DB);
        if (redis != null) return;
        GenericContainer<?> c = new GenericContainer<>(DockerImageName.parse(REDIS_IMAGE))
                .withCopyFileToContainer(MountableFile.forHostPath(DbTestSupport.repoFile("infra/redis/start.sh")), "/etc/redis/start.sh")
                .withCopyFileToContainer(MountableFile.forHostPath(DbTestSupport.repoFile("infra/redis/redis.conf")), "/etc/redis/redis.conf")
                .withEnv("REDIS_PASSWORD", REDIS_ADMIN_PW)
                .withEnv("REDIS_API_PASSWORD", REDIS_API_PW)
                .withEnv("REDIS_COLLECTOR_PASSWORD", REDIS_COLLECTOR_PW)
                .withEnv("REDIS_AIS_PASSWORD", REDIS_AIS_PW)
                // compose: user "999:1000", entrypoint ["sh", "/etc/redis/start.sh"] (이미지 CMD 는 쓰지 않는다)
                .withCreateContainerCmdModifier(cmd -> cmd.withUser("999:1000").withEntrypoint("sh").withCmd("/etc/redis/start.sh"))
                .withExposedPorts(6379)
                .waitingFor(Wait.forLogMessage(".*Ready to accept connections.*\\n", 1).withStartupTimeout(Duration.ofSeconds(60)));
        c.start();
        redis = c;
        admin = template(null, REDIS_ADMIN_PW);
        collector = template("wakeline_collector", REDIS_COLLECTOR_PW);
        apiUser = template("wakeline_api", REDIS_API_PW);
        ais = template("wakeline_ais", REDIS_AIS_PW);
    }

    public static String redisHost() { start(); return redis.getHost(); }
    public static int redisPort() { start(); return redis.getMappedPort(6379); }

    /** 관리 사용자(default) — 검사·정리 전용(KEYS·DEL). 운영에서 api·collector 는 이 비밀번호를 모른다. */
    public static StringRedisTemplate admin() { start(); return admin; }

    /** 수집기와 같은 ACL 사용자 — 스트림 발행(XADD)은 이것으로 한다. */
    public static StringRedisTemplate collector() { start(); return collector; }

    /** ais 수집기와 같은 ACL 사용자(ADR-014) — 선박 스트림 발행(XADD wakeline:ships)·상태 해시(wakeline:ais:status)는 이것으로 한다. */
    public static StringRedisTemplate ais() { start(); return ais; }

    /** api 와 같은 ACL 사용자 — '이전 프로세스가 읽고 죽었다'(PEL 에 남김)를 흉내 낼 때 쓴다. */
    public static StringRedisTemplate apiUser() { start(); return apiUser; }

    /** 패턴에 맞는 키 삭제(관리 사용자 — KEYS 는 서비스 사용자에게 막혀 있다). */
    public static void deleteKeys(String pattern) {
        var keys = admin().keys(pattern);
        if (keys != null && !keys.isEmpty()) admin().delete(keys);
    }

    private static StringRedisTemplate template(String user, String pw) {
        var conf = new RedisStandaloneConfiguration(redis.getHost(), redis.getMappedPort(6379));
        if (user != null) conf.setUsername(user);
        conf.setPassword(pw);
        var f = new LettuceConnectionFactory(conf, LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(5)).build());
        f.afterPropertiesSet();
        f.start();
        return new StringRedisTemplate(f);
    }

    /** ACL WHOAMI — 이 연결이 어떤 ACL 사용자로 인증됐는가. */
    public static String whoami(StringRedisTemplate t) {
        return t.execute((org.springframework.data.redis.core.RedisCallback<String>) conn -> {
            Object r = conn.execute("ACL", "WHOAMI".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return r instanceof byte[] b ? new String(b, java.nio.charset.StandardCharsets.UTF_8) : String.valueOf(r);
        });
    }
}
