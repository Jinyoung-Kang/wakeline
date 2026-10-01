package dev.wakeline.platform.data;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.metrics.micrometer.MicrometerMetricsTrackerFactory;
import dev.wakeline.DbTestSupport;
import dev.wakeline.aircraft.core.AircraftEvents;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.data.AircraftRepository;
import dev.wakeline.aircraft.data.TrackWriter;
import dev.wakeline.platform.support.Receipt;
import dev.wakeline.ships.core.AisGap;
import dev.wakeline.ships.core.ShipEvents;
import dev.wakeline.ships.core.ShipState;
import dev.wakeline.ships.data.ShipRepository;
import dev.wakeline.ships.data.ShipWriter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.search.Search;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DelegatingDataSource;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 측정(리뷰 cto-2026-10 D6 · api-review §3 B9 — docs/PERF.md §13): 공유 풀(운영과 같은 Hikari 12 · 연결 대기 5 s · statement_timeout 30 s ·
 * lock_timeout 5 s)에서 느린 공개 조회(Sql.publicRead — 문장 상한 3 s)가 끝나는 것보다 빨리 들어올 때 기록기(항적 · 선박 · 순서 큐)가 굶는가.
 * <ul>
 *   <li>기록기는 운영 클래스 그대로(TrackWriter · ShipWriter · OrderedWriter — 운영 재시도 간격 2 s → 30 s · 1 s → 30 s), 운영 모양의 입력:
 *       관심 지역 200대 / 10 s, 전세계 10,000대 / 120 s(첫 것은 폭주 20 s 뒤), 선박 위치 400건 / 10 s(MMSI 마다 60 s 에 한 번 — 모두 쓰인다),
 *       순서 큐 작업(ingest_gap 한 행) / 5 s. PERF §1 · §3 의 실측(관심 지역 70–190대, 전세계 약 10,400–10,900대, 선박 위치 분당 1,773–2,769행)에 맞췄다.</li>
 *   <li>공개 조회: 요청마다 가상 스레드 하나(Tomcat 가상 스레드처럼 수에 상한이 없다)가 {@code Sql.publicRead} 로 {@code pg_sleep} 문장 하나를 낸다 —
 *       '느린 DB' 의 모형. 기본은 10 s 를 자는 문장(3 s 상한에 끊긴다 — 연결을 약 3 s 잡는다).</li>
 *   <li>단계: 데우기 10 s(조회 없음) → 폭주(기본 60 s) → 따라잡기(조회 없음, 입력은 계속 — 폭주 끝까지 넣은 항적 · 선박 행과 순서 큐 작업이 모두
 *       끝날 때까지, 최대 60 s).</li>
 *   <li>잰다: 기록기가 풀에서 연결을 얻는 데 기다린 시간(p50 · p95 · 최대)과 실패(5 s 대기 초과) 수 — 기록기 DataSource 를 감싼 계측(같은 풀),
 *       폭주 동안 쓴 항적 · 선박 행과 순서 큐 작업(넣은 수와 함께), 큐 최대, 따라잡는 데 걸린 시간, 버린 행(result=dropped), Hikari 에서 연결을
 *       기다린 스레드 최대, 공개 조회 결과(성공 · 3 s 취소 · 5 s 연결 대기 초과).</li>
 * </ul>
 * 실행: {@code ./gradlew --offline perfTest --tests 'dev.wakeline.platform.data.SharedPoolStarvationPerfTest'}
 * (선택: -Dwakeline.perf.pool.rates=0,4,8,16 · -Dwakeline.perf.pool.storm-s=60 · -Dwakeline.perf.pool.sleep-s=10). 결과는 표준 출력과
 * build/perf/pool-starvation.txt.
 */
