package dev.wakeline.ws;

import dev.wakeline.demand.DemandLeases;
import dev.wakeline.demand.DemandStats;
import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.domain.HotCell;
import dev.wakeline.ships.core.ShipStatic;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.settings.RegionSettings;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.atomic.AtomicLong;

import static dev.wakeline.ws.WsTestKit.ofType;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 수요 계산(계약 v2 §A1·§A3): 세션 → focus/hot/covered 규칙, 셀 공유, 상한(6·50)과 순위, 30분 상한, 임대 교체(원자·만료 60 s),
 * 수집기 상태 → 화면 상태, demand 메시지(바뀌면·30 s 마다), 1 s 모음, 종료 시 임대 비우기, 오류 격리.
 */
class DemandServiceTest {
    /** 도쿄 부근(관심 지역 원 밖) 뷰포트 — 줌 9. */
    static final String TOKYO = "{\"type\":\"subscribe\",\"bbox\":[139.2,35.2,140.2,35.9],\"zoom\":9}";
    static final String TOKYO_CELL = HotCell.forViewport(new dev.wakeline.geo.Bbox(139.2, 35.2, 140.2, 35.9)).key();
    /** 관심 지역(한반도 원) 안 — 줌 8. */
    static final String SEOUL = "{\"type\":\"subscribe\",\"bbox\":[126.5,37.2,127.5,37.8],\"zoom\":8}";

    /** 기록하는 임대 저장소. status 는 테스트가 채운다. */
    static final class FakeLeases implements DemandLeases {
        record Call(List<Lease> hot, List<Lease> focus, long expiresAtMs) {}
        final List<Call> calls = new CopyOnWriteArrayList<>();
        final Map<String, String> status = new HashMap<>();
        volatile RuntimeException failReplace;
        volatile RuntimeException failStatus;
        final List<List<String>> statusReads = new CopyOnWriteArrayList<>();

        @Override public void replace(List<Lease> hot, List<Lease> focus, long expiresAtMs) {
            if (failReplace != null) throw failReplace;
            calls.add(new Call(List.copyOf(hot), List.copyOf(focus), expiresAtMs));
        }

        @Override public Map<String, String> status(List<String> fields) {
            statusReads.add(List.copyOf(fields));
            if (failStatus != null) throw failStatus;
            Map<String, String> out = new HashMap<>();
            for (String f : fields) if (status.containsKey(f)) out.put(f, status.get(f));
            return out;
        }

        Call last() { return calls.getLast(); }
    }

    static final class Rig implements AutoCloseable {
        final WsTestKit k = new WsTestKit();
        final FakeLeases leases = new FakeLeases();
        final DemandStats stats = new DemandStats();
        final AtomicLong clock = new AtomicLong(System.currentTimeMillis());
        final java.util.concurrent.atomic.AtomicInteger ips = new java.util.concurrent.atomic.AtomicInteger();
        final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor();
        final DemandService demand = new DemandService(k.hub, () -> new RegionSettings.Region(36.5, 127.8, 250), k.snapshots, leases, stats,
                WsTestKit.JSON, k.meters, exec, clock::get);

        long now() { return clock.get(); }

        FakeWsSession session(String id, String subscribe) throws Exception {
            int n = ips.incrementAndGet();
            FakeWsSession f = k.connect(id, "10.1." + (n / 250) + "." + (n % 250)); // 세션마다 다른 IP(IP 당 연결 상한 5)
            k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(f, subscribe);
            return f;
        }

        void refresh() { demand.refresh(clock.get()); }

        @Override public void close() {
            exec.shutdownNow();
            k.close();
        }
    }

    static List<JsonNode> demands(FakeWsSession f) { return ofType(f, "demand"); }

    static JsonNode lastDemand(FakeWsSession f) {
        List<JsonNode> d = demands(f);
        assertThat(d).as("demand messages for session").isNotEmpty();
        return d.getLast();
    }

    // ---------------------------------------------------------------- 규칙

    @Test void rules_focusHotCoveredNone_sharedCell_pausedExcluded() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession covered = r.session("covered", SEOUL);
            FakeWsSession hot1 = r.session("hot1", TOKYO);
            FakeWsSession hot2 = r.session("hot2", TOKYO);
            FakeWsSession world = r.session("world", "{\"type\":\"subscribe\",\"bbox\":[-180,-90,180,90],\"zoom\":3}");
            FakeWsSession focus = r.session("focus", TOKYO);
            r.k.msg(focus, "{\"type\":\"select\",\"hex\":\"ABC123\"}");
            FakeWsSession paused = r.session("paused", TOKYO);
            r.k.msg(paused, "{\"type\":\"select\",\"hex\":\"def456\"}");
            r.k.msg(paused, "{\"type\":\"pause\"}");
            r.refresh();

