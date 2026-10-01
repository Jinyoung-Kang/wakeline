package dev.wakeline.coverage;

import dev.wakeline.platform.web.Etags;
import dev.wakeline.platform.web.Meta;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 관측 AIS 수신 범위 REST(계약 v5 §G27 · ADR-027) — GET /api/v1/ships/coverage. 이 서비스가 최근 24 h 에 실제로 받은 선박 위치를 0.5° 칸으로 센 것
 * ({@link ShipCoverage}) — 구독 범위(운영 설정)가 아니다. 메모리에서만 답한다(요청 중 DB · 외부 호출 없음 — ADR-006).
 * <ul>
 *   <li>cells: [lon0, lat0, 크기(°), 선박 수(창 안 서로 다른 MMSI), 위치 수(60 s 창마다 첫 보고), 마지막 수신(ISO — 초로 내림)] — 남 → 북 · 서 → 동.</li>
 *   <li>window: {hours 24, bucket_s 3600, from(지금 시의 시작 − 24 h), to(= generated_at)}. since: 이 시각부터 to 까지 빠짐없이 셌다. covered: full(since = from) ·
 *       partial(기동 때 DB 부트스트랩이 일부만) · since_api_start(부트스트랩 전 · 실패 — api 시작 뒤 셈만). 창 전체인 척하지 않는다.</li>
 *   <li>bootstrap: state(pending · running · done · failed) · hours_loaded / hours_total · rows · loaded_from · error(failed 일 때 종류만) · finished_at ·
 *       missing(창 안의 못 읽은 시 — [{from, to, state(retry · given_up), attempts(읽으려다 실패한 차례 수 — 차례 마감으로 미룬 차례는 세지 않는다), error}],
 *       오래된 것부터, 늘 있다) · retry_backoff_s(다시 읽기 전 기다림 — 고른 값) · next_retry_at · next_retry(다시 읽기를 기다리는 시의 다음 차례 시각과 그 차례가
 *       몇 번째 다시 읽기인지 — 정해졌을 때만, 둘이 함께).</li>
 *   <li>truncated = 메모리 상한 때문에 창 안에서 세지 못한 위치가 있다(dropped_positions) · limits = 그 상한.</li>
 *   <li>meta.fetched_at = min(가장 늦은 마지막 수신, generated_at) — 수집기 시계가 빨라도 stale 로 잘못 보이지 않게(칸의 값은 받은 그대로).</li>
 *   <li>캐시: public, max-age=60 — 스냅숏은 60 s 마다 새로 만든다. ETag = 스냅숏마다 다르다(같은 스냅숏의 If-None-Match → 304, 약한 비교 — {@link Etags}).
 *       요청 제한은 /api/** 공통.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1")
public class ShipCoverageController {
    static final CacheControl CACHE = CacheControl.maxAge(ShipCoverage.SNAPSHOT_MS / 1000, TimeUnit.SECONDS).cachePublic();
    /** meta.stale: 격자 전체에서 가장 늦은 위치가 이보다 오래면(고른 값 — 웹의 선박 STALE 15분과 같다). */
    static final int STALE_AFTER_S = 900;
    static final String NOTE = "관측 수신 — 이 서비스가 받은 AIS 위치의 칸별 집계(구독 범위 아님 · 수신국이 없는 해역은 비어 있다)";
    static final String TIME_ZONE = "all times are UTC ISO-8601; window.from is the start of the current UTC hour minus 24 h";
    /** 다시 읽기 전 기다림(초) — ShipCoverage.RETRY_BACKOFF_MS 그대로(고른 값). */
    static final List<Long> RETRY_BACKOFF_S = ShipCoverage.RETRY_BACKOFF_MS.stream().map(ms -> ms / 1000).toList();

    private final ShipCoverage coverage;
    /** 마지막 스냅숏의 칸 줄(불변) — 스냅숏(ETag)마다 한 번 만든다. 요청마다 다른 것은 meta(request_id · generated_at · lag_s)뿐이다. */
    private volatile Rows rows;

    private record Rows(String etag, List<List<Object>> cells) {}

    public ShipCoverageController(ShipCoverage coverage) {
        this.coverage = coverage;
    }

    @GetMapping("/ships/coverage")
    public ResponseEntity<Map<String, Object>> shipCoverage(HttpServletRequest req) {
        ShipCoverage.Snapshot s = coverage.snapshot();
        if (Etags.notModified(s.etag(), req.getHeader("If-None-Match"))) return ResponseEntity.status(304).eTag(s.etag()).cacheControl(CACHE).build();
        return ResponseEntity.ok().eTag(s.etag()).cacheControl(CACHE).body(body(s, cellRows(s), req));
    }

    /** 스냅숏의 칸 줄 — 같은 스냅숏이면 앞서 만든 것(두 요청이 겹치면 둘 다 만들 수 있다 — 같은 내용이라 괜찮다). */
    List<List<Object>> cellRows(ShipCoverage.Snapshot s) {
        Rows r = rows;
        if (r != null && r.etag().equals(s.etag())) return r.cells();
        List<List<Object>> cells = new ArrayList<>(s.cells().size());
        for (CoverageGrid.CellView c : s.cells())
            cells.add(List.of(c.lon0(), c.lat0(), CoverageGrid.CELL_DEG, c.ships(), c.positions(), seconds(c.lastSeenMs()).toString()));
        List<List<Object>> frozen = List.copyOf(cells);
        rows = new Rows(s.etag(), frozen);
        return frozen;
    }

    static Map<String, Object> body(ShipCoverage.Snapshot s, List<List<Object>> cells, HttpServletRequest req) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("cell_deg", CoverageGrid.CELL_DEG);
        Map<String, Object> window = new LinkedHashMap<>();
        window.put("hours", CoverageGrid.WINDOW_H);
        window.put("bucket_s", CoverageGrid.HOUR_MS / 1000);
        window.put("from", s.windowFrom());
        window.put("to", s.generatedAt());
        m.put("window", window);
        m.put("since", s.since());
        m.put("covered", s.covered());
        m.put("api_started_at", s.apiStartedAt());
        m.put("live_from", s.liveFrom());
        m.put("bootstrap", bootstrap(s.bootstrap()));
        m.put("generated_at", s.generatedAt());
        m.put("cells", cells);
        m.put("cell_count", cells.size());
        m.put("positions", s.positions());
        m.put("truncated", s.dropped() > 0);
        m.put("dropped_positions", s.dropped());
        m.put("limits", Map.of("max_cells", s.maxCells(), "max_ship_cells", s.maxShipCells()));
        m.put("sampling", "first_fix_per_60s");
        m.put("note", NOTE);
        m.put("time_zone", TIME_ZONE);
        // fetched_at = 가장 늦은 마지막 수신 — 수집기 시계가 빨라 스냅숏 시각보다 미래면(5분까지 센다) 스냅숏 시각으로: Meta 는 음수 지연을 '모름'(stale)으로 보므로
        // 가장 새 자료가 오래됐다고 나가지 않게. 칸의 마지막 수신은 받은 그대로다.
        Instant newest = s.newestSeen() == null ? null : seconds(s.newestSeen().toEpochMilli());
        if (newest != null && newest.isAfter(s.generatedAt())) newest = s.generatedAt();
        Map<String, Object> meta = Meta.of(req, s.provider(), newest, STALE_AFTER_S);
        meta.values().removeIf(java.util.Objects::isNull); // 모르는 값은 키가 없다(단독 MockMvc 에서도 같게)
        m.put("meta", meta);
        return m;
    }

    private static Map<String, Object> bootstrap(ShipCoverage.Bootstrap b) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("state", b.state());
        m.put("hours_loaded", b.hoursLoaded());
        m.put("hours_total", b.hoursTotal());
        m.put("rows", b.rows());
        m.put("loaded_from", b.loadedFrom());
        if (b.error() != null) m.put("error", b.error());
        if (b.finishedAt() != null) m.put("finished_at", b.finishedAt());
        List<Map<String, Object>> missing = new ArrayList<>(b.missing().size());
        for (ShipCoverage.Missing x : b.missing()) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("from", x.from());
            e.put("to", x.to());
            e.put("state", x.state());
            e.put("attempts", x.attempts());
            e.put("error", x.error());
            missing.add(e);
        }
        m.put("missing", missing);
        m.put("retry_backoff_s", RETRY_BACKOFF_S);
        if (b.nextRetryAt() != null) {
            m.put("next_retry_at", b.nextRetryAt());
            m.put("next_retry", b.nextRetry());
        }
        return m;
    }

    private static Instant seconds(long ms) { return Instant.ofEpochMilli(ms).truncatedTo(ChronoUnit.SECONDS); }
}
