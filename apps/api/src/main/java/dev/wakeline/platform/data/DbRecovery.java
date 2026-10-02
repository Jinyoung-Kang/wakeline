package dev.wakeline.platform.data;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;

/**
 * DB 회복 신호(ADR-032 개정 · QA 2026-10 신뢰성 개선 제안 5) — 저장기(항적 · 선박 · 순서 쓰기)가 일시 장애로 백오프(1–2 s → 30 s)에 쉬는 동안 DB 가
 * 다시 답하면 곧바로 깨운다. 예전에는 쉼을 끝까지 기다려 DB 가 돌아온 뒤 첫 쓰기까지 최대 30 s 였다(QA db-pause-60 'retry in 30000 ms' · ADR-032 재검증
 * db-pause-75 에서 writer_backlog 가 풀리기까지 22 s · DbPausedWriterRecoveryIT 14.7 s).
 * <ul>
 *   <li>확인: 쉬는 저장기가 있는 동안만, {@value #PROBE_INTERVAL_MS} ms 마다 한 번(동시에 하나 — 뒤 스레드) 공유 풀로 SELECT 1. 쉬는 저장기가 없으면 보내지 않는다.</li>
 *   <li>깨우기: 확인이 '답하지 않음 → 답함'으로 바뀐 것을 본 때만(그 바뀜이 쉬기 시작한 뒤라면). DB 가 내내 답하는 일시 오류(잠금 대기 한도 55P03 등)는
 *       깨우지 않는다 — 확인이 늘 성공해 바뀜이 없으므로 백오프가 그대로 지켜진다(뜨거운 재시도 고리가 되지 않는다).</li>
 *   <li>백오프 자체는 그대로다: DB 가 없는 동안 실패한 쓰기(배치 · 작업)를 되풀이하지 않고, 짧은 확인 하나만 보낸다.</li>
 * </ul>
 * 지표 wakeline_db_recovery_total(답하지 않음 → 답함을 본 횟수), INFO 한 줄(바뀜마다).
 */
@Component
public class DbRecovery {
    private static final Logger log = LoggerFactory.getLogger(DbRecovery.class);
    /** 쉬는 저장기가 있는 동안의 확인 간격. */
    public static final long PROBE_INTERVAL_MS = 2_000;
    /** 쉼을 나눠 자는 단위(확인 결과 · 종료를 이만큼 늦게 본다). */
    static final long SLICE_MS = 50;

    /** DB 에 짧은 문장 하나(답하지 않으면 던진다). */
    @FunctionalInterface
    public interface Probe { void probe(); }

    private final Probe probe;
    private final long intervalMs;
    private final Executor prober;
    private final Counter recovered;
    private final AtomicBoolean probing = new AtomicBoolean();
    private volatile long lastProbeStartMs = Long.MIN_VALUE / 2;
    /** 마지막 확인이 답하지 않았다(아직 답함을 보지 못했다). */
    private volatile boolean down;
    /**
     * '답하지 않음 → 답함'을 본 확인이 끝난 시각(epoch ms), 없으면 Long.MIN_VALUE. 끝난 시각으로 견준다: 쉬기 직전에 시작해 쉬는 동안 끝난 확인도 그 저장기를
     * 깨운다(시작 시각으로 견주면 그 저장기는 다음 확인들이 늘 성공해 바뀜이 없으므로 쉼을 끝까지 잤다).
     */
    private volatile long recoveredAtMs = Long.MIN_VALUE;

    @org.springframework.beans.factory.annotation.Autowired
    public DbRecovery(JdbcTemplate jdbc, MeterRegistry meters) {
        this(() -> jdbc.queryForObject("SELECT 1", Integer.class), PROBE_INTERVAL_MS,
                r -> Thread.ofVirtual().name("db-recovery-probe").start(r), meters);
    }

    /** 시험용: 확인 · 간격 · 확인을 돌릴 실행기를 바꿔 쓴다. */
    public DbRecovery(Probe probe, long intervalMs, Executor prober, MeterRegistry meters) {
        this.probe = probe;
        this.intervalMs = intervalMs;
        this.prober = prober;
        this.recovered = Counter.builder("wakeline_db_recovery_total")
                .description("백오프로 쉬는 저장기를 위해 확인하다 DB 가 다시 답하는 것을 본 횟수(답하지 않음 → 답함)").register(meters);
    }

    /** 확인 없이 그냥 쉬는 것(시험 생성자 · DB 가 없는 저장기 시험). */
    public static DbRecovery none() {
        return new DbRecovery(() -> { }, Long.MAX_VALUE / 4, r -> { }, new io.micrometer.core.instrument.simple.SimpleMeterRegistry());
    }

    /**
     * 백오프로 쉰다: ms 가 지나거나, 쉬기 시작한 뒤 확인이 DB 의 회복(답하지 않음 → 답함)을 보거나, running 이 false 가 될 때까지.
     * @return 회복을 보고 일찍 깼으면 true
     */
    public boolean pause(long ms, BooleanSupplier running) {
        long start = System.currentTimeMillis(), until = start + ms;
        while (running.getAsBoolean()) {
            long now = System.currentTimeMillis();
            if (recoveredAtMs >= start) return true;
            if (now >= until) return false;
            maybeProbe(now);
            try {
                Thread.sleep(Math.max(1, Math.min(SLICE_MS, until - now)));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    private void maybeProbe(long now) {
        if (now - lastProbeStartMs < intervalMs || !probing.compareAndSet(false, true)) return;
        lastProbeStartMs = now;
        try {
            prober.execute(this::runProbe);
        } catch (RuntimeException e) { // 실행기가 받지 않음 — 다음 쉼 조각에서 다시
            probing.set(false);
        }
    }

    private void runProbe() {
        try {
            probe.probe();
            if (down) {
                down = false;
                recoveredAtMs = System.currentTimeMillis();
                recovered.increment();
                log.info("database answers again — waking writers in backoff");
            }
        } catch (RuntimeException e) {
            down = true;
            log.debug("database recovery probe failed: {}", e.toString());
        } finally {
            probing.set(false);
        }
    }
}