            DemandServiceTest.FakeLeases.Call c = r.leases.last();
            assertThat(c.expiresAtMs()).isEqualTo(r.now() + 60_000);
            assertThat(c.hot()).extracting(DemandLeases.Lease::member).containsExactly(TOKYO_CELL); // 두 세션이 한 임대를 나눈다
            JsonNode meta = WsTestKit.parse(c.hot().getFirst().metaJson());
            assertThat(meta.path("sessions").asInt()).isEqualTo(2);
            HotCell cell = HotCell.parse(TOKYO_CELL);
            assertThat(meta.path("lat").asDouble()).isEqualTo(cell.lat());
            assertThat(meta.path("lon").asDouble()).isEqualTo(cell.lon());
            assertThat(meta.path("radius_nm").asInt()).isEqualTo(cell.radiusNm());
            assertThat(Instant.parse(meta.path("first_at").asString())).isEqualTo(Instant.ofEpochMilli(r.now()));
            // 선택한 세션은 핫 리전 수요를 내지 않는다 · 일시정지 세션은 수요 없음
            assertThat(c.focus()).extracting(DemandLeases.Lease::member).containsExactly("abc123");
            assertThat(WsTestKit.parse(c.focus().getFirst().metaJson()).path("sessions").asInt()).isEqualTo(1);

            JsonNode cov = lastDemand(covered);
            assertThat(cov.path("hot").path("state").asString()).isEqualTo("covered_by_region");
            assertThat(cov.path("hot").has("cell")).isFalse();
            assertThat(cov.path("hot").has("interval_s")).isFalse();
            assertThat(cov.get("focus").isNull()).isTrue();

            JsonNode h = lastDemand(hot1);
            assertThat(h.path("hot").path("cell").asString()).isEqualTo(TOKYO_CELL);
            assertThat(h.path("hot").path("radius_nm").asInt()).isEqualTo(cell.radiusNm());
            assertThat(h.path("hot").path("state").asString()).isEqualTo("pending"); // 수집기 보고 전
            assertThat(h.path("hot").has("interval_s")).isFalse();                     // 보고 없는 주기를 말하지 않는다
            assertThat(lastDemand(hot2).path("hot").path("cell").asString()).isEqualTo(TOKYO_CELL);

            JsonNode w = lastDemand(world);
            assertThat(w.get("hot").isNull()).isTrue();
            assertThat(w.get("focus").isNull()).isTrue();

            JsonNode fo = lastDemand(focus);
            assertThat(fo.get("hot").isNull()).isTrue();
            assertThat(fo.path("focus").path("hex").asString()).isEqualTo("abc123");
            assertThat(fo.path("focus").path("state").asString()).isEqualTo("pending");
            assertThat(Instant.parse(fo.path("focus").path("since").asString())).isBeforeOrEqualTo(Instant.now());

