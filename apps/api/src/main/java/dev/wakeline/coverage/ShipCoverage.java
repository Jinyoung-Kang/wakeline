package dev.wakeline.coverage;

import dev.wakeline.domain.ShipState;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.persist.ShipRepository;
import dev.wakeline.persist.ShipWriter;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.net.SocketTimeoutException;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * 관측 AIS 수신 범위(ADR-027 · 계약 v5 §G27 — GET /api/v1/ships/coverage): '선박 위치가 실제로 어디서 왔는가'를 0.5° 칸 · 최근 24 h 로 센다.
 * 구독 범위(운영 설정)와 다르다 — aisstream.io 는 육상 수신국이 받은 것만 보내므로(ADR-014) 구독해도 수신국이 없는 해역은 비어 있다.
 * <ul>
 *   <li><b>실시간 셈</b>: 선박 저장기가 고른 위치({@link IngestEvents.ShipsSampled} — MMSI 별 60 s 창의 첫 보고, ship_position 과 같은 표본)를 격자에 넣는다.
 *       셈 시작(live_from) = api 시작 시각을 60 s 창의 시작으로 내린 것 — 그 앞의 보고(재시작 때 밀린 백로그)는 세지 않는다(DB 부트스트랩의 몫 — 두 번 세지
 *       않는다). 단 부트스트랩이 그 시를 <b>다 읽은 뒤</b> 도착한 셈 시작 앞 보고는 실시간으로 센다 — 저장기는 알린 뒤에 큐에 넣으므로 그 행은 그 읽기에 없었다
 *       (리뷰 2026-09-30 밤 — 전에는 어디서도 세지 않았다). 그래서 api 시작 분(≤ 60 s)에 앞선 프로세스만 받은 보고 · 그 시를 읽는 동안 도착한 보고는 빠질 수 있다
 *       (적게 셀 수는 있어도 두 번 세지 않는다 — 지표 ignored_total{reason=during_read}). 5분 넘게 미래인 보고는 세지 않는다.</li>
 *   <li><b>부트스트랩</b>(기동 때 한 번, 요청 경로 밖 가상 스레드): api 시작 {@code wakeline.ship-coverage.bootstrap-grace-ms}(기본 30 s — 고른 값) 뒤, 그리고
 *       스트림의 밀린 보고가 저장된 뒤({@link #backlogWritten} — 셈 시작 앞 보고가 {@value #BACKLOG_QUIET_MS} ms 동안 오지 않았고 그때까지 저장기 큐에 넣은 행이 모두
 *       끝났다, 상한 grace + {@value #BACKLOG_WAIT_MAX_MS} ms — 둘 다 고른 값. 리뷰 2026-09-30 밤: 전에는 기동 30 s 에 고정이라 긴 정지 뒤 백로그를 쓰는 데
 *       30 s 넘게 걸리면 그 시를 읽은 뒤에 저장된 행을 어디서도 세지 않았다), 창 안의 ship_position 을 셈 시작 앞까지 <b>가장 최근 시부터 거꾸로</b> 시 하나에 문장 하나로 읽는다({@link JdbcCoverageSource} — 연결 하나 ·
 *       읽기 전용 · 문장 · 소켓 · 연결 상한, 공유 풀 · 선택 조회 풀을 쓰지 않는다 — ADR-025 의 격벽 · 한 번에 문장 하나).
 *       <b>못 읽은 시는 나중에 다시 읽는다</b>(2026-09-30 22:49 KST 배포 직후 — 재시작 직후의 DB 경합에서 여섯째 시가 문장 상한을 넘자 부트스트랩이 멈췄고 다음 재시작까지
 *       레이어가 일부만 셌다): 시간 초과 · 일시적 실패인 시는 빈 시로 두고 나머지 시를 이어 읽은 뒤, 한 차례가 끝나고 {@link #RETRY_BACKOFF_MS}(1 · 2 · 5 · 10분 — 고른 값)
 *       뒤에 빈 시만 다시 읽는다. 네 번 다시 읽고도 못 읽은 시 · 일시적이지 않은 실패(권한 · 형식 — {@link #retryable})인 시는 포기하고 까닭과 함께 밝힌다(다음
 *       재시작 전까지 빈 시). 한 차례의 마감 {@value #BOOTSTRAP_DEADLINE_MS} ms(고른 값) — 넘으면 남은 시를 조회하지 않고 다음 차례로 미룬다(까닭 deadline —
 *       못 읽은 횟수 attempts 에 세지 않는다). 다시 읽는 차례는 <b>적게 조회한 시부터</b>(마감으로 미룬 시가 먼저, 같으면 최근 시부터 — 리뷰 2026-10-01: 늘 느린 최근 시가
 *       차례마다 마감을 다 써서 뒤의 시를 한 번도 조회하지 못한 채 '다섯 번 못 읽음'으로 포기했다). 차례마다 적어도 한 시는 조회하고 문장은 상한 안에 끝나므로 뒤로 밀린
 *       시도 곧 차례가 온다 — 끝내 조회하지 못한 시는 'deadline · 0번'으로 포기한다. 기다리는 동안 연결을
 *       잡지 않는다(차례마다 열고 닫는다). 기다리는 사이 창 밖으로 나간 빈 시는 더 읽지 않는다(읽을 시 수 hours_total 에서 뺀다).
 *       응답은 셈 시작부터 빈 시 없이 이어진 부분만 '덮음'으로 밝히고(since) 빈 시를 하나씩 싣는다(missing — 다시 읽기 대기 · 포기, 차례 수 · 종류) — 창 전체인 척하지 않는다.</li>
 *   <li><b>응답</b>: since = 이 시각부터 창 끝까지 빠짐없이 셌다(창의 시작 · 부트스트랩이 이어 읽은 가장 오래된 시 · 셈 시작 중 늦은 것),
 *       covered = full(since = 창의 시작) · partial(부트스트랩이 일부만) · since_api_start(부트스트랩 전 · 실패). 스냅숏은 {@value #SNAPSHOT_MS} ms 마다 새로 만든다.</li>
 *   <li><b>메모리</b>: 칸 {@value #MAX_CELLS} · 칸별 선박 {@value #MAX_SHIP_CELLS} 상한(고른 값 — 계산한 바이트 상한 {@link CoverageGrid#memoryBoundBytes}).
 *       넘친 보고는 세지 않고 센다(응답 dropped_positions · 지표 · 시마다 WARN 한 번).</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class ShipCoverage implements SmartLifecycle {
    private static final Logger log = LoggerFactory.getLogger(ShipCoverage.class);
    public static final int MAX_CELLS = 16_000;
    public static final int MAX_SHIP_CELLS = 200_000;
    public static final long SNAPSHOT_MS = 60_000;
    /** 이보다 미래인 보고는 세지 않는다(ShipStore · ShipWriter 와 같은 5분). */
    public static final long FUTURE_SKEW_MS = 5 * 60_000L;
    /** 셈 시작을 내리는 단위 = 저장 표본의 창(60 s). */
    public static final long LIVE_ALIGN_MS = ShipRepository.WINDOW_S * 1000;
    public static final long DEFAULT_BOOTSTRAP_GRACE_MS = 30_000;
    /** 한 차례(첫 읽기 · 다시 읽기 한 번)의 마감(고른 값) — 넘으면 그 차례의 남은 시를 다음 차례로 미룬다(까닭 deadline). 문장 하나는 제 상한 안에 끝난다. */
    public static final long BOOTSTRAP_DEADLINE_MS = 180_000;
    /**
     * 못 읽은 시를 다시 읽기 전 기다림(고른 값 — 잰 값 아님): 한 차례가 끝난 뒤 1 · 2 · 5 · 10분. 근거: 2026-09-30 22:49 KST 배포 직후의 시간 초과는 재시작 직후의
     * DB 경합(스트림 백로그 쓰기 · 기동 작업 — 같은 때 재생 요청도 3 s 상한에 걸렸다)이었고 같은 한 시 문장은 한가한 DB 에서 0.44 s 였다 — 그런 경합은 몇 분이면 지나간다.
     * 첫 읽기 뒤 약 18분(+ 읽는 시간)까지 못 읽은 시는 포기하고 그렇다고 밝힌다(다음 재시작 전까지 빈 시 — 멈추지 않고 DB 를 끝없이 두드리지도 않는다).
     */
    public static final List<Long> RETRY_BACKOFF_MS = List.of(60_000L, 120_000L, 300_000L, 600_000L);
    /** 셈 시작 앞 보고가 이만큼 오지 않으면 스트림 백로그를 다 읽었다고 본다(고른 값 — 스트림 소비는 빈 읽기에서 2 s 막힌다: 그 다섯 번). */
    public static final long BACKLOG_QUIET_MS = 10_000;
    /** 백로그가 저장되기를 grace 뒤 이만큼까지만 기다린다(고른 값 — 넘으면 WARN 한 줄과 함께 읽는다: 그 뒤 저장된 행은 그 시를 읽은 뒤면 실시간으로 센다). */
    public static final long BACKLOG_WAIT_MAX_MS = 300_000;
    /** 한 번에 격자에 넣는 부트스트랩 행 수(잠금을 오래 잡지 않게). */
    static final int MERGE_BATCH = 5_000;

    /**
     * 부트스트랩 상태. loadedFrom = 셈 시작부터 거꾸로 빈 시 없이 이어 읽은 가장 오래된 순간(읽은 것이 없으면 셈 시작). hoursTotal = 읽을 시 조각 수(읽기 전에 창 밖으로
     * 나간 시는 뺀다). missing = 창 안의 못 읽은 시(오래된 것부터 — 다시 읽기 대기 · 포기). nextRetryAt = 다시 읽기를 기다리는 시의 다음 차례 시각(첫 차례가 도는
     * 동안은 아직 없다 — 그 차례가 끝난 뒤 정한다. 다시 읽는 차례가 도는 동안은 지난 시각) · nextRetry = 그 차례가 몇 번째 다시 읽기인지(1 ~ {@link #RETRY_BACKOFF_MS} 의
     * 길이 — nextRetryAt 과 함께만).
     */
    public record Bootstrap(String state, int hoursLoaded, int hoursTotal, long rows, Instant loadedFrom, String error, Instant finishedAt,
                            List<Missing> missing, Instant nextRetryAt, Integer nextRetry) {
        /** 창 안의 빈 시만(창 밖으로 나간 시는 더 말하지 않는다) — 다시 읽기를 기다리는 시가 남지 않으면 다음 시각도 없다. */
        Bootstrap inWindow(long windowFromMs) {
            if (missing.stream().allMatch(m -> m.to().toEpochMilli() > windowFromMs)) return this;
            List<Missing> in = missing.stream().filter(m -> m.to().toEpochMilli() > windowFromMs).toList();
            boolean waiting = in.stream().anyMatch(m -> Missing.RETRY.equals(m.state()));
            return new Bootstrap(state, hoursLoaded, hoursTotal, rows, loadedFrom, error, finishedAt, in, waiting ? nextRetryAt : null, waiting ? nextRetry : null);
        }
    }

    /**
     * 못 읽은 시 조각 하나: [from, to) · state(retry = 다시 읽기 대기 · given_up = 포기) · attempts = 이 시를 읽으려다 실패한 차례 수(보낸 문장이 실패 · 그 차례의 연결을
     * 열지 못함 — 차례 마감으로 조회하지 않고 미룬 차례는 세지 않는다) · error = 마지막 실패의 종류(서버 글자 없음). attempts 0 = 한 번도 조회하지 않았다: error 는
     * deadline(차례 마감으로 미룸) 또는 stopped(종료). 한 번 넘게 못 읽은 뒤 마감으로 미룬 시는 제 실패 종류를 그대로 둔다.
     */
    public record Missing(Instant from, Instant to, String state, int attempts, String error) {
        public static final String RETRY = "retry";
        public static final String GIVEN_UP = "given_up";
    }

    /** 다시 읽기 전 기다림(시험은 가짜 시계를 옮긴다). 운영은 Thread.sleep — 종료(stop)가 가상 스레드를 깨우면 InterruptedException. */
    interface Sleeper {
        void sleep(long ms) throws InterruptedException;
    }

    /**
     * 선박 저장기(ShipWriter)의 진행: 큐에 넣은 마지막 행 번호 · 끝난(쓰기 · 영구 실패 · 넘쳐 버림) 행 번호 — 번호 순서로 끝난다. 부트스트랩이 밀린 행이 모두
     * 저장된 뒤에 읽게 한다({@link #backlogWritten}).
     */
    public interface WriterProgress {
        long enqueued();

        long settled();

        /** 저장기가 없다(시험) — 늘 다 썼다. */
        WriterProgress NONE = new WriterProgress() {
            @Override public long enqueued() { return 0; }

            @Override public long settled() { return 0; }
        };
    }

    /** 응답 한 벌(불변). */
    public record Snapshot(String etag, Instant generatedAt, Instant windowFrom, Instant since, String covered, Instant apiStartedAt, Instant liveFrom,
                           Bootstrap bootstrap, List<CoverageGrid.CellView> cells, long positions, long dropped, int maxCells, int maxShipCells,
                           String provider, Instant newestSeen) {}

    private final CoverageSource source;
    private final WriterProgress writer;
    private final LongSupplier clock;
    private final long startMs;
    private final long liveFromMs;
    private final long graceMs;
    private final int maxCells;
    private final int maxShipCells;
    private final Object lock = new Object();
    private final CoverageGrid grid;
    private final Object snapLock = new Object();
    private volatile Snapshot snapshot;
    private long snapshotSeq;
    private volatile Bootstrap bootstrap;
    private volatile String provider;
    private volatile int cellsGauge;
    private volatile int shipCellsGauge;
    private long lastCapWarnHour = Long.MIN_VALUE;
    private final Counter droppedCells;
    private final Counter droppedShipCells;
    private final Counter ignoredEarly;
    private final Counter ignoredFuture;
    private final Counter ignoredMmsi;
    private final Counter ignoredDuringRead;
    private final Counter lateCounted;
    private final Counter bootstrapRows;
    /** 셈 시작 앞 보고가 마지막으로 온 때(clock, 없으면 −1) · 백로그 저장을 기다릴 큐 번호(−1 = 아직 조용하지 않다) · 기다림 상한을 넘겨 알렸다. */
    private volatile long lastEarlyAtMs = -1;
    private long gateMark = -1;
    private boolean gateForced;
    /**
     * 부트스트랩의 시 조각(가장 최근 → 오래된 순 — 조각 i 는 에포크 시 newestHour − i 안에 있다)과 조각마다 상태 · 읽지 못한 차례 수 · 마지막 실패 종류.
     * 실시간 셈이 셈 시작 앞 보고를 어디에 맡길지 이 상태로 정한다(읽음 → 실시간으로 센다 · 읽는 중 → during_read · 그 밖 → 부트스트랩의 몫). 잠금(lock) 안에서만.
     */
    private static final byte UNREAD = 0, READING = 1, READ = 2, GIVEN_UP = 3, EXPIRED = 4;
    private final long newestHour;
    private long[] chunkFrom = new long[0];
    private long[] chunkTo = new long[0];
    private byte[] chunkState = new byte[0];
    private int[] chunkFails = new int[0];
    private String[] chunkError = new String[0];
    /** 다시 읽기 전 기다림(시험 창구). */
    volatile Sleeper sleeper = Thread::sleep;
    /** 시험 창구: 스냅숏이 부트스트랩 상태를 읽은 뒤 · 격자를 복사하기 전(둘의 순서를 결정적으로 시험한다). */
    volatile Runnable beforeGridCopy = () -> {};
    private volatile boolean running;
    /** stop() 이 불렸다 — 부트스트랩은 다음 시 조각 앞에서 멈춘다(부르는 스레드에서 직접 돌린 부트스트랩은 멈추지 않는다). */
    private volatile boolean stopRequested;
    private volatile Thread worker;

    @Autowired
    public ShipCoverage(JdbcCoverageSource source, ShipWriter shipWriter, MeterRegistry meters,
                        @Value("${wakeline.ship-coverage.bootstrap-grace-ms:" + DEFAULT_BOOTSTRAP_GRACE_MS + "}") long graceMs) {
        this(source, System::currentTimeMillis, meters, graceMs, MAX_CELLS, MAX_SHIP_CELLS, System.currentTimeMillis(), new WriterProgress() {
            @Override public long enqueued() { return shipWriter.enqueuedSeq(); }

            @Override public long settled() { return shipWriter.settledSeq(); }
        });
    }

    ShipCoverage(CoverageSource source, LongSupplier clock, MeterRegistry meters, long graceMs, int maxCells, int maxShipCells) {
        this(source, clock, meters, graceMs, maxCells, maxShipCells, clock.getAsLong());
    }

    ShipCoverage(CoverageSource source, LongSupplier clock, MeterRegistry meters, long graceMs, int maxCells, int maxShipCells, long startMs) {
        this(source, clock, meters, graceMs, maxCells, maxShipCells, startMs, WriterProgress.NONE);
    }

    ShipCoverage(CoverageSource source, LongSupplier clock, MeterRegistry meters, long graceMs, int maxCells, int maxShipCells, long startMs,
                 WriterProgress writer) {
        if (graceMs < 0) throw new IllegalStateException("wakeline.ship-coverage.bootstrap-grace-ms must be >= 0, got " + graceMs);
        this.source = source;
        this.writer = writer;
        this.clock = clock;
        this.graceMs = graceMs;
        this.maxCells = maxCells;
        this.maxShipCells = maxShipCells;
        this.startMs = startMs;
        this.liveFromMs = Math.floorDiv(startMs, LIVE_ALIGN_MS) * LIVE_ALIGN_MS;
        this.newestHour = Math.floorDiv(liveFromMs - 1, CoverageGrid.HOUR_MS);
        this.grid = new CoverageGrid(maxCells, maxShipCells, clock.getAsLong());
        this.bootstrap = new Bootstrap("pending", 0, 0, 0, Instant.ofEpochMilli(liveFromMs), null, null, List.of(), null, null);
        Gauge.builder("wakeline_ship_coverage_cells", this, c -> c.cellsGauge).description("관측 수신 격자의 칸 수(0.5°, 최근 24 h)").register(meters);
        Gauge.builder("wakeline_ship_coverage_ship_cells", this, c -> c.shipCellsGauge).description("관측 수신 격자의 칸별 선박 항목 수").register(meters);
        droppedCells = Counter.builder("wakeline_ship_coverage_dropped_total").tag("reason", "cells").description("칸 상한 때문에 세지 못한 위치").register(meters);
        droppedShipCells = Counter.builder("wakeline_ship_coverage_dropped_total").tag("reason", "ship_cells")
                .description("칸별 선박 상한 때문에 세지 못한 위치").register(meters);
        ignoredEarly = Counter.builder("wakeline_ship_coverage_ignored_total").tag("reason", "before_live")
                .description("셈 시작 앞의 보고(부트스트랩의 몫)").register(meters);
        ignoredFuture = Counter.builder("wakeline_ship_coverage_ignored_total").tag("reason", "future").description("5분 넘게 미래인 보고").register(meters);
        ignoredMmsi = Counter.builder("wakeline_ship_coverage_ignored_total").tag("reason", "mmsi").description("MMSI 가 9자리 숫자가 아닌 보고").register(meters);
        ignoredDuringRead = Counter.builder("wakeline_ship_coverage_ignored_total").tag("reason", "during_read")
                .description("부트스트랩이 그 시를 읽는 동안 도착한 셈 시작 앞 보고(그 읽기에 없었을 수 있다 — 세지 못했을 수 있다)").register(meters);
        lateCounted = Counter.builder("wakeline_ship_coverage_late_counted_total")
                .description("부트스트랩이 그 시를 다 읽은 뒤 도착한 셈 시작 앞 보고 — 실시간으로 셌다").register(meters);
        bootstrapRows = Counter.builder("wakeline_ship_coverage_bootstrap_rows_total").description("부트스트랩이 읽은 칸 · MMSI 행").register(meters);
    }

    public long liveFromMs() { return liveFromMs; }

    /** 지금 부트스트랩 상태(시험). */
    Bootstrap bootstrapState() { return bootstrap; }

    // ---- 실시간 셈 ----

    @EventListener
    public void onSampled(IngestEvents.ShipsSampled e) {
        long now = clock.getAsLong();
        boolean early = false;
        synchronized (lock) {
            grid.roll(now);
            for (ShipState s : e.positions()) {
                long t = s.seenAt().toEpochMilli();
                if (t < liveFromMs) {
                    early = true;
                    // 부트스트랩이 아직 읽지 않은 시(다시 읽기 대기 · 포기 포함) — 그 몫(저장기가 곧 쓴다 — 다시 읽으면 그 행도 읽는다). 읽는 중인 시 — 그 읽기에 없었을 수
                    // 있다(세지 못했을 수 있다고 센다)
                    byte st = chunkStateAt(t);
                    if (st != READ) { (st == READING ? ignoredDuringRead : ignoredEarly).increment(); continue; }
                }
                if (t > now + FUTURE_SKEW_MS) { ignoredFuture.increment(); continue; }
                int mmsi = mmsi(s.mmsi());
                if (mmsi < 0) { ignoredMmsi.increment(); continue; }
                // 셈 시작 앞인데 여기까지 왔으면 부트스트랩이 그 시를 다 읽은 뒤다 — 저장기는 알린 뒤에 큐에 넣으므로 이 행은 그 읽기에 없었다(두 번 세지 않는다)
                CoverageGrid.Result r = grid.add(mmsi, s.lat(), s.lon(), t);
                count(r);
                if (t < liveFromMs && r == CoverageGrid.Result.ADDED) lateCounted.increment();
                provider = s.provider();
            }
            gauges();
        }
        if (early) lastEarlyAtMs = now;
    }

    /**
     * 부트스트랩을 시작해도 되는가(grace 뒤 가상 스레드가 1 s 마다 부른다 — 시험은 직접): 셈 시작 앞 보고(스트림 백로그)가 {@value #BACKLOG_QUIET_MS} ms 동안
     * 오지 않았고, 그 뒤 처음 본 때까지 저장기 큐에 넣은 행이 모두 끝났다(쓰기 · 영구 실패 · 넘쳐 버림). grace + {@value #BACKLOG_WAIT_MAX_MS} ms 가 지나면
     * WARN 한 줄과 함께 시작한다(저장이 막혔거나 오래된 보고가 끝없이 오는 경우 — 그 뒤 도착한 보고는 그 시를 읽은 뒤면 실시간으로 센다).
     */
    synchronized boolean backlogWritten(long now) {
        if (now - startMs >= graceMs + BACKLOG_WAIT_MAX_MS) {
            if (!gateForced) {
                gateForced = true;
                log.warn("ship coverage bootstrap: the stream backlog before {} was still being written {} ms after start (queue {} / {}) — reading anyway; "
                        + "positions written after their hour is read are counted live", Instant.ofEpochMilli(liveFromMs), now - startMs,
                        writer.settled(), writer.enqueued());
            }
            return true;
        }
        long early = lastEarlyAtMs;
        if (early >= 0 && now - early < BACKLOG_QUIET_MS) { gateMark = -1; return false; }
        if (gateMark < 0) gateMark = writer.enqueued();
        return writer.settled() >= gateMark;
    }

    /** 셈 시작 앞 순간 t 가 든 시 조각의 상태(잠금 안에서). 계획에 없는 시(부트스트랩 전 · 창보다 오래됨)는 UNREAD. */
    private byte chunkStateAt(long t) {
        long i = newestHour - Math.floorDiv(t, CoverageGrid.HOUR_MS);
        return i >= 0 && i < chunkState.length ? chunkState[(int) i] : UNREAD;
    }

    static int mmsi(String m) {
        if (m == null || m.length() != 9) return -1;
        for (int i = 0; i < 9; i++) if (m.charAt(i) < '0' || m.charAt(i) > '9') return -1;
        return Integer.parseInt(m);
    }

    /** 잠금 안에서. */
    private void count(CoverageGrid.Result r) {
        switch (r) {
            case DROPPED_CELLS -> { droppedCells.increment(); warnCap(); }
            case DROPPED_SHIP_CELLS -> { droppedShipCells.increment(); warnCap(); }
            default -> { }
        }
    }

    private void warnCap() {
        if (grid.currentHour() == lastCapWarnHour) return;
        lastCapWarnHour = grid.currentHour();
        log.warn("ship coverage: memory cap reached (cells {} / {}, ship-cells {} / {}) — new cells or ships are not counted this hour; "
                + "see wakeline_ship_coverage_dropped_total", grid.cellCount(), maxCells, grid.shipCells(), maxShipCells);
    }

    private void gauges() {
        cellsGauge = grid.cellCount();
        shipCellsGauge = grid.shipCells();
    }

    // ---- 부트스트랩 ----

    /**
     * 창 안의 저장된 위치를 셈 시작 앞까지 가장 최근 시부터 거꾸로 읽는다(부르는 스레드에서 — 운영은 {@link #start} 의 가상 스레드). 한 번만 의미가 있다.
     * 첫 차례는 모든 시를(가장 최근 시부터), 그 뒤 차례는 못 읽은 시(다시 읽기 대기)만 적게 조회한 시부터({@link #pending}) — 차례 사이에 {@link #RETRY_BACKOFF_MS}
     * 만큼 기다린다(연결은 닫혀 있다). 첫 차례 + 다시 읽기 {@link #RETRY_BACKOFF_MS} 의 길이만큼 — 그 뒤 남은 시는 포기한다.
     */
    void runBootstrap() {
        long t0 = clock.getAsLong();
        List<long[]> plan = new ArrayList<>();
        long hourStart = Math.floorDiv(liveFromMs, CoverageGrid.HOUR_MS) * CoverageGrid.HOUR_MS;
        if (hourStart < liveFromMs) plan.add(new long[]{hourStart, liveFromMs});
        long windowFrom;
        synchronized (lock) {
            grid.roll(t0);
            windowFrom = grid.windowFromMs();
        }
        for (long from = hourStart - CoverageGrid.HOUR_MS; from >= windowFrom; from -= CoverageGrid.HOUR_MS) plan.add(new long[]{from, from + CoverageGrid.HOUR_MS});
        int total = plan.size();
        synchronized (lock) {
            chunkFrom = new long[total];
            chunkTo = new long[total];
            chunkState = new byte[total];
            chunkFails = new int[total];
            chunkError = new String[total];
            for (int i = 0; i < total; i++) {
                chunkFrom[i] = plan.get(i)[0];
                chunkTo[i] = plan.get(i)[1];
            }
        }
        Run run = new Run();
        publish(run, "running", null, null);
        log.info("ship coverage bootstrap: reading {} hours of ship_position before {} (live counting since then)", total, Instant.ofEpochMilli(liveFromMs));
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < total; i++) order.add(i);
        boolean stopped;
        int retries = 0;
        while (true) {
            stopped = pass(order, run);
            if (stopped) break;
            order = pending();
            if (order.isEmpty()) break;
            if (retries == RETRY_BACKOFF_MS.size()) {
                giveUp(order);
                break;
            }
            long waitMs = RETRY_BACKOFF_MS.get(retries);
            long due = clock.getAsLong() + waitMs;
            run.nextRetryAt = Instant.ofEpochMilli(due);
            run.nextRetry = retries + 1;
            Bootstrap b = publish(run, "running", null, null);
            // 차례마다 한 줄(많아야 네 번) — 어느 시를 셌고 몇 시가 빠졌는지, 언제 다시 읽는지
            log.warn("ship coverage bootstrap: {}/{} hours read, {} not read ({}) — retrying them in {} s (retry {}/{}); counted since {}",
                    run.loaded, b.hoursTotal(), order.size(), run.passKinds(), waitMs / 1000, retries + 1, RETRY_BACKOFF_MS.size(), b.loadedFrom());
            retries++;
            if (!sleepUntil(due)) { stopped = true; break; }
        }
        finish(run, stopped, retries, t0);
    }

    /** 부트스트랩 한 번의 셈(부트스트랩 스레드만 쓴다). */
    private static final class Run {
        int loaded;
        long rows;
        Instant nextRetryAt;
        int nextRetry;
        /** 이 차례의 실패 종류별 수 · 마지막 실패의 예외 이름(로그 — 서버 글자는 싣지 않는다). */
        final Map<String, Integer> kinds = new LinkedHashMap<>();
        String cause;

        String passKinds() {
            StringBuilder b = new StringBuilder();
            kinds.forEach((k, n) -> b.append(b.isEmpty() ? "" : ", ").append(k).append(" x").append(n));
            if (cause != null) b.append(": ").append(cause);
            return b.toString();
        }
    }

    /**
     * 한 차례: order 의 조각을 차례로 읽는다. 연결은 이 차례에만(끝나면 닫는다 — 다시 읽기를 기다리는 동안 잡지 않는다). 문장 상한이 아닌 실패 뒤에는 다음 시를 새
     * 연결로 읽는다(연결이 끊겼을 수 있다). 연결을 열지 못하면 남은 시를 모두 다음 차례로 미룬다. 종료가 요청되면 true.
     */
    private boolean pass(List<Integer> order, Run run) {
        long start = clock.getAsLong();
        run.kinds.clear();
        run.cause = null;
        CoverageSource.Session s = null;
        int tried = 0;
        try {
            for (int k = 0; k < order.size(); k++) {
                int i = order.get(k);
                if (stopRequested) return true;
                if (expire(i)) continue;
                if (tried > 0 && clock.getAsLong() - start > BOOTSTRAP_DEADLINE_MS) {
                    for (int j = k; j < order.size(); j++) if (!expire(order.get(j))) deferred(order.get(j), run);
                    break;
                }
                tried++;
                if (s == null) {
                    try {
                        s = source.open();
                    } catch (SQLException | RuntimeException e) {
                        if (stopRequested) return true;
                        String kind = errorKind(e);
                        boolean again = retryable(e);
                        for (int j = k; j < order.size(); j++) if (!expire(order.get(j))) failed(order.get(j), kind, again, run);
                        run.cause = e.getClass().getSimpleName();
                        break;
                    }
                }
                List<CoverageSource.Row> batch = new ArrayList<>();
                state(i, READING);
                try {
                    s.read(chunkFrom[i], chunkTo[i], batch::add);
                } catch (SQLException | RuntimeException e) {
                    state(i, UNREAD);
                    // 종료가 읽는 중인 가상 스레드를 깨우면 소켓이 닫혀 연결 오류로 온다 — 까닭은 종료다
                    if (stopRequested) return true;
                    String kind = errorKind(e);
                    failed(i, kind, retryable(e), run);
                    run.cause = e.getClass().getSimpleName();
                    if (!"statement_timeout".equals(kind)) { // 문장 상한은 되돌린 연결을 그대로 쓴다 — 그 밖은 끊겼을 수 있다
                        closeQuietly(s);
                        s = null;
                    }
                    continue;
                }
                merge(batch, Math.floorDiv(chunkFrom[i], CoverageGrid.HOUR_MS));
                state(i, READ); // 합친 뒤 — 이제부터 이 시에 도착하는 셈 시작 앞 보고는 실시간으로 센다(그 행은 이 읽기 뒤에 저장된다)
                bootstrapRows.increment(batch.size());
                run.rows += batch.size();
                run.loaded++;
                publish(run, "running", null, null);
            }
            return false;
        } finally {
            closeQuietly(s);
        }
    }

    private static void closeQuietly(CoverageSource.Session s) {
        if (s == null) return;
        try { s.close(); } catch (SQLException | RuntimeException ignored) { /* 이미 끊겼다 — 다음 차례는 새 연결 */ }
    }

    private void state(int i, byte st) {
        synchronized (lock) { chunkState[i] = st; }
    }

    /** 아직 읽지 않은 조각 i 가 창 밖으로 나갔으면 더 읽지 않는다(EXPIRED — 읽을 시에서 뺀다). */
    private boolean expire(int i) {
        synchronized (lock) {
            grid.roll(clock.getAsLong());
            if (chunkTo[i] > grid.windowFromMs()) return false;
            chunkState[i] = EXPIRED;
            return true;
        }
    }

    /** 조각 i 를 이 차례에 읽으려다 실패했다(문장 · 연결) — 다시 읽을 실패면 대기(UNREAD), 아니면 곧바로 포기. */
    private void failed(int i, String kind, boolean again, Run run) {
        synchronized (lock) {
            chunkFails[i]++;
            chunkError[i] = kind;
            if (!again) chunkState[i] = GIVEN_UP;
        }
        run.kinds.merge(kind, 1, Integer::sum);
    }

    /**
     * 조각 i 를 차례 마감 때문에 이 차례에 조회하지 않았다 — 다음 차례로 미룬다. 못 읽은 횟수(attempts)에 세지 않는다(문장을 보내지 않았다). 한 번도 못 읽은 적이
     * 없으면 까닭은 deadline, 있으면 그 실패 종류를 그대로 둔다.
     */
    private void deferred(int i, Run run) {
        synchronized (lock) {
            if (chunkFails[i] == 0) chunkError[i] = "deadline";
        }
        run.kinds.merge("deadline", 1, Integer::sum);
    }

    /**
     * 다시 읽기를 기다리는 조각(실패했거나 마감으로 미룬 시 — chunkError 가 있다): <b>적게 조회한 시부터</b>(못 읽은 횟수가 적은 것 — 마감으로 미룬 시(0)가 먼저),
     * 같으면 가장 최근 시부터. 늘 느린 시가 차례마다 마감을 다 써도 뒤의 시가 다음 차례에 먼저 읽힌다(리뷰 2026-10-01).
     */
    private List<Integer> pending() {
        List<Integer> out = new ArrayList<>();
        synchronized (lock) {
            for (int i = 0; i < chunkState.length; i++) if (chunkState[i] == UNREAD && chunkError[i] != null) out.add(i);
            int[] fails = chunkFails.clone();
            out.sort(java.util.Comparator.comparingInt(i -> fails[i])); // 안정 정렬 — 같은 횟수는 가장 최근 시부터
        }
        return out;
    }

    private void giveUp(List<Integer> order) {
        synchronized (lock) {
            for (int i : order) chunkState[i] = GIVEN_UP;
        }
    }

    /** due 까지 기다린다(연결은 닫혀 있다). 종료(stop — 가상 스레드를 깨운다)면 false. */
    private boolean sleepUntil(long due) {
        try {
            for (long w; !stopRequested && (w = due - clock.getAsLong()) > 0; ) sleeper.sleep(w);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        return !stopRequested;
    }

    /** 결과마다 한 줄: 다 읽음 INFO · 포기 WARN · 종료 INFO(api 재시작마다 나는 운영 동작이다). 응답도 같은 까닭(bootstrap.error · missing)을 싣는다. */
    private void finish(Run run, boolean stopped, int retries, long t0) {
        Instant done = Instant.ofEpochMilli(clock.getAsLong());
        run.nextRetryAt = null;
        run.nextRetry = 0;
        if (stopped) {
            synchronized (lock) { // 아직 읽지 않은 시(다시 읽기 대기 포함)는 종료로 포기
                for (int i = 0; i < chunkState.length; i++) {
                    if (chunkState[i] == UNREAD || chunkState[i] == READING) {
                        chunkState[i] = GIVEN_UP;
                        chunkError[i] = "stopped";
                    }
                }
            }
            Bootstrap b = publish(run, "failed", "stopped", done);
            log.info("ship coverage bootstrap stopped after {}/{} hours (stopped) — counted since {}", run.loaded, b.hoursTotal(), b.loadedFrom());
            return;
        }
        String error = null;
        int givenUp = 0, attempts = 0, neverQueried = 0;
        Map<String, Integer> kinds = new LinkedHashMap<>();
        synchronized (lock) {
            for (int i = 0; i < chunkState.length; i++) {
                if (chunkState[i] != GIVEN_UP) continue;
                if (error == null) error = chunkError[i]; // 가장 최근의 포기한 시의 까닭
                givenUp++;
                attempts = Math.max(attempts, chunkFails[i]);
                if (chunkFails[i] == 0) neverQueried++;
                kinds.merge(chunkError[i], 1, Integer::sum);
            }
        }
        if (error == null) {
            Bootstrap b = publish(run, "done", null, done);
            log.info("ship coverage bootstrap: {} hours, {} rows in {} ms{}", b.hoursLoaded(), run.rows, done.toEpochMilli() - t0,
                    retries == 0 ? "" : " (after " + retries + (retries == 1 ? " retry)" : " retries)"));
            return;
        }
        Bootstrap b = publish(run, "failed", error, done);
        StringBuilder why = new StringBuilder();
        kinds.forEach((k, n) -> why.append(why.isEmpty() ? "" : ", ").append(k).append(" x").append(n));
        if (run.cause != null) why.append(": ").append(run.cause);
        log.warn("ship coverage bootstrap gave up on {}/{} hours after up to {} failed reads per hour ({}){} — {} hours read, counted since {}; "
                + "the hours given up stay uncounted until the api restarts", givenUp, b.hoursTotal(), attempts, why,
                neverQueried == 0 ? "" : ", " + neverQueried + " of them never queried (each pass reached its deadline first)", run.loaded, b.loadedFrom());
    }

    /** 지금 조각 상태로 응답의 부트스트랩 상태를 만들어 싣는다(합친 뒤에 부른다 — 스냅숏이 주장하는 시는 격자에 있다). */
    private Bootstrap publish(Run run, String state, String error, Instant finishedAt) {
        Bootstrap b;
        synchronized (lock) {
            int n = chunkState.length, expired = 0;
            long loadedFrom = liveFromMs;
            boolean chain = true;
            List<Missing> missing = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                byte st = chunkState[i];
                if (st == EXPIRED) expired++;
                if (chain && st == READ) loadedFrom = chunkFrom[i];
                else chain = false;
            }
            boolean waiting = false;
            for (int i = n - 1; i >= 0; i--) { // 오래된 것부터
                byte st = chunkState[i];
                boolean retry = (st == UNREAD || st == READING) && chunkError[i] != null; // 실패했거나 마감으로 미룬 시(첫 차례에 읽는 중인 시는 아니다)
                if (!retry && st != GIVEN_UP) continue;
                waiting |= retry;
                missing.add(new Missing(Instant.ofEpochMilli(chunkFrom[i]), Instant.ofEpochMilli(chunkTo[i]), retry ? Missing.RETRY : Missing.GIVEN_UP,
                        chunkFails[i], chunkError[i]));
            }
            boolean next = waiting && run.nextRetryAt != null;
            b = new Bootstrap(state, run.loaded, n - expired, run.rows, Instant.ofEpochMilli(loadedFrom), error, finishedAt, List.copyOf(missing),
                    next ? run.nextRetryAt : null, next ? run.nextRetry : null);
        }
        bootstrap = b;
        return b;
    }

    private void merge(List<CoverageSource.Row> rows, long hour) {
        for (int i = 0; i < rows.size(); i += MERGE_BATCH) {
            synchronized (lock) {
                grid.roll(clock.getAsLong());
                for (CoverageSource.Row r : rows.subList(i, Math.min(rows.size(), i + MERGE_BATCH)))
                    count(grid.addCell(r.lonIdx(), r.latIdx(), r.mmsi(), hour, r.positions(), r.lastMs()));
                gauges();
            }
        }
    }

    /** 실패의 종류(응답 · 로그 — 서버 글자는 싣지 않는다). */
    static String errorKind(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) if (t instanceof SocketTimeoutException) return "read_timeout";
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException s && s.getSQLState() != null) {
                if ("57014".equals(s.getSQLState())) return "statement_timeout";
                if (s.getSQLState().startsWith("08")) return "connection";
            }
        }
        return "error";
    }

    /**
     * 나중에 다시 읽을 실패인가: 문장 상한(57014) · 소켓 시간 초과 · 연결(08) · 트랜잭션 되돌림(40 — 교착 · 직렬화) · 자원 부족(53 — 연결 수 · 메모리 · 디스크) ·
     * 잠금 없음(55P03 등 55) · 운영자 개입(57 — 재시작 중 · 종료). 그 밖(권한 · 형식 · 서버 상태 없는 예외)은 다시 읽어도 같다 — 곧바로 포기한다.
     */
    static boolean retryable(Throwable e) {
        if (!"error".equals(errorKind(e))) return true;
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException s && s.getSQLState() != null && s.getSQLState().length() >= 2) {
                switch (s.getSQLState().substring(0, 2)) {
                    case "40", "53", "55", "57" -> { return true; }
                    default -> { }
                }
            }
        }
        return false;
    }

    // ---- 스냅숏 ----

    /**
     * 지금 응답({@value #SNAPSHOT_MS} ms 안이면 같은 것). 지났으면 잠금 안에서 다시 보고 만든다 — 동시에 온 요청들이 차례로 다시 만들지 않고(칸 정렬은 스트림 소비
     * 스레드와 같은 격자 잠금 안이다) 먼저 만든 것을 함께 쓴다(ETag 도 하나).
     */
    public Snapshot snapshot() {
        Snapshot s = snapshot;
        if (fresh(s, clock.getAsLong())) return s;
        synchronized (snapLock) {
            s = snapshot;
            long now = clock.getAsLong();
            return fresh(s, now) ? s : build(now);
        }
    }

    private static boolean fresh(Snapshot s, long now) {
        return s != null && now >= s.generatedAt().toEpochMilli() && now - s.generatedAt().toEpochMilli() < SNAPSHOT_MS;
    }

    /** 새로 만든다(시험 · 캐시가 지났을 때). */
    public Snapshot snapshotNow() {
        synchronized (snapLock) {
            return build(clock.getAsLong());
        }
    }

    /** snapLock 안에서. */
    private Snapshot build(long now) {
        // 부트스트랩 상태를 격자 복사보다 먼저 읽는다: 부트스트랩은 시 조각을 합친(잠금) 뒤에 loaded_from 을 올리므로, 여기서 읽은 상태가 말하는 시는 아래 복사본에
        // 늘 들어 있다 — 복사본에 없는 시까지 '셌다'(since · covered)고 말하지 않는다(더 적게 말할 수는 있다 — 다음 스냅숏이 따라잡는다).
        Bootstrap b = bootstrap;
        beforeGridCopy.run();
        List<CoverageGrid.CellView> cells;
        long positions, dropped, windowFrom;
        synchronized (lock) {
            grid.roll(now);
            cells = List.copyOf(grid.cells());
            positions = grid.positions();
            dropped = grid.dropped();
            windowFrom = grid.windowFromMs();
            gauges();
        }
        b = b.inWindow(windowFrom);
        long coveredFrom = Math.min(b.loadedFrom().toEpochMilli(), liveFromMs);
        long since = Math.max(windowFrom, coveredFrom);
        String covered = since == windowFrom ? "full" : coveredFrom < liveFromMs ? "partial" : "since_api_start";
        long newest = Long.MIN_VALUE;
        for (CoverageGrid.CellView c : cells) newest = Math.max(newest, c.lastSeenMs());
        Snapshot s = new Snapshot("\"o" + Long.toString(++snapshotSeq, 36) + "-" + Long.toString(now, 36) + "\"", Instant.ofEpochMilli(now),
                Instant.ofEpochMilli(windowFrom), Instant.ofEpochMilli(since), covered, Instant.ofEpochMilli(startMs), Instant.ofEpochMilli(liveFromMs), b,
                cells, positions, dropped, maxCells, maxShipCells, provider, newest == Long.MIN_VALUE ? null : Instant.ofEpochMilli(newest));
        snapshot = s;
        return s;
    }

    // ---- 생명주기 ----

    @Override
    public void start() {
        running = true;
        stopRequested = false;
        long wake = startMs + graceMs;
        worker = Thread.ofVirtual().name("ship-coverage-bootstrap").start(() -> {
            try {
                long wait;
                while (running && (wait = wake - clock.getAsLong()) > 0) Thread.sleep(Math.min(wait, 1_000));
                long waited = clock.getAsLong();
                while (running && !backlogWritten(clock.getAsLong())) Thread.sleep(1_000);
                waited = clock.getAsLong() - waited;
                if (running && waited >= 1_000)
                    log.info("ship coverage bootstrap: waited {} ms after the grace for the stream backlog before {} to be written", waited, Instant.ofEpochMilli(liveFromMs));
            } catch (InterruptedException e) {
                return;
            }
            if (running) runBootstrap();
        });
    }

    /** 멈춤: 기다리는 중이면 부트스트랩을 하지 않는다. 읽는 중이면 다음 시 조각 앞에서 멈춘다(지금 문장은 제 상한 안에 끝난다). 다시 읽기를 기다리는 중이면 곧바로 깨워 멈춘다. */
    @Override
    public void stop() {
        running = false;
        stopRequested = true;
        Thread w = worker;
        if (w != null) w.interrupt();
    }

    @Override
    public boolean isRunning() { return running; }
}
