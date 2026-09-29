package dev.wakeline.it;

import dev.wakeline.demand.DemandLeases;
import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.HotCell;
import dev.wakeline.ingest.SnapshotStore;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 수요 기반 정밀 추적(ADR-013, 계약 v2 §A1·§A3)을 전체 앱 + 실제 ACL Redis(infra/redis/start.sh) 로:
 * <ul>
 *   <li>WS 뷰포트 → api 가 hot 임대를 쓰고(수집기 사용자는 읽기만) → 수집기가 쓴 상태가 demand 메시지로 돌아온다 →
 *       선택 → focus 임대(hot 은 빠짐) → focus 스트림 메시지마다 selected · 항적 저장 → 연결을 닫으면 임대가 곧 빠진다.</li>
 *   <li>수요를 내지 않는 세션: 관심 지역 원 안(covered_by_region) · 줌 &lt; 7 · 항공기 레이어 끔 · 일시정지.</li>
 *   <li>상한: hot 6 셀(세션 수 → 먼저 요청 → 키 순) — 넘는 세션은 throttled, 자리가 나면 다시 임대. 같은 셀은 임대 하나(sessions = 세션 수).</li>
 *   <li>만료: 모든 임대 점수·키 TTL ≤ 60 s(마지막 계산 기준, 주기 계산이 연장), 연결이 끊기면(닫기 프레임 없이도) 곧 빠진다.</li>
 *   <li>병합(DH-2): hex 마다 seen_at 이 가장 최근인 관측 — 같으면 region &gt; focus &gt; hot &gt; global. 결과는 WS diff·selected·REST 로 나간다.</li>
 *   <li>신뢰 경계: 임대 없는 focus 관측은 실시간 상태에 들지 않는다(항적만), requested 밖 hex 는 버린다, 셀 키가 틀린 hot 은 DLQ.</li>
 *   <li>Redis ACL(계약 v2 §C): api 는 wakeline:demand:* 를 쓰고, 수집기는 임대를 읽기만·상태만 쓰고, ais 는 접근 못 한다(ACL DRYRUN).</li>
 * </ul>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class DemandIT extends IntegrationTest {
    /** 대서양 한가운데(어떤 관심 지역 설정과도 겹치지 않는다), 줌 8. */
    static final String SUB = "{\"type\":\"subscribe\",\"bbox\":[-41,39.6,-39,40.4],\"zoom\":8}";
    static final String CELL = HotCell.forViewport(new Bbox(-41, 39.6, -39, 40.4)).key();
    static final String HEX = "a0f001";
    static final String HELLO = "{\"type\":\"hello\",\"proto\":1}";

    @Autowired SnapshotStore snapshots;
    @Autowired MeterRegistry meters;

    WsIT.Client open() throws Exception {
        WsIT.Client c = new WsIT.Client();
        c.ws = HTTP.newWebSocketBuilder().header("Origin", ORIGIN)
                .buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
        return c;
    }

    static Set<String> leased(StringRedisTemplate t, String key) {
        Set<String> s = t.opsForZSet().rangeByScore(key, System.currentTimeMillis(), Double.POSITIVE_INFINITY);
        return s == null ? Set.of() : s;
    }

    /** 조건에 맞는 demand 메시지(그 사이의 다른 메시지는 버린다). */
    static JsonNode nextDemand(WsIT.Client c, java.util.function.Predicate<JsonNode> ok) throws InterruptedException {
        long end = System.nanoTime() + Duration.ofSeconds(15).toNanos();
        while (System.nanoTime() < end) {
            JsonNode n = c.messages.poll(50, TimeUnit.MILLISECONDS);
            if (n != null && "demand".equals(n.path("type").asString()) && ok.test(n)) return n;
        }
        throw new AssertionError("no matching demand message");
    }

    static Map<String, String> focusMessage(Instant fetchedAt, Instant seenAt, double lon) {
        Map<String, Object> st = Streams.state(HEX, 40.0, lon, 36000, seenAt, fetchedAt);
        st.put("provider", "adsb_fi");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("region", null);
        payload.put("requested", List.of(HEX));
        payload.put("missing", List.of());
        payload.put("states", List.of(st));
        return Streams.envelope("aircraft", "focus", "adsb_fi", fetchedAt, payload, 1);
    }

    @Test
    void viewportAndSelectionBecomeLeases_statusFlowsBack_focusObservationsAreSentAndPersisted() throws Exception {
        StringRedisTemplate collector = ItStack.collector();
        ItStack.deleteKeys("wakeline:demand:*");
        WsIT.Client c = open();
        try {
            c.send("{\"type\":\"hello\",\"proto\":1}");
            c.next("welcome");
            c.send(SUB);

            // 1) 핫 리전 임대: api 가 쓰고 수집기 사용자가 읽는다(1 s 모음 뒤)
            await("hot lease", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).contains(CELL));
            JsonNode meta = Streams.JSON.readTree(String.valueOf(collector.opsForHash().get(DemandLeases.HOT_META, CELL)));
            assertThat(meta.path("sessions").asInt()).isEqualTo(1);
            assertThat(meta.path("radius_nm").asInt()).isEqualTo(HotCell.parse(CELL).radiusNm());
            Long ttl = ItStack.admin().getExpire(DemandLeases.HOT, TimeUnit.MILLISECONDS);
            assertThat(ttl).isBetween(1L, 60_000L); // 키 자체도 임대 만료와 함께 사라진다
            JsonNode d = nextDemand(c, n -> n.path("hot").path("cell").asString("").equals(CELL));
            assertThat(d.path("hot").path("state").asString()).isEqualTo("pending");
            // 임대는 api 만 쓴다(수집기 ACL 은 읽기 전용)
            assertThatThrownBy(() -> collector.opsForZSet().add(DemandLeases.HOT, "0.0:0.0:50", 1))
                    .isInstanceOf(DataAccessException.class).hasStackTraceContaining("NOPERM");

            // 2) 수집기가 조회 결과를 보고 → 다음 계산에서 active(주기 포함)
            collector.opsForHash().put(DemandLeases.STATUS, "hot:" + CELL,
                    "{\"state\":\"active\",\"interval_s\":30,\"last_success_at\":\"" + Instant.now() + "\",\"last_error\":null,\"provider\":\"adsb_fi\"}");
            c.send(SUB); // 구독 변화 → 1 s 안에 다시 계산
            JsonNode active = nextDemand(c, n -> "active".equals(n.path("hot").path("state").asString()));
            assertThat(active.path("hot").path("interval_s").asInt()).isEqualTo(30);

            // 3) 선택 → focus 임대, 핫 리전 임대는 빠진다
            c.send("{\"type\":\"select\",\"hex\":\"" + HEX + "\"}");
            await("focus lease", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.FOCUS).contains(HEX) && leased(collector, DemandLeases.HOT).isEmpty());
            JsonNode fd = nextDemand(c, n -> HEX.equals(n.path("focus").path("hex").asString()));
            assertThat(fd.get("hot").isNull()).isTrue();
            assertThat(fd.path("focus").has("since")).isTrue();

            // 4) 수집기의 focus 메시지(5 s 간격) → 관측마다 selected, 항적은 촘촘히 저장
            for (int i = 1; i <= 2; i++) {
                Instant f = Streams.nextFetchedAt();
                Instant seen = f.minusMillis(500);
                Streams.xadd(Streams.AIRCRAFT, focusMessage(f, seen, -40 + 0.02 * i));
                JsonNode sel = c.next("selected");
                while (sel.get("state") == null || sel.get("state").isNull() || !Instant.parse(sel.path("state").path("seen_at").asString()).equals(seen))
                    sel = c.next("selected");
                assertThat(sel.path("state").path("provider").asString()).isEqualTo("adsb_fi");
            }
            await("focus track rows", Duration.ofSeconds(15), () -> count("SELECT count(*) FROM track_point WHERE hex = ?", HEX) >= 2);

            // 5) /status 에 수만(hex·셀 없음)
            JsonNode status = get("/api/v1/status").json();
            assertThat(status.path("demand").has("hot_active")).isTrue();
            assertThat(status.path("demand").has("focus_active")).isTrue();
            assertThat(status.path("demand").has("adsb_fi_rps_1m")).isFalse(); // 수집기 heartbeat 없음 → 모름(null 키는 빠진다)
            assertThat(status.path("demand").toString()).doesNotContain(HEX);
        } finally {
            c.close();
        }
        // 6) 창을 닫으면 임대가 곧 빠진다(60 s 만료를 기다리지 않는다)
        await("leases cleared after close", Duration.ofSeconds(10),
                () -> leased(collector, DemandLeases.FOCUS).isEmpty() && leased(collector, DemandLeases.HOT).isEmpty());
        ItStack.deleteKeys("wakeline:demand:*");
    }

    // =====================================================================================================================
    // 도우미
    // =====================================================================================================================

    /** 연결 → hello → welcome. */
    WsIT.Client hello() throws Exception {
        WsIT.Client c = open();
        c.send(HELLO);
        c.next("welcome");
        return c;
    }

    static String subscribe(Bbox b, int zoom) {
        return "{\"type\":\"subscribe\",\"bbox\":[" + b.lomin() + "," + b.lamin() + "," + b.lomax() + "," + b.lamax() + "],\"zoom\":" + zoom + "}";
    }

    /** 대서양 위 lat 중심의 2°×0.8° 뷰포트(관심 지역 원과 멀다). */
    static Bbox atlantic(double lat) { return new Bbox(-41, lat - 0.4, -39, lat + 0.4); }

    static void closeAll(List<WsIT.Client> cs) { for (WsIT.Client c : cs) c.close(); }

    static JsonNode meta(String key, String member) {
        Object v = ItStack.admin().opsForHash().get(key, member);
        return v == null ? null : Streams.JSON.readTree(v.toString());
    }

    double gauge(String name, String kind) {
        Gauge g = meters.find(name).tag("kind", kind).gauge();
        return g == null ? Double.NaN : g.value();
    }

    double counter(String name) {
        var c = meters.find(name).counter();
        return c == null ? 0 : c.count();
    }

    static Map<String, Object> stateBy(String hex, double lat, double lon, Instant seenAt, Instant fetchedAt, String provider) {
        Map<String, Object> st = Streams.state(hex, lat, lon, 36000, seenAt, fetchedAt);
        st.put("provider", provider);
        return st;
    }

    /** 수집기가 발행하는 focus 메시지(requested = 조회한 hex, missing = 응답에 없던 hex). */
    static Map<String, String> focus(Instant fetchedAt, List<String> requested, List<Map<String, Object>> states) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("region", null);
        payload.put("requested", requested);
        List<String> missing = new ArrayList<>(requested);
        for (Map<String, Object> st : states) missing.remove(String.valueOf(st.get("hex")));
        payload.put("missing", missing);
        payload.put("states", states);
        return Streams.envelope("aircraft", "focus", "adsb_fi", fetchedAt, payload, states.size());
    }

    /** 수집기가 발행하는 hot 메시지(셀 키 + 조회 원). */
    static Map<String, String> hot(String cell, Instant fetchedAt, List<Map<String, Object>> states) {
        Map<String, Object> payload = new LinkedHashMap<>();
        HotCell c = HotCell.parse(cell);
        payload.put("region", c == null ? null : Map.of("lat", c.lat(), "lon", c.lon(), "radius_nm", c.radiusNm()));
        if (cell != null) payload.put("cell", cell);
        payload.put("states", states);
        return Streams.envelope("aircraft", "hot", "adsb_fi", fetchedAt, payload, states.size());
    }

    AircraftState merged(String hex) { return snapshots.view(Instant.now()).states().get(hex); }

    /**
     * 세션 하나의 수신 기록: snapshot 은 seq 1, diff 는 직전 seq + 1(틈 없음)을 받는 즉시 확인하고, 원하는 메시지를 기다린다.
     * 기다리는 동안 받은 모든 메시지는 {@link #seen} 에 남는다(없어야 할 것을 나중에 확인).
     */
    static final class Feed {
        final WsIT.Client c;
        final List<JsonNode> seen = new ArrayList<>();
        int lastSeq;

        Feed(WsIT.Client c) { this.c = c; }

        private void track(JsonNode n) {
            seen.add(n);
            String t = n.path("type").asString();
            if ("snapshot".equals(t)) {
                assertThat(n.path("seq").asInt()).as("snapshot seq").isEqualTo(1);
                lastSeq = 1;
            } else if ("diff".equals(t)) {
                assertThat(lastSeq).as("diff before any snapshot").isPositive();
                assertThat(n.path("seq").asInt()).as("diff seq contiguous").isEqualTo(lastSeq + 1);
                assertThat(n.path("upsert").size() + n.path("remove").size()).as("no empty diffs").isPositive();
                lastSeq = n.path("seq").asInt();
            }
        }

        /** 조건을 모두 만족하는 메시지들을 기다린다(순서 무관). @return 조건별로 처음 맞은 메시지 */
        @SafeVarargs
        final List<JsonNode> await(Duration timeout, Predicate<JsonNode>... wants) throws InterruptedException {
            JsonNode[] got = new JsonNode[wants.length];
            int left = wants.length;
            long end = System.nanoTime() + timeout.toNanos();
            while (left > 0 && System.nanoTime() < end) {
                JsonNode n = c.messages.poll(50, TimeUnit.MILLISECONDS);
                if (n == null) continue;
                track(n);
                for (int i = 0; i < wants.length; i++) if (got[i] == null && wants[i].test(n)) { got[i] = n; left--; }
            }
            if (left > 0) throw new AssertionError(left + " expected message(s) not received within " + timeout + "; got types "
                    + seen.stream().map(x -> x.path("type").asString()).toList());
            return List.of(got);
        }

        /** 받은 메시지 전부를 기록만 한다(window 동안). */
        void drain(Duration window) throws InterruptedException {
            long end = System.nanoTime() + window.toNanos();
            while (System.nanoTime() < end) {
                JsonNode n = c.messages.poll(50, TimeUnit.MILLISECONDS);
                if (n != null) track(n);
            }
        }
    }

    /** snapshot 의 aircraft 또는 diff 의 upsert 에 이 hex 가 있고 조건을 만족한다. */
    static Predicate<JsonNode> carries(String hex, Predicate<JsonNode> ok) {
        return n -> {
            String t = n.path("type").asString();
            JsonNode arr = "snapshot".equals(t) ? n.path("aircraft") : "diff".equals(t) ? n.path("upsert") : null;
            if (arr == null) return false;
            for (JsonNode a : arr) if (hex.equals(a.path("hex").asString()) && ok.test(a)) return true;
            return false;
        };
    }

    static Predicate<JsonNode> selected(String hex, Instant seenAt) {
        return n -> "selected".equals(n.path("type").asString()) && hex.equals(n.path("hex").asString())
                && n.path("state").isObject() && seenAt.equals(Instant.parse(n.path("state").path("seen_at").asString()));
    }

    static Predicate<JsonNode> demand(Predicate<JsonNode> ok) {
        return n -> "demand".equals(n.path("type").asString()) && ok.test(n);
    }

    // =====================================================================================================================
    // 수요를 내지 않는 세션
    // =====================================================================================================================

    /**
     * 계약 v2 §A1: 관심 지역 원 안 줌 ≥ 7 → covered_by_region(임대 없음), 줌 &lt; 7 → 수요 없음(hot null), 원 밖 줌 ≥ 7 → hot 임대.
     * 항공기 레이어를 끄거나 일시정지하면 그 임대가 빠지고, 다시 켜거나 resume 하면 돌아온다(모두 1 s 모음 뒤, 60 s 만료를 기다리지 않는다).
     */
    @Test
    void sessionsThatDoNotNeedAHotRegionWriteNoLease() throws Exception {
        StringRedisTemplate collector = ItStack.collector();
        WsIT.Client c = hello();
        try {
            // 관심 지역(36.5, 127.8, 250 NM) 중심의 줌 8 화면
            c.send(subscribe(new Bbox(127.3, 36.1, 128.3, 36.9), 8));
            JsonNode covered = nextDemand(c, n -> "covered_by_region".equals(n.path("hot").path("state").asString()));
            assertThat(covered.path("hot").has("cell")).as("covered_by_region names no cell").isFalse();
            assertThat(covered.path("hot").has("interval_s")).as("no cadence the api does not know").isFalse();
            assertThat(covered.get("focus").isNull()).isTrue();
            assertThat(leased(collector, DemandLeases.HOT)).isEmpty();

            // 원 밖이지만 줌 6 → 수요 없음
            c.send(subscribe(atlantic(40), 6));
            JsonNode none = nextDemand(c, n -> n.get("hot") != null && n.get("hot").isNull());
            assertThat(none.get("focus").isNull()).isTrue();
            assertThat(leased(collector, DemandLeases.HOT)).isEmpty();

            // 원 밖 줌 8 → 임대
            String cell = HotCell.forViewport(atlantic(40)).key();
            c.send(subscribe(atlantic(40), 8));
            await("hot lease", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).equals(Set.of(cell)));

            // 항공기 레이어 끔 → 핫 리전 호출을 쓰지 않는다
            c.send("{\"type\":\"layers\",\"aircraft\":false}");
            await("lease dropped with the aircraft layer", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).isEmpty());
            c.send("{\"type\":\"layers\",\"aircraft\":true}");
            await("lease back with the aircraft layer", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).equals(Set.of(cell)));

            // 일시정지(탭 숨김) → 수요 없음, resume → 다시
            c.send("{\"type\":\"pause\"}");
            await("lease dropped while paused", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).isEmpty());
            c.send("{\"type\":\"resume\"}");
            await("lease back after resume", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).equals(Set.of(cell)));
        } finally {
            c.close();
        }
        await("leases cleared after close", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).isEmpty());
    }

    // =====================================================================================================================
    // 상한
    // =====================================================================================================================

    /**
     * 계약 v2 §A1 상한 6 셀을 실제 세션 8개로: 서로 다른 셀 7개(C1..C7, 키 순서 = 위도 순) 중 C7 은 세션 2개가 본다.
     * 순위는 세션 수 → 먼저 요청 → 키 순이라, 구독이 몇 번의 계산에 걸쳐 들어오든 최종 임대는 {C1..C5, C7}(C7 sessions = 2)이고
     * C6 세션은 throttled(주기 없음)를 받는다. C1 세션이 나가면 C6 가 자리를 얻어 pending 이 된다.
     */
    @Test
    void hotLeasesAreCappedAtSixCells_sharedCellsCountTheirSessions_overCapSessionsAreThrottled() throws Exception {
        StringRedisTemplate collector = ItStack.collector();
        List<String> cells = new ArrayList<>();
        for (int i = 0; i < 7; i++) cells.add(HotCell.forViewport(atlantic(30 + 2 * i)).key());
        assertThat(cells).as("keys sort in latitude order").isSorted().doesNotHaveDuplicates();
        List<WsIT.Client> cs = new ArrayList<>();
        try {
            for (int i = 0; i < 8; i++) cs.add(hello());
            // C1..C6 먼저, 같은 셀(C7)을 보는 두 세션은 마지막 — 순위가 '먼저 요청' 이 아니라 '세션 수' 로 C7 을 올린다
            for (int i = 0; i < 6; i++) cs.get(i).send(subscribe(atlantic(30 + 2 * i), 8));
            cs.get(6).send(subscribe(atlantic(42), 8));
            cs.get(7).send(subscribe(atlantic(42), 8));

            Set<String> expected = Set.of(cells.get(0), cells.get(1), cells.get(2), cells.get(3), cells.get(4), cells.get(6));
            await("six leases incl. the shared cell", Duration.ofSeconds(15), () -> {
                JsonNode m = meta(DemandLeases.HOT_META, cells.get(6));
                return leased(collector, DemandLeases.HOT).equals(expected) && m != null && m.path("sessions").asInt() == 2;
            });
            assertThat(ItStack.admin().opsForHash().keys(DemandLeases.HOT_META)).as("meta only for leased cells")
                    .isEqualTo(Set.copyOf(expected));
            JsonNode throttled = nextDemand(cs.get(5), n -> "throttled".equals(n.path("hot").path("state").asString()));
            assertThat(throttled.path("hot").path("cell").asString()).isEqualTo(cells.get(5));
            assertThat(throttled.path("hot").has("interval_s")).as("over the cap: no cadence").isFalse();
            assertThat(throttled.path("hot").has("last_success_at")).isFalse();
            for (int i : new int[]{6, 7}) {
                JsonNode d = nextDemand(cs.get(i), n -> cells.get(6).equals(n.path("hot").path("cell").asString()));
                assertThat(d.path("hot").path("state").asString()).as("leased, no collector report yet").isEqualTo("pending");
            }
            await("gauges", Duration.ofSeconds(12), () -> gauge("wakeline_demand_wanted", "hot") == 7 && gauge("wakeline_demand_leases", "hot") == 6);

            // 자리가 나면(C1 세션 종료) 대기하던 C6 가 임대를 얻는다
            cs.getFirst().close();
            await("C6 promoted", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT)
                    .equals(Set.of(cells.get(1), cells.get(2), cells.get(3), cells.get(4), cells.get(5), cells.get(6))));
            nextDemand(cs.get(5), n -> cells.get(5).equals(n.path("hot").path("cell").asString()) && "pending".equals(n.path("hot").path("state").asString()));
        } finally {
            closeAll(cs);
        }
        await("leases cleared", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).isEmpty());
    }

    // =====================================================================================================================
    // 만료
    // =====================================================================================================================

    /**
     * 임대 만료(계약 v2 §A1, ADR-013 "최대 60 s"): 모든 임대의 점수(만료 epoch ms)와 키 TTL 이 마지막 계산 + 60 s 이내 — api 가 멈추면 수집기
     * (ZRANGEBYSCORE now +inf)는 60 s 안에 호출을 멈춘다. 세션이 살아 있는 동안은 10 s 주기 계산이 만료를 연장한다.
     * 닫기 프레임 없이 연결이 끊겨도(abort) 다음 계산(≈ 1 s)에서 임대와 키가 사라진다.
     */
    @Test
    void everyLeaseExpiresWithinSixtySeconds_isRenewedWhileWatched_andDisappearsOnAbruptDisconnect() throws Exception {
        StringRedisTemplate collector = ItStack.collector();
        StringRedisTemplate admin = ItStack.admin();
        String hex = "a0f0e1";
        String cell = HotCell.forViewport(atlantic(40)).key();
        WsIT.Client h = hello(), f = hello();
        try {
            h.send(subscribe(atlantic(40), 8));
            f.send(subscribe(new Bbox(124, 33, 132, 39), 7));
            f.send("{\"type\":\"select\",\"hex\":\"" + hex + "\"}");
            await("both leases", Duration.ofSeconds(10), () -> leased(collector, DemandLeases.HOT).contains(cell) && leased(collector, DemandLeases.FOCUS).contains(hex));

            long now = System.currentTimeMillis();
            Double hotScore = ItStack.admin().opsForZSet().score(DemandLeases.HOT, cell);
            Double focusScore = ItStack.admin().opsForZSet().score(DemandLeases.FOCUS, hex);
            assertThat(hotScore).isNotNull();
            assertThat(focusScore).isNotNull();
            assertThat(hotScore.longValue() - now).as("hot lease expiry").isBetween(1L, 60_000L);
            assertThat(focusScore.longValue() - now).as("focus lease expiry").isBetween(1L, 60_000L);
            // 키 만료는 api 시계로 잰 남은 시간(PEXPIRE)이라 Redis 시계와의 차이와 상관없이 60 s 이하다(전에는 PEXPIREAT 라 Docker VM 시계가
            // 호스트보다 늦으면 PTTL 60,012 처럼 넘었다 — RedisDemandLeasesIT)
            for (String key : List.of(DemandLeases.HOT, DemandLeases.HOT_META, DemandLeases.FOCUS, DemandLeases.FOCUS_META)) {
                Long ttl = admin.getExpire(key, TimeUnit.MILLISECONDS);
                assertThat(ttl).as("PTTL of " + key).isBetween(1L, 60_000L);
            }
            JsonNode fm = meta(DemandLeases.FOCUS_META, hex);
            assertThat(fm.path("sessions").asInt()).isEqualTo(1);
            assertThat(Instant.parse(fm.path("first_at").asString())).isBeforeOrEqualTo(Instant.now());
            JsonNode hm = meta(DemandLeases.HOT_META, cell);
            assertThat(hm.path("lat").asDouble()).isEqualTo(40.0);
            assertThat(hm.path("lon").asDouble()).isEqualTo(-40.0);

            // 보는 동안은 주기 계산(10 s)이 만료를 연장한다 — 여전히 now + 60 s 이내
            await("lease renewed by the periodic refresh", Duration.ofSeconds(15), () -> {
                Double s2 = ItStack.admin().opsForZSet().score(DemandLeases.HOT, cell);
                return s2 != null && s2 > hotScore;
            });
            Set<ZSetOperations.TypedTuple<String>> all = ItStack.admin().opsForZSet().rangeWithScores(DemandLeases.HOT, 0, -1);
            assertThat(all).allSatisfy(t -> assertThat(t.getScore().longValue() - System.currentTimeMillis()).isBetween(1L, 60_000L));
        } finally {
            h.ws.abort(); // 닫기 프레임 없이 끊는다(브라우저 종료·네트워크 단절)
            f.ws.abort();
        }
        await("leases and keys gone after an abrupt disconnect", Duration.ofSeconds(10), () ->
                leased(collector, DemandLeases.HOT).isEmpty() && leased(collector, DemandLeases.FOCUS).isEmpty()
                        && !Boolean.TRUE.equals(admin.hasKey(DemandLeases.HOT)) && !Boolean.TRUE.equals(admin.hasKey(DemandLeases.FOCUS))
                        && !Boolean.TRUE.equals(admin.hasKey(DemandLeases.HOT_META)) && !Boolean.TRUE.equals(admin.hasKey(DemandLeases.FOCUS_META)));
    }

    // =====================================================================================================================
    // 병합 · 푸시
    // =====================================================================================================================

    /**
     * DH-2 · 계약 v2 §A3 끝에서 끝까지(스트림 → SnapshotStore → WS · REST):
     * <ol>
     *   <li>region 이 오래된 관측(T0)을 가진 X 를 선택 → focus 관측(T1 &gt; T0)이 이긴다: diff upsert(adsb_fi) · selected · REST 모두 focus.</li>
     *   <li>더 새 region 메시지가 X 의 <b>더 오래된</b> 관측을 실어 와도 focus 가 남는다(이전에는 region 이 무조건 이겼다). 같은 메시지의 Z 는 갱신.</li>
     *   <li>region 이 더 새 관측(T2)을 싣고 오면 region 이 이긴다. focus 가 같은 seen_at(T2)을 보내도 동률 → region.</li>
     *   <li>수집기가 focus 상태를 active 로 보고하면 demand 가 active · 5 s 주기(수집기가 보고한 값)로 바뀐다.</li>
     * </ol>
     */
    @Test
    void focusObservationsWinByFreshness_andArePushedAsDiffSelectedAndDemand() throws Exception {
        String x = "a0f101", z = "a0f102";
        Instant base = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        Instant t0 = base.minusSeconds(60), t1 = base.minusSeconds(20), t2 = base.minusSeconds(19);
        Instant fr = Streams.nextFetchedAt();
        Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", fr, List.of(Streams.state(x, 36.00, 128.00, 34000, t0, fr),
                Streams.state(z, 35.00, 127.00, 30000, t0, fr))));
        await("region", Duration.ofSeconds(10), () -> snapshots.region().fetchedAt().equals(fr));

        WsIT.Client c = hello();
        Feed feed = new Feed(c);
        try {
            c.send(subscribe(new Bbox(124, 33, 132, 39), 7));
            feed.await(Duration.ofSeconds(10), carries(x, a -> "fixture".equals(a.path("provider").asString())));
            c.send("{\"type\":\"select\",\"hex\":\"" + x + "\"}");
            await("focus lease known to the snapshot store", Duration.ofSeconds(10), () -> {
                Set<String> l = snapshots.view(Instant.now()).scopes().focusLeased();
                return l != null && l.contains(x);
            });
            JsonNode pending = feed.await(Duration.ofSeconds(10), demand(n -> x.equals(n.path("focus").path("hex").asString()))).getFirst();
            assertThat(pending.path("focus").path("state").asString()).isEqualTo("pending");
            assertThat(pending.path("focus").has("interval_s")).as("pending never states a cadence").isFalse();
            assertThat(pending.get("hot").isNull()).as("a selecting session asks for no hot region").isTrue();

            // 1) focus(T1) > region(T0)
            Instant f1 = Streams.nextFetchedAt();
            Streams.xadd(Streams.AIRCRAFT, focus(f1, List.of(x), List.of(stateBy(x, 36.10, 128.10, t1, f1, "adsb_fi"))));
            List<JsonNode> got = feed.await(Duration.ofSeconds(10),
                    carries(x, a -> "adsb_fi".equals(a.path("provider").asString()) && a.path("lat").asDouble() == 36.10),
                    selected(x, t1));
            assertThat(got.get(1).path("state").path("provider").asString()).isEqualTo("adsb_fi");
            assertThat(snapshots.view(Instant.now()).scopeOf(x)).isEqualTo(SnapshotStore.FOCUS);
            JsonNode rest = get("/api/v1/aircraft/" + x).json();
            assertThat(rest.path("state").path("provider").asString()).isEqualTo("adsb_fi");
            assertThat(rest.path("state").path("lat").asDouble()).isEqualTo(36.10);

            // 2) 더 새 region 메시지 · X 는 더 오래된 관측 → focus 유지, Z 만 갱신
            Instant fr2 = Streams.nextFetchedAt();
            Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", fr2, List.of(Streams.state(x, 36.05, 128.05, 34000, t1.minusSeconds(10), fr2),
                    Streams.state(z, 35.10, 127.00, 30000, base.minusSeconds(5), fr2))));
            JsonNode zDiff = feed.await(Duration.ofSeconds(10), carries(z, a -> a.path("lat").asDouble() == 35.10)).getFirst();
            for (JsonNode u : zDiff.path("upsert")) assertThat(u.path("hex").asString()).as("X must not flip back to the older region fix").isNotEqualTo(x);
            assertThat(merged(x).provider()).isEqualTo("adsb_fi");
            assertThat(merged(x).lat()).isEqualTo(36.10);
            assertThat(get("/api/v1/aircraft/" + x).json().path("state").path("provider").asString()).isEqualTo("adsb_fi");

            // 3) region 이 더 새 관측(T2) → region
            Instant fr3 = Streams.nextFetchedAt();
            Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", fr3, List.of(Streams.state(x, 36.20, 128.20, 34000, t2, fr3),
                    Streams.state(z, 35.10, 127.00, 30000, base.minusSeconds(5), fr3))));
            feed.await(Duration.ofSeconds(10), carries(x, a -> "fixture".equals(a.path("provider").asString()) && a.path("lat").asDouble() == 36.20));
            assertThat(snapshots.view(Instant.now()).scopeOf(x)).isEqualTo(SnapshotStore.REGION);
            //    같은 seen_at 의 focus 관측 → 받아들이지만(focus 스코프) 병합은 동률 규칙으로 region
            Instant f2 = Streams.nextFetchedAt();
            Streams.xadd(Streams.AIRCRAFT, focus(f2, List.of(x), List.of(stateBy(x, 36.30, 128.30, t2, f2, "adsb_fi"))));
            await("focus scope took the tied observation", Duration.ofSeconds(10), () -> {
                SnapshotStore.FocusObs o = snapshots.focus().get(x);
                return o != null && o.fetchedAt().equals(f2);
            });
            assertThat(merged(x).provider()).as("tie → region > focus").isEqualTo("fixture");
            assertThat(merged(x).lat()).isEqualTo(36.20);
            JsonNode tie = get("/api/v1/aircraft/" + x).json();
            assertThat(tie.path("state").path("provider").asString()).isEqualTo("fixture");
            assertThat(tie.path("state").path("lat").asDouble()).isEqualTo(36.20);

            // 4) 수집기 보고 → demand active + 수집기가 보고한 주기
            ItStack.collector().opsForHash().put(DemandLeases.STATUS, "focus:" + x,
                    "{\"state\":\"active\",\"interval_s\":5,\"last_success_at\":\"" + Instant.now() + "\",\"last_error\":null,\"provider\":\"adsb_fi\"}");
            JsonNode active = feed.await(Duration.ofSeconds(15), demand(n -> "active".equals(n.path("focus").path("state").asString()))).getFirst();
            assertThat(active.path("focus").path("interval_s").asInt()).isEqualTo(5);
            assertThat(active.path("focus").path("hex").asString()).isEqualTo(x);
            assertThat(active.toString()).as("internal collector error text never reaches browsers").doesNotContain("last_error");
        } finally {
            c.close();
            ItStack.collector().opsForHash().delete(DemandLeases.STATUS, "focus:" + x);
        }
        // 선택한 세션이 떠나면 focus 임대와 함께 focus 관측도 병합 뷰에서 빠진다
        await("focus observation dropped with its lease", Duration.ofSeconds(10), () -> !snapshots.focus().containsKey(x));
    }

    /**
     * hot 메시지(계약 v2 §A3): 셀을 보는 세션에 diff 로 간다(provider adsb_fi). global 이 같은 seen_at 을 실어 오면 동률 → hot,
     * 더 새 관측을 실어 오면 global 이 이긴다(diff 로 바로 반영).
     */
    @Test
    void hotObservationsReachTheSessionWatchingTheCell_andTiesBeatGlobal() throws Exception {
        String y = "a0f103";
        String cell = HotCell.forViewport(atlantic(40)).key();
        Instant th = Instant.now().truncatedTo(ChronoUnit.MILLIS).minusSeconds(8);
        WsIT.Client c = hello();
        Feed feed = new Feed(c);
        try {
            c.send(subscribe(atlantic(40), 8));
            feed.await(Duration.ofSeconds(10), n -> "snapshot".equals(n.path("type").asString()));
            await("hot lease", Duration.ofSeconds(10), () -> leased(ItStack.collector(), DemandLeases.HOT).contains(cell));

            Instant f = Streams.nextFetchedAt();
            Streams.xadd(Streams.AIRCRAFT, hot(cell, f, List.of(stateBy(y, 40.0, -40.0, th, f, "adsb_fi"))));
            feed.await(Duration.ofSeconds(10), carries(y, a -> "adsb_fi".equals(a.path("provider").asString())));
            assertThat(snapshots.view(Instant.now()).sourceOf(y)).isEqualTo("hot:" + cell);
            assertThat(get("/api/v1/aircraft/" + y).json().path("state").path("provider").asString()).isEqualTo("adsb_fi");

            // global 동률 → hot 유지
            Instant g1 = Streams.nextFetchedAt();
            Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("global", g1, List.of(Streams.state(y, 40.2, -40.2, 36000, th, g1))));
            await("global applied", Duration.ofSeconds(10), () -> snapshots.global().fetchedAt().equals(g1));
            assertThat(merged(y).provider()).as("tie → hot > global").isEqualTo("adsb_fi");
            assertThat(merged(y).lat()).isEqualTo(40.0);

            // global 이 더 새 관측 → global
            Instant g2 = Streams.nextFetchedAt();
            Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("global", g2, List.of(Streams.state(y, 40.3, -40.3, 36000, th.plusSeconds(2), g2))));
            feed.await(Duration.ofSeconds(10), carries(y, a -> "fixture".equals(a.path("provider").asString()) && a.path("lat").asDouble() == 40.3));
            JsonNode rest = get("/api/v1/aircraft/" + y).json();
            assertThat(rest.path("state").path("provider").asString()).isEqualTo("fixture");
        } finally {
            c.close();
        }
    }

    /**
     * 신뢰 경계(계약 v2 §A3): 임대에 없는 hex 의 focus 관측은 실시간 상태에 들지 않고 항적(이력)으로만 간다. requested 에 없는 hex 는
     * 아예 버리고 센다(wakeline_focus_unrequested_total). 셀 키가 없거나 범위를 벗어난 hot 메시지는 DLQ(반영·저장 없음).
     */
    @Test
    void unleasedFocusIsHistoryOnly_unrequestedIsDropped_andHotWithoutAValidCellIsDeadLettered() throws Exception {
        await("demand leases known to the snapshot store", Duration.ofSeconds(15), () -> snapshots.view(Instant.now()).scopes().focusLeased() != null);
        String w = "a0f1a1", v = "a0f1a2";
        assertThat(snapshots.view(Instant.now()).scopes().focusLeased()).doesNotContain(w);
        double unrequestedBefore = counter("wakeline_focus_unrequested_total");
        Instant f = Streams.nextFetchedAt();
        Instant seen = f.minusSeconds(2);
        Streams.xadd(Streams.AIRCRAFT, focus(f, List.of(w), List.of(stateBy(w, 10.0, 10.0, seen, f, "adsb_fi"), stateBy(v, 10.1, 10.1, seen, f, "adsb_fi"))));
        await("history row for the unleased hex", Duration.ofSeconds(15), () -> count("SELECT count(*) FROM track_point WHERE hex = ?", w) == 1);
        assertThat(merged(w)).as("not in the live view").isNull();
        assertThat(merged(v)).isNull();
        assertThat(count("SELECT count(*) FROM track_point WHERE hex = ?", v)).as("unrequested hex is not stored").isZero();
        assertThat(counter("wakeline_focus_unrequested_total")).isEqualTo(unrequestedBefore + 1);

        String h1 = "a0f1b1", h2 = "a0f1b2";
        Instant fh = Streams.nextFetchedAt();
        String noCell = Streams.xadd(Streams.AIRCRAFT, hot(null, fh, List.of(stateBy(h1, 20.0, 20.0, fh, fh, "adsb_fi"))));
        Instant fh2 = Streams.nextFetchedAt();
        String badCell = Streams.xadd(Streams.AIRCRAFT, hot("86.0:0.0:50", fh2, List.of(stateBy(h2, 20.0, 20.0, fh2, fh2, "adsb_fi"))));
        await("both dead-lettered", Duration.ofSeconds(15), () -> {
            var dlq = ItStack.admin().opsForStream().range(Streams.DLQ, Range.unbounded());
            if (dlq == null) return false;
            Set<String> ids = new java.util.HashSet<>();
            for (var r : dlq) ids.add(String.valueOf(r.getValue().get("source_id")));
            return ids.contains(noCell) && ids.contains(badCell);
        });
        assertThat(merged(h1)).isNull();
        assertThat(merged(h2)).isNull();
        assertThat(count("SELECT count(*) FROM track_point WHERE hex IN (?, ?)", h1, h2)).isZero();
    }

    // =====================================================================================================================
    // Redis ACL
    // =====================================================================================================================

    /**
     * ACL DRYRUN(관리 사용자): 명령을 실행하지 않고 그 사용자의 권한만 검사한다 — 앱이 쓰는 실제 키에 부작용이 없다. OK 또는 거절 사유.
     * redis.conf 가 없앤 명령(rename-command FLUSHALL "" 등)은 DRYRUN 자체가 오류 — 그 경우도 거절로 본다(오류 문구를 돌려준다).
     */
    static String dryRun(String user, String... command) {
        byte[][] args = new byte[command.length + 2][];
        args[0] = "DRYRUN".getBytes(StandardCharsets.UTF_8);
        args[1] = user.getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i < command.length; i++) args[i + 2] = command[i].getBytes(StandardCharsets.UTF_8);
        try {
            return ItStack.admin().execute((RedisCallback<String>) conn -> {
                Object r = conn.execute("ACL", args);
                return r instanceof byte[] b ? new String(b, StandardCharsets.UTF_8) : String.valueOf(r);
            });
        } catch (DataAccessException e) {
            Throwable root = e;
            while (root.getCause() != null && root.getCause() != root) root = root.getCause();
            assertThat(root.getMessage()).as("only a disabled command may fail the dry run").contains("not found");
            return root.getMessage();
        }
    }

    static final String LUA = "redis.call('DEL', KEYS[1]) return 1";

    /**
     * 계약 v2 §C(실제 infra/redis/start.sh): api(wakeline_api)는 수요 키 다섯 개 모두 쓰고(임대 교체 Lua 포함) 읽는다.
     * 수집기(wakeline_collector)는 임대 네 키를 읽기만 하고 상태 해시만 쓴다 — 목록 밖 wakeline:demand:* 키는 못 건드린다.
     * ais(wakeline_ais)는 수요 키에 접근하지 못한다. 위험 명령은 모두 거절.
     */
    @Test
    void redisAcl_apiOwnsDemandKeys_collectorReadsLeasesAndWritesStatus_aisHasNoAccess() {
        List<String> leaseKeys = List.of(DemandLeases.HOT, DemandLeases.HOT_META, DemandLeases.FOCUS, DemandLeases.FOCUS_META);
        List<String[]> apiAllowed = new ArrayList<>();
        for (String k : List.of(DemandLeases.HOT, DemandLeases.FOCUS)) {
            apiAllowed.add(new String[]{"ZADD", k, "1", "m"});
            apiAllowed.add(new String[]{"ZREMRANGEBYSCORE", k, "-inf", "1"});
            apiAllowed.add(new String[]{"ZRANGEBYSCORE", k, "0", "+inf"});
            apiAllowed.add(new String[]{"PEXPIRE", k, "60000"}); // 교체 Lua 의 키 만료(남은 시간 — RedisDemandLeases)
        }
        for (String k : List.of(DemandLeases.HOT_META, DemandLeases.FOCUS_META)) {
            apiAllowed.add(new String[]{"HSET", k, "m", "{}"});
            apiAllowed.add(new String[]{"HDEL", k, "m"});
        }
        apiAllowed.add(new String[]{"DEL", DemandLeases.HOT, DemandLeases.HOT_META, DemandLeases.FOCUS, DemandLeases.FOCUS_META});
        apiAllowed.add(new String[]{"HMGET", DemandLeases.STATUS, "hot:40.0:-40.0:100", "focus:a0f001"});
        apiAllowed.add(new String[]{"EVAL", LUA, "4", DemandLeases.HOT, DemandLeases.HOT_META, DemandLeases.FOCUS, DemandLeases.FOCUS_META});
        apiAllowed.add(new String[]{"EVALSHA", "0000000000000000000000000000000000000000", "4", DemandLeases.HOT, DemandLeases.HOT_META,
                DemandLeases.FOCUS, DemandLeases.FOCUS_META});
        for (String[] cmd : apiAllowed) assertThat(dryRun("wakeline_api", cmd)).as("wakeline_api " + String.join(" ", cmd)).isEqualTo("OK");
        for (String[] cmd : List.of(new String[]{"KEYS", "*"}, new String[]{"FLUSHALL"}, new String[]{"CONFIG", "GET", "maxmemory"},
                new String[]{"ZADD", "budget:demand", "1", "m"}, new String[]{"EVAL", LUA, "1", "budget:x"}))
            assertThat(dryRun("wakeline_api", cmd)).as("wakeline_api " + String.join(" ", cmd)).isNotEqualTo("OK");

        // 수집기: 임대는 읽기만(%R~), 상태만 쓰기
        for (String[] cmd : List.of(new String[]{"ZRANGEBYSCORE", DemandLeases.HOT, "0", "+inf"}, new String[]{"ZRANGEBYSCORE", DemandLeases.FOCUS, "0", "+inf"},
                new String[]{"HGETALL", DemandLeases.HOT_META}, new String[]{"HMGET", DemandLeases.FOCUS_META, "a0f001"},
                new String[]{"HSET", DemandLeases.STATUS, "focus:a0f001", "{}"}, new String[]{"HDEL", DemandLeases.STATUS, "focus:a0f001"},
                new String[]{"HGETALL", DemandLeases.STATUS}))
            assertThat(dryRun("wakeline_collector", cmd)).as("wakeline_collector " + String.join(" ", cmd)).isEqualTo("OK");
        List<String[]> collectorDenied = new ArrayList<>();
        for (String k : leaseKeys) {
            collectorDenied.add(new String[]{"DEL", k});
            collectorDenied.add(new String[]{"PEXPIRE", k, "1"});
        }
        collectorDenied.add(new String[]{"ZADD", DemandLeases.HOT, "1", "0.0:0.0:50"});
        collectorDenied.add(new String[]{"ZREM", DemandLeases.FOCUS, "a0f001"});
        collectorDenied.add(new String[]{"HSET", DemandLeases.HOT_META, "0.0:0.0:50", "{}"});
        collectorDenied.add(new String[]{"HSET", "wakeline:demand:other", "f", "v"});
        collectorDenied.add(new String[]{"EVAL", LUA, "1", DemandLeases.HOT});
        for (String[] cmd : collectorDenied)
            assertThat(dryRun("wakeline_collector", cmd)).as("wakeline_collector " + String.join(" ", cmd)).isNotEqualTo("OK");

        // ais: 수요 키 없음
        for (String k : List.of(DemandLeases.HOT, DemandLeases.FOCUS))
            assertThat(dryRun("wakeline_ais", "ZRANGEBYSCORE", k, "0", "+inf")).as("wakeline_ais read " + k).isNotEqualTo("OK");
        assertThat(dryRun("wakeline_ais", "HGETALL", DemandLeases.STATUS)).isNotEqualTo("OK");
        assertThat(dryRun("wakeline_ais", "HSET", DemandLeases.STATUS, "focus:a0f001", "{}")).isNotEqualTo("OK");

        // 실제 연결로도 한 번(DRYRUN 과 실제 판정이 같다): api 는 상태를 읽고, 수집기는 임대를 못 지운다
        assertThat(ItStack.apiUser().opsForHash().multiGet(DemandLeases.STATUS, List.of("focus:ffffff"))).containsExactly((Object) null);
        assertThatThrownBy(() -> ItStack.collector().delete(DemandLeases.FOCUS_META)).isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("NOPERM");
    }
}