            assertThat(demands(paused)).isEmpty();
            assertThat(r.stats.counts()).isEqualTo(new DemandStats.Counts(0, 0, 1, 1, 1, 1));
        }
    }

    /** 항공기 레이어를 끈 세션은 항공기를 보지 않는다 — 핫 리전 호출을 쓰지 않는다. 선택 항공기의 집중 추적은 명시적 선택이라 그대로. */
    @Test void aircraftLayerOff_noHotDemand_focusStillFollowsTheSelection() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession off = r.session("off", TOKYO);
            r.k.msg(off, "{\"type\":\"layers\",\"aircraft\":false,\"ships\":true}");
            r.refresh();
            assertThat(r.leases.last().hot()).isEmpty();
            assertThat(lastDemand(off).get("hot").isNull()).isTrue();
            r.k.msg(off, "{\"type\":\"select\",\"hex\":\"abc123\"}");
            r.refresh();
            assertThat(r.leases.last().focus()).extracting(DemandLeases.Lease::member).containsExactly("abc123");
            r.k.msg(off, "{\"type\":\"select\",\"hex\":null}");
            r.k.msg(off, "{\"type\":\"layers\",\"aircraft\":true}");
            r.refresh();
            assertThat(r.leases.last().hot()).extracting(DemandLeases.Lease::member).containsExactly(TOKYO_CELL);
        }
    }

    @Test void collectorStatus_mapsToSessionState_staleActiveIsPending() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession hot = r.session("hot", TOKYO);
            FakeWsSession focus = r.session("focus", TOKYO);
            r.k.msg(focus, "{\"type\":\"select\",\"hex\":\"abc123\"}");
            Instant now = Instant.ofEpochMilli(r.now());
            r.leases.status.put("hot:" + TOKYO_CELL, "{\"state\":\"active\",\"interval_s\":30,\"last_success_at\":\"" + now.minusSeconds(10) + "\",\"last_error\":null,\"provider\":\"adsb_fi\"}");
            r.leases.status.put("focus:abc123", "{\"state\":\"active\",\"interval_s\":5,\"last_success_at\":\"" + now.minusSeconds(2) + "\",\"provider\":\"adsb_fi\"}");
            r.refresh();
            assertThat(r.leases.statusReads.getLast()).containsExactly("hot:" + TOKYO_CELL, "focus:abc123"); // 필요한 필드만
            JsonNode h = lastDemand(hot).path("hot");
            assertThat(h.path("state").asString()).isEqualTo("active");
            assertThat(h.path("interval_s").asInt()).isEqualTo(30);
            assertThat(Instant.parse(h.path("last_success_at").asString())).isEqualTo(now.minusSeconds(10));
            JsonNode f = lastDemand(focus).path("focus");
            assertThat(f.path("state").asString()).isEqualTo("active");
            assertThat(f.path("interval_s").asInt()).isEqualTo(5);
            assertThat(r.stats.counts().hotActive()).isEqualTo(1);
            assertThat(r.stats.counts().focusActive()).isEqualTo(1);

            // 수집기가 멈춤: active 가 20 s 전(5 s 주기의 3배 넘음) → pending, 주기 없음
            r.clock.addAndGet(18_000);
            r.refresh();
            JsonNode f2 = lastDemand(focus).path("focus");
            assertThat(f2.path("state").asString()).isEqualTo("pending");
            assertThat(f2.has("interval_s")).isFalse();
            assertThat(f2.has("last_success_at")).isTrue(); // 마지막 성공 시각은 그대로 밝힌다
            assertThat(lastDemand(hot).path("hot").path("state").asString()).isEqualTo("active"); // 30 s 주기 → 90 s 창

            // 공급자가 모름 · 호출 상한 · 오류는 그대로
            r.leases.status.put("focus:abc123", "{\"state\":\"not_found\",\"interval_s\":5,\"last_error\":\"not in provider response\"}");
            r.leases.status.put("hot:" + TOKYO_CELL, "{\"state\":\"throttled\",\"interval_s\":60}");
            r.refresh();
            assertThat(lastDemand(focus).path("focus").path("state").asString()).isEqualTo("not_found");
            assertThat(lastDemand(focus).path("focus").has("last_error")).isFalse(); // 내부 사유 문구는 내보내지 않는다
            assertThat(lastDemand(hot).path("hot").path("state").asString()).isEqualTo("throttled");
            assertThat(lastDemand(hot).path("hot").path("interval_s").asInt()).isEqualTo(60);
            // 운영자가 공급자를 끔(계약 v3 §C): 호출 상한(throttled)과 구분해 그대로 전한다
            r.leases.status.put("focus:abc123", "{\"state\":\"disabled\",\"interval_s\":null,\"last_error\":\"provider disabled by operator\"}");
            r.leases.status.put("hot:" + TOKYO_CELL, "{\"state\":\"disabled\",\"interval_s\":null}");
            r.refresh();
            assertThat(lastDemand(focus).path("focus").path("state").asString()).isEqualTo("disabled");
            assertThat(lastDemand(focus).path("focus").has("interval_s")).isFalse();
            assertThat(lastDemand(hot).path("hot").path("state").asString()).isEqualTo("disabled");
            r.leases.status.put("hot:" + TOKYO_CELL, "{\"state\":\"not_found\"}"); // 핫 리전에는 없는 값 → pending
            r.leases.status.put("focus:abc123", "{\"state\":\"bogus\"}");         // 모르는 값 → pending
            r.refresh();
            assertThat(lastDemand(hot).path("hot").path("state").asString()).isEqualTo("pending");
            assertThat(lastDemand(focus).path("focus").path("state").asString()).isEqualTo("pending");
            r.leases.status.put("hot:" + TOKYO_CELL, "{\"state\":\"error\",\"interval_s\":30}");
            r.refresh();
            assertThat(lastDemand(hot).path("hot").path("state").asString()).isEqualTo("error");
        }
    }

    @Test void caps_sixCellsFiftyHexes_rankedBySessionsThenFirstAt_overflowIsThrottled() throws Exception {
        try (Rig r = new Rig()) {
            // 셀 7개: 적도 부근 경도 150+2i. 셀 3 은 세션 2개. 셀 0..6 순서로 먼저 요청됨(first_at)
            List<FakeWsSession> cells = new ArrayList<>();
            for (int i = 0; i < 7; i++) {
                String sub = "{\"type\":\"subscribe\",\"bbox\":[%d.2,0.2,%d.8,0.8],\"zoom\":9}".formatted(150 + 2 * i, 150 + 2 * i);
                cells.add(r.session("c" + i, sub));
                r.refresh();
                r.clock.addAndGet(1_000);
            }
            FakeWsSession dup = r.session("c3b", "{\"type\":\"subscribe\",\"bbox\":[156.2,0.2,156.8,0.8],\"zoom\":9}");
            r.refresh();
            List<String> hot = r.leases.last().hot().stream().map(DemandLeases.Lease::member).toList();
            assertThat(hot).hasSize(DemandService.MAX_HOT_CELLS);
            assertThat(hot.getFirst()).startsWith("0.5:156.5:");  // 세션 2개 → 맨 앞
            assertThat(hot).noneMatch(k -> k.startsWith("0.5:162.5:")); // 가장 늦게 요청된 셀이 밀린다
            JsonNode over = lastDemand(cells.get(6)).path("hot");
            assertThat(over.path("state").asString()).isEqualTo("throttled");
            assertThat(over.has("interval_s")).isFalse();
            assertThat(lastDemand(dup).path("hot").path("state").asString()).isEqualTo("pending");

            // focus 51 hex → 50
            for (int i = 0; i < DemandService.MAX_FOCUS_HEXES + 1; i++) {
                FakeWsSession f = r.session("f" + i, TOKYO);
                r.k.msg(f, "{\"type\":\"select\",\"hex\":\"%06x\"}".formatted(0xa00000 + i));
                r.refresh();
                r.clock.addAndGet(10);
            }
            assertThat(r.leases.last().focus()).hasSize(DemandService.MAX_FOCUS_HEXES);
            assertThat(r.leases.last().focus()).extracting(DemandLeases.Lease::member).doesNotContain("%06x".formatted(0xa00000 + 50));
            assertThat(r.stats.counts().focusWanted()).isEqualTo(51);
            assertThat(r.stats.counts().focusLeased()).isEqualTo(50);
        }
    }

    static String select(String hex) { return "{\"type\":\"select\",\"hex\":\"" + hex + "\"}"; }

    static String hex(int i) { return "%06x".formatted(0xc00000 + i); }

    static List<String> focusLeased(Rig r) { return r.leases.last().focus().stream().map(DemandLeases.Lease::member).toList(); }

    /**
     * 계약 v3 §C(리뷰 #10): 한 세션이 새 hex 를 60 s 창에 6개 넘게 올리면 직전 임대를 유지하고(새 키 무시) 그 세션에 limited — 선택을 번갈아
     * 바꿔 수집기의 새 hex 빠른 조회를 반복시키지 못한다. 연결은 끊지 않고, 다른 세션은 영향이 없으며, 창이 비면 다음 계산에 반영된다.
     */
    @Test void sessionLimit_newFocusHexes_sixPerMinute_thenKeepsThePreviousLease() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession f = r.session("s", TOKYO);
            long start = r.now();
            for (int i = 0; i < DemandService.SESSION_NEW_KEYS_MAX; i++) {
                r.k.msg(f, select(hex(i)));
                r.refresh();
                assertThat(focusLeased(r)).containsExactly(hex(i));
                r.clock.addAndGet(1_000);
            }
            r.k.msg(f, select(hex(6)));
            r.refresh();
            assertThat(focusLeased(r)).as("previous lease kept").containsExactly(hex(5));
            JsonNode d = lastDemand(f).path("focus");
            assertThat(d.path("hex").asString()).isEqualTo(hex(6));
            assertThat(d.path("state").asString()).isEqualTo("limited");
            assertThat(d.has("interval_s")).isFalse();
            assertThat(f.isOpen()).as("the session is not disconnected").isTrue();

            FakeWsSession other = r.session("o", TOKYO); // 제한은 세션 단위
            r.k.msg(other, select("bbbbbb"));
            r.refresh();
            assertThat(focusLeased(r)).containsExactlyInAnyOrder(hex(5), "bbbbbb");
            assertThat(lastDemand(other).path("focus").path("state").asString()).isEqualTo("pending");

            r.k.msg(f, select(hex(5))); // 직전 임대의 키로 돌아가는 것은 새 키가 아니다
            r.refresh();
            assertThat(lastDemand(f).path("focus").path("state").asString()).isEqualTo("pending");
            r.k.msg(f, select(hex(7)));
            r.refresh();
            assertThat(lastDemand(f).path("focus").path("state").asString()).isEqualTo("limited");
            assertThat(focusLeased(r)).containsExactlyInAnyOrder(hex(5), "bbbbbb");

            r.clock.set(start + DemandService.SESSION_NEW_KEYS_WINDOW_MS); // 첫 새 키가 창 밖으로
            r.refresh();
            assertThat(focusLeased(r)).containsExactlyInAnyOrder(hex(7), "bbbbbb");
            assertThat(lastDemand(f).path("focus").path("state").asString()).isEqualTo("pending");
        }
    }

    /** 계약 v3 §C: 새 핫 셀도 세션마다 60 s 에 6개 — 넘으면 직전 셀 임대 유지 · limited. 키를 빼는 변화(줌 아웃)는 언제나 바로 반영한다. */
    @Test void sessionLimit_newHotCells_sixPerMinute_removalAlwaysApplies() throws Exception {
        try (Rig r = new Rig()) {
            String sub = "{\"type\":\"subscribe\",\"bbox\":[%d.2,0.2,%d.8,0.8],\"zoom\":%d}";
            FakeWsSession f = r.session("s", sub.formatted(150, 150, 9));
            for (int i = 0; i <= DemandService.SESSION_NEW_KEYS_MAX; i++) {
                r.k.msg(f, sub.formatted(150 + 2 * i, 150 + 2 * i, 9));
                r.refresh();
                r.clock.addAndGet(1_000);
            }
            assertThat(r.leases.last().hot()).singleElement().extracting(DemandLeases.Lease::member).asString().startsWith("0.5:160.5:");
            JsonNode h = lastDemand(f).path("hot");
            assertThat(h.path("cell").asString()).startsWith("0.5:162.5:");
            assertThat(h.path("state").asString()).isEqualTo("limited");
            assertThat(h.path("radius_nm").asInt()).isPositive();
            assertThat(h.has("interval_s")).isFalse();

            r.k.msg(f, sub.formatted(162, 162, 5));
            r.refresh();
            assertThat(r.leases.last().hot()).isEmpty();
            assertThat(lastDemand(f).get("hot").isNull()).isTrue();
            // 선택(집중 추적)은 별도 한도 — 핫 셀 한도가 찼어도 반영된다
            r.k.msg(f, select("abc123"));
            r.refresh();
            assertThat(focusLeased(r)).containsExactly("abc123");
        }
    }

    /** 리뷰 후속: 핫 셀 한도가 찬 세션이 선택을 해제하면(FOCUS→HOT) 새 셀은 막혀도 집중 추적 임대는 곧바로 빠진다. */
    @Test void sessionLimit_deselectWithFullHotBudgetStillReleasesTheFocusLease() throws Exception {
        try (Rig r = new Rig()) {
            String sub = "{\"type\":\"subscribe\",\"bbox\":[%d.2,0.2,%d.8,0.8],\"zoom\":%d}";
            FakeWsSession f = r.session("s", sub.formatted(150, 150, 9));
            for (int i = 0; i < DemandService.SESSION_NEW_KEYS_MAX; i++) {
                r.k.msg(f, sub.formatted(150 + 2 * i, 150 + 2 * i, 9));
                r.refresh();
                r.clock.addAndGet(1_000);
            }
            r.k.msg(f, select("abc123"));
            r.refresh();
            assertThat(focusLeased(r)).containsExactly("abc123");
            assertThat(r.leases.last().hot()).isEmpty();
            r.k.msg(f, sub.formatted(170, 170, 9)); // 선택 중 이동: 새 셀(핫 한도 소진) — 선택이 우선이라 아직 핫 수요 없음
            r.refresh();
            r.k.msg(f, "{\"type\":\"select\",\"hex\":null}");
            r.refresh();
            assertThat(focusLeased(r)).as("deselect always releases the focus lease").isEmpty();
            assertThat(r.leases.last().hot()).isEmpty();
            JsonNode d = lastDemand(f);
            assertThat(d.path("hot").path("state").asString()).isEqualTo("limited");
            assertThat(d.get("focus").isNull()).isTrue();
        }
    }

    /** 일시정지한 세션은 임대에 아무것도 올리지 않는다 — 다시 보면 같은 키도 새로 센다(일시정지·재개로 한도를 우회하지 못한다). */
    @Test void sessionLimit_pauseResumeCountsAsANewKey() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession f = r.session("s", TOKYO);
            r.k.msg(f, select("abc123"));
            for (int i = 0; i < DemandService.SESSION_NEW_KEYS_MAX; i++) {
                r.refresh();
                assertThat(focusLeased(r)).containsExactly("abc123");
                r.k.msg(f, "{\"type\":\"pause\"}");
                r.refresh();
                assertThat(focusLeased(r)).isEmpty();
                r.k.msg(f, "{\"type\":\"resume\"}");
            }
            r.refresh();
            assertThat(focusLeased(r)).isEmpty();
            assertThat(lastDemand(f).path("focus").path("state").asString()).isEqualTo("limited");
        }
    }

    @Test void choose_isDeterministic_andForgetsVanishedKeys() {
        Map<String, Long> first = new HashMap<>(Map.of("gone", 1L, "b", 5L));
        List<String> out = DemandService.choose(new java.util.LinkedHashMap<>(Map.of("a", 1, "b", 1, "c", 3)), first, 2, 10);
        assertThat(out).containsExactly("c", "b"); // 세션 수 → 먼저 요청(b 는 5, a·c 는 지금 10)
        assertThat(first).doesNotContainKey("gone").containsEntry("a", 10L).containsEntry("b", 5L);
    }

    @Test void focusSessionCap_30min_thenReselectRestarts() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession f = r.session("s", TOKYO);
            r.k.msg(f, "{\"type\":\"select\",\"hex\":\"abc123\"}");
            WsSession s = r.k.handler.session("s");
            long selectedAt = s.selection.atMs;
            r.clock.set(selectedAt + DemandService.FOCUS_SESSION_CAP_MS - 1);
            r.refresh();
            assertThat(r.leases.last().focus()).hasSize(1);
            r.clock.set(selectedAt + DemandService.FOCUS_SESSION_CAP_MS);
            r.refresh();
            assertThat(r.leases.last().focus()).isEmpty();
            assertThat(r.leases.last().hot()).isEmpty(); // 선택 중인 세션은 핫 리전 수요도 내지 않는다
            JsonNode d = lastDemand(f);
            assertThat(d.path("focus").path("state").asString()).isEqualTo("expired_session_cap");
            assertThat(Instant.parse(d.path("focus").path("since").asString())).isEqualTo(Instant.ofEpochMilli(selectedAt));
            assertThat(d.get("hot").isNull()).isTrue();
            // 다시 선택하면(같은 hex) 새로 시작
            r.k.msg(f, "{\"type\":\"select\",\"hex\":\"abc123\"}");
            r.clock.set(s.selection.atMs + 1_000);
            r.refresh();
            assertThat(r.leases.last().focus()).extracting(DemandLeases.Lease::member).containsExactly("abc123");
            assertThat(lastDemand(f).path("focus").path("state").asString()).isEqualTo("pending");
            // 선택 해제 → 임대에서 바로 빠진다
            r.k.msg(f, "{\"type\":\"select\",\"hex\":null}");
            r.refresh();
            assertThat(r.leases.last().focus()).isEmpty();
            assertThat(r.leases.last().hot()).extracting(DemandLeases.Lease::member).containsExactly(TOKYO_CELL);
            assertThat(s.selection).isNull();
        }
    }

    @Test void push_onChangeAndEvery30s_only() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession f = r.session("s", TOKYO);
            r.refresh();
            assertThat(demands(f)).hasSize(1);
            r.clock.addAndGet(10_000);
            r.refresh();
            assertThat(demands(f)).hasSize(1); // 그대로 → 보내지 않는다
            r.clock.addAndGet(20_000);
            r.refresh();
            assertThat(demands(f)).hasSize(2); // 30 s 마다
            r.leases.status.put("hot:" + TOKYO_CELL, "{\"state\":\"throttled\",\"interval_s\":60}");
            r.refresh();
            assertThat(demands(f)).hasSize(3); // 바뀌면 바로
        }
    }

    @Test void initialSet_carriesLatestDemand_afterResume() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession f = r.session("s", TOKYO);
            r.refresh();
            r.k.msg(f, "{\"type\":\"pause\"}");
            f.clear();
            r.k.msg(f, "{\"type\":\"resume\"}");
            assertThat(WsTestKit.types(f)).containsExactly("snapshot", "alerts", "radar", "status", "demand"); // SIGMET 은 이미 받은 v
        }
    }

    /** 일시정지한 세션은 수요를 내지 않고 지난 상태도 버린다 — 다시 볼 때 예전 'active' 를 되풀이하지 않는다. */
    @Test void pausedSession_dropsStaleDemand_resumeGetsFreshStateOnNextRefresh() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession f = r.session("s", TOKYO);
            r.leases.status.put("hot:" + TOKYO_CELL, "{\"state\":\"active\",\"interval_s\":30,\"last_success_at\":\"" + Instant.ofEpochMilli(r.now()) + "\"}");
            r.refresh();
            assertThat(lastDemand(f).path("hot").path("state").asString()).isEqualTo("active");
            r.k.msg(f, "{\"type\":\"pause\"}");
            r.refresh();
            assertThat(r.leases.last().hot()).isEmpty(); // 보지 않는 세션의 임대는 빠진다
            assertThat(r.k.handler.session("s").demandJson).isNull();
            r.leases.status.clear();
            f.clear();
            r.k.msg(f, "{\"type\":\"resume\"}");
            assertThat(WsTestKit.types(f)).doesNotContain("demand");
            r.refresh();
            assertThat(lastDemand(f).path("hot").path("state").asString()).isEqualTo("pending");
        }
    }

    /**
     * 계약 v4 §G A-1: focus 메타에 api 가 보이는 콜사인(병합 뷰의 그 hex — 노선 읽기와 같은 정규화)을 싣는다. 수집기는 이 콜사인으로 노선을
     * 조회하므로 adsb.fi 가 그 항공기를 돌려주지 않아도 조회가 끝난다. 콜사인을 모르거나 형식이 틀리거나 ASCII 가 아니면 키 없음(추정하지 않는다).
     */
    @Test void focusMetaCarriesTheNormalizedVisibleCallsign() throws Exception {
        try (Rig r = new Rig()) {
            Instant t = Instant.ofEpochMilli(r.now());
            r.k.publish("region", t, plane("abc001", " syn736 ", t), plane("abc002", "ıab12ſ", t), plane("abc003", null, t), plane("abc005", "SY", t));
            for (String hex : new String[]{"abc001", "abc002", "abc003", "abc004", "abc005"}) {
                FakeWsSession f = r.session("s-" + hex, TOKYO);
                r.k.msg(f, "{\"type\":\"select\",\"hex\":\"" + hex + "\"}");
            }
            r.refresh();
            Map<String, JsonNode> meta = focusMeta(r.leases.last());
            assertThat(meta).containsOnlyKeys("abc001", "abc002", "abc003", "abc004", "abc005");
            assertThat(meta.get("abc001").path("callsign").asString()).isEqualTo("SYN736");
            assertThat(meta.get("abc001").path("sessions").asInt()).isEqualTo(1);
            assertThat(meta.get("abc002").has("callsign")).as("non-ASCII — uppercasing would turn it into IAB12S").isFalse();
            assertThat(meta.get("abc003").has("callsign")).as("no callsign").isFalse();
            assertThat(meta.get("abc004").has("callsign")).as("not in the merged view").isFalse();
            assertThat(meta.get("abc005").has("callsign")).as("too short").isFalse();

            // 보이는 콜사인이 바뀌면 다음 계산의 메타도 바뀐다
            r.k.publish("region", t.plusSeconds(5), plane("abc003", "kal081", t.plusSeconds(5)));
            r.refresh();
            assertThat(focusMeta(r.leases.last()).get("abc003").path("callsign").asString()).isEqualTo("KAL081");
        }
    }

    static AircraftState plane(String hex, String callsign, Instant seen) {
        return new AircraftState(hex, callsign, null, null, null, 35.5, 139.6, 30000, 400.0, 90.0, 0.0, false, null, seen, "adsb_lol", seen, 0, false);
    }

    static Map<String, JsonNode> focusMeta(FakeLeases.Call c) {
        Map<String, JsonNode> out = new HashMap<>();
        for (DemandLeases.Lease l : c.focus()) out.put(l.member(), WsTestKit.parse(l.metaJson()));
        return out;
    }

    @Test void deselectDropsFocusObservation_andFansOut() throws Exception {
        try (Rig r = new Rig()) {
            Instant t = Instant.ofEpochMilli(r.now());
            AircraftState a = new AircraftState("abc123", null, null, null, null, 35.5, 139.6, 30000, 400.0, 90.0, 0.0, false, null,
                    t, "adsb_fi", t, 0, false);
            r.k.snapshots.applyFocus(new Snapshot(r.k.snapshots.nextVersion(), "focus", "adsb_fi", t, t, "-", Map.of("abc123", a)));
            FakeWsSession f = r.session("s", TOKYO);
            assertThat(ofType(f, "snapshot").getLast().path("aircraft").toString()).contains("abc123");
            r.refresh(); // 아무도 abc123 을 선택하지 않았다 → focus 관측을 뺀다 → 팬아웃(diff remove)
            assertThat(r.k.snapshots.focus()).isEmpty();
            List<JsonNode> diffs = ofType(f, "diff");
            assertThat(diffs).isNotEmpty();
            assertThat(diffs.getLast().path("remove").toString()).contains("abc123");
        }
    }

    // ---------------------------------------------------------------- 오류 · 수명

    @Test void redisFailures_areContained_sessionsSeePending() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession f = r.session("s", TOKYO);
            r.leases.failReplace = new org.springframework.data.redis.RedisConnectionFailureException("down");
            r.leases.failStatus = new org.springframework.data.redis.RedisConnectionFailureException("down");
            r.refresh();
            assertThat(lastDemand(f).path("hot").path("state").asString()).isEqualTo("pending");
            assertThat(r.k.meters.counter("wakeline_demand_errors_total", "op", "write").count()).isEqualTo(1.0);
            assertThat(r.k.meters.counter("wakeline_demand_errors_total", "op", "status").count()).isEqualTo(1.0);
            // 계산 자체의 예외도 주기 작업을 멈추지 않는다(refreshSafe)
            DemandService broken = new DemandService(r.k.hub, () -> { throw new IllegalStateException("boom"); }, r.k.snapshots, r.leases, r.stats,
                    WsTestKit.JSON, r.k.meters, r.exec, r.clock::get);
            broken.refreshSafe();
            assertThat(r.k.meters.counter("wakeline_demand_errors_total", "op", "refresh").count()).isEqualTo(1.0);
        }
    }

    @Test void debounce_coalescesChangesIntoOneRefresh_stopClearsLeases() throws Exception {
        try (Rig r = new Rig()) {
            r.demand.start();
            assertThat(r.demand.isRunning()).isTrue();
            assertThat(r.demand.getPhase()).isLessThan(r.k.hub.getPhase()); // 허브(세션 종료) 뒤에 멈춘다
            r.session("s", TOKYO);   // subscribe → 변화 신호
            for (int i = 0; i < 5; i++) r.demand.requestRefresh();
            WsHubTest.await(() -> r.leases.calls.size() >= 1);
            Thread.sleep(300);
            assertThat(r.leases.calls).hasSize(1); // 1 s 안의 변화는 한 번으로
            assertThat(r.leases.last().hot()).hasSize(1);
            r.demand.stop();
            assertThat(r.demand.isRunning()).isFalse();
            assertThat(r.leases.last().hot()).isEmpty(); // 종료 — 수집기 호출을 바로 멈춘다
            assertThat(r.leases.last().focus()).isEmpty();
            r.demand.requestRefresh(); // 멈춘 뒤에는 아무것도 하지 않는다
        }
    }

    // ---------------------------------------------------------------- 한국 항만 입출항(ADR-022 개정)

    /** 선박 선택은 수요를 만들지 않는다 — 입출항은 DB 색인을 읽을 뿐이라 임대 · 한도가 없다(예전 wakeline:demand:portcalls 는 없앴다). */
    @Test void selectingAShipLeasesNothing() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession f = r.session("s", TOKYO);
            r.refresh();
            DemandServiceTest.FakeLeases.Call before = r.leases.last();
            r.k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}");
            r.refresh();
            assertThat(r.leases.last().focus()).isEqualTo(before.focus());
            assertThat(r.leases.last().hot()).as("a ship selection is not an aircraft selection — the hot-region demand stays").isEqualTo(before.hot());
            assertThat(r.k.meters.find("wakeline_demand_leases").tag("kind", "port_calls").gauge()).isNull();
        }
    }

    @Test void want_zoomBelow7_orPolarViewport_isNone() throws Exception {
        try (Rig r = new Rig()) {
            FakeWsSession low = r.session("low", "{\"type\":\"subscribe\",\"bbox\":[139.2,35.2,140.2,35.9],\"zoom\":6}");
            FakeWsSession polar = r.session("polar", "{\"type\":\"subscribe\",\"bbox\":[10,86,20,89],\"zoom\":8}");
            r.refresh();
            assertThat(lastDemand(low).get("hot").isNull()).isTrue();
            assertThat(lastDemand(polar).get("hot").isNull()).isTrue();
            assertThat(r.leases.last().hot()).isEmpty();
        }
    }
}
