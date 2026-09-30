package dev.wakeline.coverage;

import dev.wakeline.domain.ShipState;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.persist.ShipRepository;
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
import java.util.List;
import java.util.function.LongSupplier;

/**
 * 관측 AIS 수신 범위(ADR-027 · 계약 v5 §G27 — GET /api/v1/ships/coverage): '선박 위치가 실제로 어디서 왔는가'를 0.5° 칸 · 최근 24 h 로 센다.
 * 구독 범위(운영 설정)와 다르다 — aisstream.io 는 육상 수신국이 받은 것만 보내므로(ADR-014) 구독해도 수신국이 없는 해역은 비어 있다.
 * <ul>
 *   <li><b>실시간 셈</b>: 선박 저장기가 고른 위치({@link IngestEvents.ShipsSampled} — MMSI 별 60 s 창의 첫 보고, ship_position 과 같은 표본)를 격자에 넣는다.
 *       셈 시작(live_from) = api 시작 시각을 60 s 창의 시작으로 내린 것 — 그 앞의 보고(재시작 때 밀린 백로그)는 세지 않는다(DB 부트스트랩의 몫 — 두 번 세지
 *       않는다). 그래서 api 시작 분(≤ 60 s)에 앞선 프로세스만 받은 보고는 빠질 수 있다(적게 셀 수는 있어도 두 번 세지 않는다). 5분 넘게 미래인 보고는 세지 않는다.</li>
 *   <li><b>부트스트랩</b>(기동 때 한 번, 요청 경로 밖 가상 스레드): api 시작 {@code wakeline.ship-coverage.bootstrap-grace-ms}(기본 30 s — 저장기가 밀린 행을 쓰는
 *       여유, 고른 값) 뒤, 창 안의 ship_position 을 셈 시작 앞까지 <b>가장 최근 시부터 거꾸로</b> 시 하나에 문장 하나로 읽는다({@link JdbcCoverageSource} — 연결 하나 ·
 *       읽기 전용 · 문장 · 소켓 · 연결 상한, 공유 풀 · 선택 조회 풀을 쓰지 않는다 — ADR-025 의 격벽). 전체 마감 {@value #BOOTSTRAP_DEADLINE_MS} ms(고른 값).
 *       멈추면(오류 · 마감) 셈 시작부터 이어진 부분만 '덮음'으로 밝힌다(since) — 창 전체인 척하지 않는다.</li>
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
    public static final long BOOTSTRAP_DEADLINE_MS = 180_000;
    /** 한 번에 격자에 넣는 부트스트랩 행 수(잠금을 오래 잡지 않게). */
    static final int MERGE_BATCH = 5_000;

    /** 부트스트랩 상태. loadedFrom = 셈 시작부터 거꾸로 이어 읽은 가장 오래된 순간(읽은 것이 없으면 셈 시작). */
    public record Bootstrap(String state, int hoursLoaded, int hoursTotal, long rows, Instant loadedFrom, String error, Instant finishedAt) {}

    /** 응답 한 벌(불변). */
    public record Snapshot(String etag, Instant generatedAt, Instant windowFrom, Instant since, String covered, Instant apiStartedAt, Instant liveFrom,
                           Bootstrap bootstrap, List<CoverageGrid.CellView> cells, long positions, long dropped, int maxCells, int maxShipCells,
                           String provider, Instant newestSeen) {}

    private final CoverageSource source;
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
    private final Counter bootstrapRows;
    private volatile boolean running;
    /** stop() 이 불렸다 — 부트스트랩은 다음 시 조각 앞에서 멈춘다(부르는 스레드에서 직접 돌린 부트스트랩은 멈추지 않는다). */
    private volatile boolean stopRequested;
    private volatile Thread worker;

    @Autowired
    public ShipCoverage(JdbcCoverageSource source, MeterRegistry meters,
                        @Value("${wakeline.ship-coverage.bootstrap-grace-ms:" + DEFAULT_BOOTSTRAP_GRACE_MS + "}") long graceMs) {
        this(source, System::currentTimeMillis, meters, graceMs, MAX_CELLS, MAX_SHIP_CELLS);
    }

    ShipCoverage(CoverageSource source, LongSupplier clock, MeterRegistry meters, long graceMs, int maxCells, int maxShipCells) {
        this(source, clock, meters, graceMs, maxCells, maxShipCells, clock.getAsLong());
    }

    ShipCoverage(CoverageSource source, LongSupplier clock, MeterRegistry meters, long graceMs, int maxCells, int maxShipCells, long startMs) {
        if (graceMs < 0) throw new IllegalStateException("wakeline.ship-coverage.bootstrap-grace-ms must be >= 0, got " + graceMs);
        this.source = source;
        this.clock = clock;
        this.graceMs = graceMs;
        this.maxCells = maxCells;
        this.maxShipCells = maxShipCells;
        this.startMs = startMs;
        this.liveFromMs = Math.floorDiv(startMs, LIVE_ALIGN_MS) * LIVE_ALIGN_MS;
        this.grid = new CoverageGrid(maxCells, maxShipCells, clock.getAsLong());
        this.bootstrap = new Bootstrap("pending", 0, 0, 0, Instant.ofEpochMilli(liveFromMs), null, null);
        Gauge.builder("wakeline_ship_coverage_cells", this, c -> c.cellsGauge).description("관측 수신 격자의 칸 수(0.5°, 최근 24 h)").register(meters);
        Gauge.builder("wakeline_ship_coverage_ship_cells", this, c -> c.shipCellsGauge).description("관측 수신 격자의 칸별 선박 항목 수").register(meters);
        droppedCells = Counter.builder("wakeline_ship_coverage_dropped_total").tag("reason", "cells").description("칸 상한 때문에 세지 못한 위치").register(meters);
        droppedShipCells = Counter.builder("wakeline_ship_coverage_dropped_total").tag("reason", "ship_cells")
                .description("칸별 선박 상한 때문에 세지 못한 위치").register(meters);
        ignoredEarly = Counter.builder("wakeline_ship_coverage_ignored_total").tag("reason", "before_live")
                .description("셈 시작 앞의 보고(부트스트랩의 몫)").register(meters);
        ignoredFuture = Counter.builder("wakeline_ship_coverage_ignored_total").tag("reason", "future").description("5분 넘게 미래인 보고").register(meters);
        ignoredMmsi = Counter.builder("wakeline_ship_coverage_ignored_total").tag("reason", "mmsi").description("MMSI 가 9자리 숫자가 아닌 보고").register(meters);
        bootstrapRows = Counter.builder("wakeline_ship_coverage_bootstrap_rows_total").description("부트스트랩이 읽은 칸 · MMSI 행").register(meters);
    }

    public long liveFromMs() { return liveFromMs; }

    // ---- 실시간 셈 ----

    @EventListener
    public void onSampled(IngestEvents.ShipsSampled e) {
        long now = clock.getAsLong();
        synchronized (lock) {
            grid.roll(now);
            for (ShipState s : e.positions()) {
                long t = s.seenAt().toEpochMilli();
                if (t < liveFromMs) { ignoredEarly.increment(); continue; }
                if (t > now + FUTURE_SKEW_MS) { ignoredFuture.increment(); continue; }
                int mmsi = mmsi(s.mmsi());
                if (mmsi < 0) { ignoredMmsi.increment(); continue; }
                count(grid.add(mmsi, s.lat(), s.lon(), t));
                provider = s.provider();
            }
            gauges();
        }
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
     */
    void runBootstrap() {
        long t0 = clock.getAsLong();
        List<long[]> chunks = new ArrayList<>();
        long hourStart = Math.floorDiv(liveFromMs, CoverageGrid.HOUR_MS) * CoverageGrid.HOUR_MS;
        if (hourStart < liveFromMs) chunks.add(new long[]{hourStart, liveFromMs});
        long windowFrom;
        synchronized (lock) {
            grid.roll(t0);
            windowFrom = grid.windowFromMs();
        }
        for (long from = hourStart - CoverageGrid.HOUR_MS; from >= windowFrom; from -= CoverageGrid.HOUR_MS) chunks.add(new long[]{from, from + CoverageGrid.HOUR_MS});
        int total = chunks.size();
        int loaded = 0;
        long rows = 0;
        long loadedFrom = liveFromMs;
        bootstrap = new Bootstrap("running", 0, total, 0, Instant.ofEpochMilli(loadedFrom), null, null);
        log.info("ship coverage bootstrap: reading {} hours of ship_position before {} (live counting since then)", total, Instant.ofEpochMilli(liveFromMs));
        String error = null;
        String cause = null;
        try (CoverageSource.Session s = source.open()) {
            for (long[] c : chunks) {
                if (stopRequested) { error = "stopped"; break; }
                if (loaded > 0 && clock.getAsLong() - t0 > BOOTSTRAP_DEADLINE_MS) { error = "deadline"; break; }
                List<CoverageSource.Row> batch = new ArrayList<>();
                s.read(c[0], c[1], batch::add);
                merge(batch, Math.floorDiv(c[0], CoverageGrid.HOUR_MS));
                bootstrapRows.increment(batch.size());
                rows += batch.size();
                loaded++;
                loadedFrom = c[0];
                bootstrap = new Bootstrap("running", loaded, total, rows, Instant.ofEpochMilli(loadedFrom), null, null);
            }
        } catch (SQLException | RuntimeException e) {
            // 종료가 읽는 중인 가상 스레드를 깨우면 소켓이 닫혀 연결 오류로 온다 — 까닭은 종료다
            error = stopRequested ? "stopped" : errorKind(e);
            cause = e.getClass().getSimpleName();
        }
        Instant done = Instant.ofEpochMilli(clock.getAsLong());
        if (error == null) {
            bootstrap = new Bootstrap("done", loaded, total, rows, Instant.ofEpochMilli(loadedFrom), null, done);
            log.info("ship coverage bootstrap: {} hours, {} rows in {} ms", loaded, rows, done.toEpochMilli() - t0);
            return;
        }
        bootstrap = new Bootstrap("failed", loaded, total, rows, Instant.ofEpochMilli(loadedFrom), error, done);
        // 결과마다 한 줄 — 종료로 멈춤은 운영 동작이라 INFO, 실패 · 마감은 WARN(로그 화면에 뜬다). 응답도 같은 까닭(bootstrap.error)을 싣는다
        String kind = cause == null ? error : error + ": " + cause;
        if ("stopped".equals(error))
            log.info("ship coverage bootstrap stopped after {}/{} hours ({}) — counted since {}", loaded, total, kind, Instant.ofEpochMilli(loadedFrom));
        else
            log.warn("ship coverage bootstrap stopped after {}/{} hours ({}) — counted since {}", loaded, total, kind, Instant.ofEpochMilli(loadedFrom));
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
            } catch (InterruptedException e) {
                return;
            }
            if (running) runBootstrap();
        });
    }

    /** 멈춤: 기다리는 중이면 부트스트랩을 하지 않는다. 읽는 중이면 다음 시 조각 앞에서 멈춘다(지금 문장은 제 상한 안에 끝난다). */
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
