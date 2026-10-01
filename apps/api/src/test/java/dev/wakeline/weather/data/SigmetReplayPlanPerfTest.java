package dev.wakeline.weather.data;

import dev.wakeline.DbTestSupport;
import dev.wakeline.PlanCapture;
import dev.wakeline.geo.Bbox;
import dev.wakeline.platform.data.OrderedWriter;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 측정(리뷰 cto-2026-10 P4 · api-review §4 P7 — docs/PERF.md §13): SIGMET 재생 조회(SigmetRepository.validAt — 운영 SQL 그대로)의 실행 계획과 시간.
 * SIGMET 은 지우지 않으므로(MaintenanceJobs) 표가 계속 자란다 — 합성 200,000건(약 250일: 하루 약 800건, 2–6 h 유효 → 같은 때 유효한 것 약 130건 =
 * 운영 실측과 같은 크기, 5 % 철회 · 5 % 도형 없음, 도형은 세계 곳곳의 3° × 2° 상자)을 넣고 ANALYZE 한 뒤:
 * <ul>
 *   <li>{@code EXPLAIN (ANALYZE, BUFFERS)} — 처음 몇 번의 실행(맞춤 계획)과 같은 값으로(PlanCapture ANALYZE)</li>
 *   <li>일반 계획(같은 연결에서 여러 번 실행한 뒤 — PlanCapture GENERIC)의 노드</li>
 *   <li>validAt 한 번의 시간(가운데 값, 데우기 5번 뒤 15번)</li>
 * </ul>
 * 시각은 재생이 받는 범위(지난 31일, HistoryController.REPLAY_MAX_AGE) 안의 넷 · bbox 는 전세계와 한국 주변.
 * 실행: {@code ./gradlew --offline perfTest --tests 'dev.wakeline.weather.data.SigmetReplayPlanPerfTest'} — 결과는 표준 출력과 build/perf/sigmet-replay.txt.
 */
@Tag("perf")
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class SigmetReplayPlanPerfTest {
    static final int ROWS = 200_000;
    static final int RUNS = 15;
    static final Pattern EXEC = Pattern.compile("\"Execution Time\": ([0-9.]+)");
    static final Pattern HIT = Pattern.compile("\"Shared Hit Blocks\": ([0-9]+)");
    static final Pattern READ = Pattern.compile("\"Shared Read Blocks\": ([0-9]+)");

    @Test
    void measure() throws Exception {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        admin.sql("""
                INSERT INTO sigmet (id, fir_id, series_id, hazard, base_ft, top_ft, valid_from, valid_to, geom, raw_text, provider, fetched_at, first_seen, withdrawn_at)
                SELECT 'PERF-' || g, 'F' || (g % 300), 'A' || (g % 50), 'TS', 0, 35000, vf, vf + dur,
                       CASE WHEN g % 20 = 0 THEN NULL ELSE ST_Multi(ST_MakeEnvelope(lon, lat, lon + 3, lat + 2, 4326)) END,
                       'PERF', 'awc', vf, vf,
                       CASE WHEN g % 20 = 1 THEN vf + dur * (0.1 + random() * 0.8) END
                FROM (SELECT g, now() - random() * interval '250 days' vf, (2 + random() * 4) * interval '1 hour' dur,
                             -170 + random() * 330 lon, -60 + random() * 115 lat
                      FROM generate_series(1, :n) g) s""").param("n", ROWS).update();
        admin.sql("VACUUM ANALYZE sigmet").update();
        long total = admin.sql("SELECT count(*) FROM sigmet").query(Long.class).single();

        Instant now = Instant.now();
        List<Instant> ats = List.of(now.minus(Duration.ofMinutes(10)), now.minus(Duration.ofDays(1)), now.minus(Duration.ofDays(7)), now.minus(Duration.ofDays(30)));
        List<Bbox> boxes = List.of(Bbox.world(), new Bbox(120, 30, 135, 42));
        List<String> out = new ArrayList<>();
        out.add(String.format(Locale.ROOT, "sigmet rows %,d — at | bbox | rows | custom plan (ANALYZE): nodes · exec ms · shared hit/read | generic plan nodes | validAt median ms", total));
        OrderedWriter writer = new OrderedWriter(new SimpleMeterRegistry(), 10, 20);
        for (Instant at : ats) {
            for (Bbox b : boxes) {
                PlanCapture analyze = new PlanCapture(DbTestSupport.apiDataSource(), "FROM sigmet WHERE", PlanCapture.Mode.ANALYZE);
                int rows = new SigmetRepository(JdbcClient.create(analyze.dataSource()), DbTestSupport.JSON, writer).validAt(at, b).size();
                String plan = analyze.last();
                PlanCapture generic = new PlanCapture(DbTestSupport.apiDataSource(), "FROM sigmet WHERE", PlanCapture.Mode.GENERIC);
                new SigmetRepository(JdbcClient.create(generic.dataSource()), DbTestSupport.JSON, writer).validAt(at, b);
                SigmetRepository plain = new SigmetRepository(DbTestSupport.apiClient(), DbTestSupport.JSON, writer);
                double ms = median(() -> plain.validAt(at, b));
                String label = Duration.between(at, now).toMinutes() < 60 ? "now-10m" : "now-" + Duration.between(at, now).toDays() + "d";
                out.add(String.format(Locale.ROOT, "%-8s | %s | %4d | %s · %s ms · %s/%s | %s | %.2f", label, b.equals(Bbox.world()) ? "world" : "korea", rows,
                        nodes(plan), first(EXEC, plan), sum(HIT, plan), sum(READ, plan), nodes(generic.last()), ms));
            }
        }
        out.forEach(System.out::println);
        Path p = Path.of("build/perf/sigmet-replay.txt");
        Files.createDirectories(p.getParent());
        Files.write(p, out);
        DbTestSupport.reset();
    }

    static String nodes(String plan) {
        List<String> ns = new ArrayList<>();
        Matcher m = Pattern.compile("\"Node Type\": \"([^\"]+)\"").matcher(plan);
        Matcher idx = Pattern.compile("\"Index Name\": \"([^\"]+)\"").matcher(plan);
        while (m.find()) ns.add(m.group(1));
        List<String> is = new ArrayList<>();
        while (idx.find()) is.add(idx.group(1));
        return String.join(">", ns) + (is.isEmpty() ? "" : " [" + String.join(",", is) + "]");
    }

    static String first(Pattern p, String s) {
        Matcher m = p.matcher(s);
        return m.find() ? m.group(1) : "?";
    }

    static long sum(Pattern p, String s) {
        // 맨 위 노드의 값(자식 합이 들어 있다) — 첫 번째 것
        Matcher m = p.matcher(s);
        return m.find() ? Long.parseLong(m.group(1)) : 0;
    }

    static double median(Runnable r) {
        for (int i = 0; i < 5; i++) r.run();
        double[] t = new double[RUNS];
        for (int i = 0; i < RUNS; i++) {
            long t0 = System.nanoTime();
            r.run();
            t[i] = (System.nanoTime() - t0) / 1e6;
        }
        Arrays.sort(t);
        return t[RUNS / 2];
    }
}
