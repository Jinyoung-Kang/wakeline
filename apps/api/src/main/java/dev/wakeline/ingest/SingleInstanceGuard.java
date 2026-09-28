package dev.wakeline.ingest;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Profile;
import org.springframework.data.redis.connection.stream.StreamInfo;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * api 는 <b>단일 인스턴스</b>다(R-79). 두 개가 돌면 오류 없이 조용히 틀어진다:
 * <ul>
 *   <li>스트림 소비자 이름이 상수({@link StreamConsumer#CONSUMER} = api-1) — 두 프로세스가 한 PEL 을 나눠 읽고 서로의 미확인 메시지를 재처리한다.</li>
 *   <li>수요 임대(RedisDemandLeases)는 네 키를 지우고 '이 프로세스의' 수요만 다시 쓴다 — 서로 덮어써 집중 추적이 켜졌다 꺼졌다 한다.</li>
 *   <li>알림 id(AlertIds)는 프로세스 안에서만 단조 증가한다 — 충돌한다. 스냅샷·WS 세션·SIGMET 만료 판정도 프로세스 메모리에 있다.</li>
 * </ul>
 * compose 는 api 에 고정 IP 를 주어 {@code --scale api=2} 가 주소 충돌로 실패하지만, compose 밖(수동 실행·다른 네트워크)은 막지 못한다. 그래서:
 * <ul>
 *   <li>인스턴스 임대: Redis {@value #KEY} = 이 인스턴스 id(PX {@code ttl}, 5 s 마다 갱신). 프로세스가 죽으면 TTL 안에 풀린다.</li>
 *   <li>기동(fail fast): 다른 인스턴스가 쥐고 있으면 풀리기를 {@code startupWait}(죽은 이전 프로세스의 임대가 만료되는 시간보다 길게) 기다리고,
 *       그래도 살아 있으면 기동을 멈춘다. 스트림 소비·임대 작성보다 먼저 시작한다(낮은 SmartLifecycle phase).
 *       Redis 를 쓸 수 없으면 확인하지 못한 채 기동한다(WARN) — Redis 장애로 api 를 못 띄우게 하지 않는다. 갱신이 이어서 잡는다.</li>
 *   <li>실행 중: 갱신 때 다른 인스턴스가 쥐고 있으면 ERROR(1분에 한 번) + {@code wakeline_api_instance_conflict} = 1.</li>
 *   <li>그룹 {@value StreamConsumer#GROUP} 에 다른 이름의 소비자가 최근 활동했으면 WARN(30 s 주기) — 이름을 바꾼 두 번째 소비자.</li>
 *   <li>정상 종료: 자기 임대만 지운다 — 바로 다시 띄워도 기다리지 않는다.</li>
 * </ul>
 */
@Profile("!cli & !migrate")
@Component
public final class SingleInstanceGuard implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(SingleInstanceGuard.class);
    public static final String KEY = "wakeline:api:instance";
    /** 1 = 내 임대 연장, 2 = 비어 있어 새로 잡음, 0 = 다른 인스턴스가 쥐고 있음. */
    static final RedisScript<Long> ACQUIRE = RedisScript.of("""
            local cur = redis.call('GET', KEYS[1])
            if cur == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
            if not cur then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 2 end
            return 0""", Long.class);
    static final RedisScript<Long> RELEASE = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
            return 0""", Long.class);
    static final List<String> STREAMS = List.of(StreamConsumer.S_AIRCRAFT, StreamConsumer.S_SIGMET, StreamConsumer.S_RADAR, StreamConsumer.S_SHIPS);
    /** 이보다 최근에 활동한 다른 이름의 소비자를 '활성'으로 본다. */
    static final long FOREIGN_CONSUMER_IDLE_MS = 60_000;
    static final long LOG_INTERVAL_MS = 60_000;

    private final StringRedisTemplate redis;
    private final String instanceId;
    private final Duration ttl;
    private final Duration startupWait;
    private final Duration pollInterval;
    private volatile boolean running;
    private volatile boolean conflict;
    private volatile long conflictLoggedMs;

    @Autowired
    public SingleInstanceGuard(StringRedisTemplate redis, MeterRegistry meters) {
        this(redis, meters, defaultInstanceId(), Duration.ofSeconds(15), Duration.ofSeconds(20), Duration.ofSeconds(1));
    }

    SingleInstanceGuard(StringRedisTemplate redis, MeterRegistry meters, String instanceId, Duration ttl, Duration startupWait, Duration pollInterval) {
        this.redis = redis;
        this.instanceId = instanceId;
        this.ttl = ttl;
        this.startupWait = startupWait;
        this.pollInterval = pollInterval;
        Gauge.builder("wakeline_api_instance_conflict", this, g -> g.conflict ? 1 : 0)
                .description("다른 api 인스턴스가 인스턴스 임대를 쥐고 있음(1) — api 는 단일 인스턴스여야 한다").register(meters);
    }

    static String defaultInstanceId() {
        return System.getenv().getOrDefault("HOSTNAME", "local") + ":" + ProcessHandle.current().pid() + ":" + UUID.randomUUID().toString().substring(0, 8);
    }

    public String instanceId() { return instanceId; }

    boolean conflict() { return conflict; }

    private long acquire() {
        Long r = redis.execute(ACQUIRE, List.of(KEY), instanceId, String.valueOf(ttl.toMillis()));
        return r == null ? 0 : r;
    }

    /** 기동: 임대를 잡는다. 다른 인스턴스가 startupWait 동안 계속 쥐고 있으면 기동을 멈춘다. */
    @Override
    public void start() {
        long deadline = System.nanoTime() + startupWait.toNanos();
        while (true) {
            long r;
            try {
                r = acquire();
            } catch (RuntimeException e) {
                log.warn("single-instance check skipped — Redis unavailable (the lease is retried every 5 s): {}", e.toString());
                running = true;
                return;
            }
            if (r != 0) {
                running = true;
                log.info("api instance lease {} held by {}", KEY, instanceId);
                return;
            }
            if (System.nanoTime() >= deadline) {
                String holder;
                try { holder = redis.opsForValue().get(KEY); } catch (RuntimeException e) { holder = "?"; }
                conflict = true;
                throw new IllegalStateException("another api instance is running (" + KEY + " held by " + holder + "). The api must run as a single "
                        + "instance: stream consumer '" + StreamConsumer.CONSUMER + "', demand-lease writer and alert ids are per process");
            }
            try {
                Thread.sleep(pollInterval.toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("interrupted while waiting for the api instance lease", e);
            }
        }
    }

    /** 5 s 마다 임대를 연장한다(TTL 15 s). 다른 인스턴스가 쥐고 있으면 알린다(프로세스를 멈추지는 않는다). */
    @Scheduled(initialDelay = 5_000, fixedDelay = 5_000)
    public void renew() {
        if (!running) return;
        long r;
        try {
            r = acquire();
        } catch (RuntimeException e) {
            log.debug("instance lease renewal failed (Redis): {}", e.toString());
            return;
        }
        conflict = r == 0;
        if (conflict) {
            long now = System.currentTimeMillis();
            if (now - conflictLoggedMs >= LOG_INTERVAL_MS) {
                conflictLoggedMs = now;
                String holder;
                try { holder = redis.opsForValue().get(KEY); } catch (RuntimeException e) { holder = "?"; }
                log.error("another api instance holds {} ({}; this instance {}) — two api processes consume the same streams and overwrite "
                        + "demand leases; stop one of them", KEY, holder, instanceId);
            }
        }
    }

    /** 그룹 api 에서 최근 활동한, 이 프로세스가 쓰지 않는 이름의 소비자(스트림/이름). */
    List<String> foreignConsumers() {
        List<String> out = new ArrayList<>();
        for (String s : STREAMS) {
            StreamInfo.XInfoConsumers cs;
            try {
                cs = redis.opsForStream().consumers(s, StreamConsumer.GROUP);
            } catch (RuntimeException e) { // 스트림·그룹이 아직 없음(NOGROUP) 또는 Redis 장애
                continue;
            }
            if (cs == null) continue;
            for (StreamInfo.XInfoConsumer c : cs)
                if (!StreamConsumer.CONSUMER.equals(c.consumerName()) && c.idleTimeMs() < FOREIGN_CONSUMER_IDLE_MS) out.add(s + "/" + c.consumerName());
        }
        return out;
    }

    @Scheduled(initialDelay = 20_000, fixedDelay = 30_000)
    public void checkForeignConsumers() {
        List<String> foreign = foreignConsumers();
        if (!foreign.isEmpty())
            log.warn("other consumers are active in stream group '{}': {} — the api is single-instance (consumer '{}')", StreamConsumer.GROUP, foreign,
                    StreamConsumer.CONSUMER);
    }

    /** 정상 종료: 자기 임대만 지운다(스트림 소비가 멈춘 뒤 — 더 낮은 phase 라 나중에 멈춘다). */
    @Override
    public void stop() {
        if (!running) return;
        running = false;
        try {
            redis.execute(RELEASE, List.of(KEY), instanceId);
        } catch (RuntimeException e) {
            log.debug("instance lease release failed (expires by itself): {}", e.toString());
        }
    }

    @Override
    public boolean isRunning() { return running; }

    /** 스트림 소비자(MAX-10)·WS 허브(MAX-100)·선박 팬아웃(MAX-150)보다 먼저 시작하고 나중에 멈춘다. */
    @Override
    public int getPhase() { return Integer.MAX_VALUE - 200; }
}