@Tag("perf")
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class SharedPoolStarvationPerfTest {
    static final int POOL_SIZE = 12;
    static final long CONNECTION_TIMEOUT_MS = 5_000;
    static final int REGION_AIRCRAFT = 200;
    static final int GLOBAL_AIRCRAFT = 10_000;
    static final long REGION_EVERY_MS = 10_000;
    static final long GLOBAL_EVERY_MS = 120_000;
    static final long GLOBAL_FIRST_AFTER_STORM_MS = 20_000;
    static final int SHIP_POSITIONS = 400;
    static final long ORDERED_EVERY_MS = 5_000;
    static final long WARMUP_MS = 10_000;
    static final long RECOVERY_MAX_MS = 60_000;

    record Scenario(double readsPerSecond, double sleepS, long stormMs) {}

    @Test
    void measure() throws Exception {
        DbTestSupport.reset();
        double[] rates = Arrays.stream(System.getProperty("wakeline.perf.pool.rates", "0,2,4,8,16").split(","))
                .mapToDouble(Double::parseDouble).toArray();
        long stormMs = Long.getLong("wakeline.perf.pool.storm-s", 60) * 1000;
        double sleepS = Double.parseDouble(System.getProperty("wakeline.perf.pool.sleep-s", "10"));
        List<String> lines = new ArrayList<>();
        lines.add(header());
        for (double r : rates) {
            String line = run(new Scenario(r, sleepS, stormMs));
            System.out.println(line);
            lines.add(line);
        }
        Path out = Path.of("build/perf/pool-starvation.txt");
        Files.createDirectories(out.getParent());
        Files.write(out, lines);
        System.out.println(String.join("\n", lines));
    }

    static String header() {
        return "reads/s | writer conn wait p50/p95/max ms (n) | writer conn timeouts track/ship/ordered | written during storm: track rows/ship rows/ordered tasks"
                + " (enqueued) | queue max track/ship/ordered | caught up after storm s | dropped track/ship/ordered | hikari waiting max"
                + " | reads ok/cancelled 3 s/pool timeout 5 s/other · p95 ms";
    }

    String run(Scenario s) throws Exception {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        HikariDataSource pool = pool(meters);
        Timed trackDs = new Timed(pool), shipDs = new Timed(pool), orderedDs = new Timed(pool);
        JdbcClient readers = JdbcClient.create(pool);
        TrackWriter tw = new TrackWriter(new JdbcTemplate(trackDs), new AircraftRepository(JdbcClient.create(trackDs), DbTestSupport.JSON), meters);
        OrderedWriter ordered = new OrderedWriter(meters);
        ShipWriter sw = new ShipWriter(new ShipRepository(new JdbcTemplate(shipDs), JdbcClient.create(shipDs)), ordered, meters, e -> {});
        ShipRepository orderedRepo = new ShipRepository(new JdbcTemplate(orderedDs), JdbcClient.create(orderedDs));
        tw.start();
        ordered.start();
        sw.start();

        AtomicBoolean feeding = new AtomicBoolean(true);
        Fed fed = new Fed();
        AtomicLong stormStart = new AtomicLong(Long.MAX_VALUE);
        long t0 = System.currentTimeMillis();
        Thread feeder = Thread.ofVirtual().name("perf-feeder").start(() -> feed(tw, sw, ordered, orderedRepo, feeding, fed, stormStart, t0));
        // 표본: Hikari 에서 연결을 기다리는 스레드 · 큐 길이의 최대
        AtomicBoolean sampling = new AtomicBoolean(true);
        AtomicInteger pendingMax = new AtomicInteger(), trackQueueMax = new AtomicInteger(), shipQueueMax = new AtomicInteger(), orderedQueueMax = new AtomicInteger();
        Thread sampler = Thread.ofVirtual().name("perf-sampler").start(() -> {
            while (sampling.get()) {
                var mx = pool.getHikariPoolMXBean();
                if (mx != null) pendingMax.accumulateAndGet(mx.getThreadsAwaitingConnection(), Math::max);
                trackQueueMax.accumulateAndGet((int) gauge(meters, "wakeline_track_queue"), Math::max);
                shipQueueMax.accumulateAndGet((int) gauge(meters, "wakeline_ship_queue"), Math::max);
                orderedQueueMax.accumulateAndGet((int) gauge(meters, "wakeline_persist_queue"), Math::max);
                sleep(100);
            }
        });

        sleep(WARMUP_MS);
        trackDs.reset();
        shipDs.reset();
        orderedDs.reset();
        pendingMax.set(0);
        trackQueueMax.set(0);
        shipQueueMax.set(0);
        orderedQueueMax.set(0);
        // 폭주: 1/rate 마다 요청 하나(가상 스레드)
        ConcurrentLinkedQueue<long[]> reads = new ConcurrentLinkedQueue<>(); // {outcome, ms}
        List<Thread> inFlight = Collections.synchronizedList(new ArrayList<>());
        Progress before = Progress.of(meters, fed);
        stormStart.set(System.currentTimeMillis());
        if (s.readsPerSecond() > 0) {
            double intervalNs = 1e9 / s.readsPerSecond();
            long base = System.nanoTime();
            for (long i = 0; ; i++) {
                long due = base + (long) (i * intervalNs);
                long now = System.nanoTime();
                if (due - base > s.stormMs() * 1_000_000L) break;
                if (due > now) sleepNs(due - now);
                inFlight.add(Thread.ofVirtual().start(() -> reads.add(read(readers, s.sleepS()))));
            }
        } else {
            sleep(s.stormMs());
        }
        Progress atEnd = Progress.of(meters, fed);
        long stormEnd = System.currentTimeMillis();
        // 따라잡기: 폭주 끝까지 넣은 항적 · 선박 행과 순서 큐 작업이 모두 끝날 때까지(최대 60 s — 입력은 계속)
        double caughtUpS = Double.NaN;
        while (System.currentTimeMillis() < stormEnd + RECOVERY_MAX_MS) {
            Progress p = Progress.of(meters, fed);
            if (p.trackDone() >= atEnd.trackIn() && p.shipDone() >= atEnd.shipIn() && p.orderedDone() >= atEnd.orderedIn()) {
                caughtUpS = (System.currentTimeMillis() - stormEnd) / 1000.0;
                break;
            }
            sleep(200);
        }
        for (Thread t : List.copyOf(inFlight)) t.join(15_000);
        feeding.set(false);
        feeder.join(15_000);
        Progress last = Progress.of(meters, fed);
        sampling.set(false);
        sampler.join();
        sw.stop();
        ordered.stop();
        tw.stop();
        pool.close();

        int ok = 0, cancelled = 0, poolTimeout = 0, other = 0;
        List<Long> readMs = new ArrayList<>();
        for (long[] r : reads) {
            readMs.add(r[1]);
            switch ((int) r[0]) {
                case 0 -> ok++;
                case 1 -> cancelled++;
                case 2 -> poolTimeout++;
                default -> other++;
            }
        }
        return String.format(Locale.ROOT,
                "%5.1f | %s | %d/%d/%d | %.0f/%.0f/%.0f (%d/%d/%d) | %d/%d/%d | %s | %.0f/%.0f/%.0f | %d | %d/%d/%d/%d · %d",
                s.readsPerSecond(), Timed.summary(trackDs, shipDs, orderedDs), trackDs.failures.get(), shipDs.failures.get(), orderedDs.failures.get(),
                atEnd.trackWritten() - before.trackWritten(), atEnd.shipWritten() - before.shipWritten(), atEnd.orderedOk() - before.orderedOk(),
                atEnd.trackIn() - before.trackIn(), atEnd.shipIn() - before.shipIn(), atEnd.orderedIn() - before.orderedIn(),
                trackQueueMax.get(), shipQueueMax.get(), orderedQueueMax.get(),
                Double.isNaN(caughtUpS) ? ">" + RECOVERY_MAX_MS / 1000 : String.format(Locale.ROOT, "%.1f", caughtUpS),
                last.trackDropped(), last.shipDropped(), last.orderedDropped(), pendingMax.get(),
                ok, cancelled, poolTimeout, other, percentile(readMs, 0.95));
    }

    /** 넣은 수(입력기가 센다). */
    static final class Fed {
        final AtomicLong track = new AtomicLong(), ship = new AtomicLong(), ordered = new AtomicLong();
    }

    /** 한 시점의 넣은 수 · 끝난 수(지표). */
    record Progress(long trackIn, long shipIn, long orderedIn, double trackWritten, double trackDropped, double shipWritten, double shipDropped,
                    double orderedOk, double orderedDropped) {
        static Progress of(MeterRegistry m, Fed f) {
            return new Progress(f.track.get(), f.ship.get(), f.ordered.get(),
                    counter(m, "wakeline_track_rows_total", "result", "written"), counter(m, "wakeline_track_rows_total", "result", "dropped"),
                    counter(m, "wakeline_ship_rows_total", "result", "written"), counter(m, "wakeline_ship_rows_total", "result", "dropped"),
                    counter(m, "wakeline_persist_tasks_total", "result", "ok"), counter(m, "wakeline_persist_tasks_total", "result", "dropped"));
        }

        double trackDone() { return trackWritten + trackDropped; }
        double shipDone() { return shipWritten + shipDropped; }
        double orderedDone() { return orderedOk + orderedDropped; }
    }

    /** 입력: 관심 지역 · 전세계 항공기, 선박 위치, 순서 큐 작업 — 운영 모양의 주기(폭주 전후 내내). */
    static void feed(TrackWriter tw, ShipWriter sw, OrderedWriter ordered, ShipRepository orderedRepo, AtomicBoolean feeding,
                     Fed fed, AtomicLong stormStart, long t0) {
        long nextRegion = t0, nextShips = t0, nextOrdered = t0, nextGlobal = Long.MAX_VALUE;
        long round = 0, gap = 0;
        while (feeding.get()) {
            long now = System.currentTimeMillis();
            if (nextGlobal == Long.MAX_VALUE && stormStart.get() != Long.MAX_VALUE) nextGlobal = stormStart.get() + GLOBAL_FIRST_AFTER_STORM_MS;
            if (now >= nextRegion) {
                fed.track.addAndGet(aircraft(tw, "region", "r", REGION_AIRCRAFT));
                nextRegion += REGION_EVERY_MS;
            }
            if (now >= nextGlobal) {
                fed.track.addAndGet(aircraft(tw, "global", "g", GLOBAL_AIRCRAFT));
                nextGlobal += GLOBAL_EVERY_MS;
            }
            if (now >= nextShips) {
                Instant seen = Instant.now();
                List<ShipState> states = new ArrayList<>(SHIP_POSITIONS);
                long slot = round++ % 6; // MMSI 마다 60 s 에 한 번 → 모두 새 60 s 창
                for (int i = 0; i < SHIP_POSITIONS; i++) {
                    String mmsi = String.valueOf(440_000_000L + slot * SHIP_POSITIONS + i);
                    states.add(new ShipState(mmsi, 35.0 + i * 1e-3, 129.05, 11.2, 181.5, null, 5, null, "estimated", seen, "aisstream", "PositionReport", "A"));
                }
                sw.onShips(new ShipEvents.ShipsUpdated(seen, "aisstream", states, List.of(), Set.of(), Set.of(), Receipt.NONE));
                fed.ship.addAndGet(SHIP_POSITIONS);
                nextShips += REGION_EVERY_MS;
            }
            if (now >= nextOrdered) {
                Instant at = Instant.ofEpochSecond(1_700_000_000L + gap++ * 60);
                AisGap g = new AisGap(at, at.plusSeconds(30), "perf", "aisstream");
                ordered.submit(OrderedWriter.task("ais_gap", () -> orderedRepo.insertGap(g)));
                fed.ordered.incrementAndGet();
                nextOrdered += ORDERED_EVERY_MS;
            }
            sleep(50);
        }
    }

    static int aircraft(TrackWriter tw, String scope, String prefix, int n) {
        Instant seen = Instant.now();
        Map<String, AircraftState> states = new HashMap<>(n * 2);
        for (int i = 0; i < n; i++) {
            String hex = prefix + String.format("%05x", i);
            states.put(hex, new AircraftState(hex, "TST" + i, null, null, null, 30 + (i % 300) * 0.1, 120 + (i / 300) * 0.1, 30_000, 450.0, 90.0, 0.0,
                    false, "1200", seen, "adsb_lol", seen, 0, false));
        }
        tw.onSnapshot(new AircraftEvents.SnapshotUpdated(Snapshot.empty(scope), new Snapshot(1, scope, "adsb_lol", seen, seen, "-", Map.copyOf(states))));
        return n;
    }

    /** 공개 조회 하나 → {결과(0 성공 · 1 3 s 취소 · 2 연결 대기 초과 · 3 그 밖), ms}. */
    static long[] read(JdbcClient db, double sleepS) {
        long t0 = System.nanoTime();
        int outcome;
        try {
            Sql.publicRead(db, "perf.slow_read", "SELECT 1 FROM pg_sleep(:s)").param("s", sleepS).query(Integer.class).single();
            outcome = 0;
        } catch (QueryTimeoutException e) {
            outcome = 1;
        } catch (CannotGetJdbcConnectionException e) {
            outcome = 2;
        } catch (RuntimeException e) {
            outcome = "57014".equals(sqlState(e)) ? 1 : 3;
        }
        return new long[]{outcome, (System.nanoTime() - t0) / 1_000_000};
    }

    static String sqlState(Throwable e) {
        for (Throwable c = e; c != null; c = c.getCause() == c ? null : c.getCause())
            if (c instanceof SQLException s && s.getSQLState() != null) return s.getSQLState();
        return null;
    }

    /** 운영 공유 풀과 같은 설정(application.yml spring.datasource.hikari). */
    static HikariDataSource pool(MeterRegistry meters) {
        HikariConfig c = new HikariConfig();
        c.setPoolName("perf-shared");
        c.setJdbcUrl(DbTestSupport.jdbcUrl("wakeline"));
        c.setUsername("wakeline_api");
        c.setPassword(DbTestSupport.API_PW);
        c.setMaximumPoolSize(POOL_SIZE);
        c.setConnectionTimeout(CONNECTION_TIMEOUT_MS);
        c.addDataSourceProperty("ApplicationName", "wakeline-api-perf");
        c.addDataSourceProperty("reWriteBatchedInserts", "true");
        c.addDataSourceProperty("options", "-c statement_timeout=30s -c lock_timeout=5s");
        c.setMetricsTrackerFactory(new MicrometerMetricsTrackerFactory(meters));
        return new HikariDataSource(c);
    }

    static double counter(MeterRegistry m, String name, String... tags) {
        Search s = m.find(name);
        if (tags.length > 0) s = s.tags(tags);
        return s.counters().stream().mapToDouble(io.micrometer.core.instrument.Counter::count).sum();
    }

    static double gauge(MeterRegistry m, String name) {
        var g = m.find(name).gauge();
        return g == null ? 0 : g.value();
    }

    static long percentile(List<Long> xs, double p) {
        if (xs.isEmpty()) return 0;
        List<Long> s = new ArrayList<>(xs);
        Collections.sort(s);
        return s.get(Math.min(s.size() - 1, (int) Math.ceil(p * s.size()) - 1));
    }

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    static void sleepNs(long ns) {
        try { Thread.sleep(ns / 1_000_000, (int) (ns % 1_000_000)); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    /** 같은 풀을 감싸 연결을 얻는 데 기다린 시간과 실패를 잰다(기록기마다 하나). */
    static final class Timed extends DelegatingDataSource {
        final ConcurrentLinkedQueue<Long> waitsMs = new ConcurrentLinkedQueue<>();
        final AtomicInteger failures = new AtomicInteger();

        Timed(DataSource d) { super(d); }

        void reset() {
            waitsMs.clear();
            failures.set(0);
        }

        @Override
        public Connection getConnection() throws SQLException {
            long t0 = System.nanoTime();
            try {
                Connection c = super.getConnection();
                waitsMs.add((System.nanoTime() - t0) / 1_000_000);
                return c;
            } catch (SQLException e) {
                waitsMs.add((System.nanoTime() - t0) / 1_000_000);
                failures.incrementAndGet();
                throw e;
            }
        }

        static String summary(Timed... ds) {
            List<Long> all = new ArrayList<>();
            for (Timed t : ds) all.addAll(t.waitsMs);
            long max = all.stream().mapToLong(Long::longValue).max().orElse(0);
            return percentile(all, 0.5) + "/" + percentile(all, 0.95) + "/" + max + " (n=" + all.size() + ")";
        }
    }
}
