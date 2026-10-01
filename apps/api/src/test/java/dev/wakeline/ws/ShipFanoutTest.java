package dev.wakeline.ws;

import dev.wakeline.platform.support.Receipt;
import dev.wakeline.portcalls.PortCallFixtures;
import dev.wakeline.portcalls.PortCallIndex;
import dev.wakeline.portcalls.PortCallReader;
import dev.wakeline.route.RouteInfoTest;
import dev.wakeline.ships.core.ShipEvents;
import dev.wakeline.ships.core.ShipState;
import dev.wakeline.ships.core.ShipStatic;
import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.ships.data.StoredStaticReader;
import dev.wakeline.ships.web.ShipJson;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import static dev.wakeline.ws.WsTestKit.ac;
import static dev.wakeline.ws.WsTestKit.ofType;
import static dev.wakeline.ws.WsTestKit.types;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 선박 WS(계약 v2 §B3 · v4 §C): 레이어, ships_snapshot/ships_diff 의 세션별 연속 sseq, 줌 &lt; 4 격자(칸 크기·재전송 억제·버전당 한 번 집계),
 * 줌 4~6 개별/격자 전환(1,500 척 · 되풀이 방지 1,200 척), 5,000 척 상한 → capped 격자, select_ship → ship_selected, resync·resume, 항공기 레이어 끄기.
 */
class ShipFanoutTest {
    static final Instant T = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS);
    /** 부산 부근 줌 7 뷰포트 */
    static final String BUSAN = "{\"type\":\"subscribe\",\"bbox\":[128,34,130,36],\"zoom\":7}";

    static ShipState pos(String mmsi, double lat, double lon, Instant seen) {
        return new ShipState(mmsi, lat, lon, 12.0, 45.0, 44, 0, 3, "epfs", seen, "aisstream", "PositionReport", "A");
    }

    static ShipStatic stat(String mmsi, String name, Integer type) {
        return new ShipStatic(mmsi, name, "D7AB", 9321483, type, 150, 30, 14, 16, 9.8, "KR PUS", 9, 29, 6, 30, T.minusSeconds(60), "aisstream");
    }

    /** ShipStore 에 반영하고 이벤트를 팬아웃에 넘긴다(timer 없음 — 바로 팬아웃). */
    static ShipStore.Change publish(WsTestKit k, List<ShipState> st, List<ShipStatic> sc) {
        ShipStore.Change c = k.ships.apply(st, sc, T, "aisstream", System.currentTimeMillis());
        k.shipFanout.onShips(new ShipEvents.ShipsUpdated(T, "aisstream", st, sc, c.changed(), Set.of(), Receipt.NONE));
        return c;
    }

    static FakeWsSession session(WsTestKit k, String id, String subscribe, boolean ships) throws Exception {
        FakeWsSession f = k.connect(id, "10.0.0." + (Math.abs(id.hashCode()) % 200 + 1));
        k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
        if (ships) k.msg(f, "{\"type\":\"layers\",\"aircraft\":true,\"ships\":true}");
        k.msg(f, subscribe);
        return f;
    }

    static List<Integer> sseqs(FakeWsSession f) {
        List<Integer> out = new ArrayList<>();
        for (String s : f.sent) {
            JsonNode n = WsTestKit.parse(s);
            String t = n.path("type").asString();
            if (t.equals("ships_snapshot") || t.equals("ships_diff")) out.add(n.path("sseq").asInt());
        }
        return out;
    }

    @Test void layerOffByDefault_thenSnapshotWithSseq1_liteEncodingOmitsUnknowns() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            publish(k, List.of(pos("440000001", 35.1, 129.1, T), pos("440000002", 35.2, 129.2, T), pos("431000001", 35.5, 139.8, T)),
                    List.of(stat("440000001", "HANJIN BUSAN", 70)));
            FakeWsSession off = session(k, "off", BUSAN, false);
            assertThat(types(off)).doesNotContain("ships_snapshot", "ships_diff", "ships_grid");
            FakeWsSession on = session(k, "on", BUSAN, true);
            List<JsonNode> snaps = ofType(on, "ships_snapshot");
            assertThat(snaps).hasSize(1);
            JsonNode sn = snaps.getFirst();
            assertThat(sn.path("sseq").asInt()).isEqualTo(1);
            assertThat(sn.path("ts").asString()).isNotBlank();
            assertThat(sn.path("ships").size()).as("only ships in the viewport").isEqualTo(2);
            JsonNode named = null, bare = null;
            for (JsonNode s : sn.path("ships")) if (s.path("mmsi").asString().equals("440000001")) named = s; else bare = s;
            assertThat(named.path("name").asString()).isEqualTo("HANJIN BUSAN");
            assertThat(named.path("ship_type").asInt()).isEqualTo(70);
            assertThat(named.path("heading_deg").asInt()).isEqualTo(44);
            assertThat(named.path("position_source").asString()).isEqualTo("epfs");
            assertThat(named.has("rot")).as("ShipLite has no rot").isFalse();
            assertThat(bare.has("name")).as("no static → no name key (unknown, not empty)").isFalse();
            assertThat(bare.has("ship_type")).isFalse();
            // 레이어를 켠 세션만 선박을 받는다 — 다음 변경에서도
            off.clear();
            publish(k, List.of(pos("440000001", 35.15, 129.1, T.plusSeconds(10))), List.of());
            assertThat(types(off)).doesNotContain("ships_diff");
        }
    }

    /**
     * layers(선박 켬) → subscribe 를 잇달아 보내면 layers 가 예약한 선박 작업과 초기 세트 끝의 선박 훅이 둘 다 스냅샷을 보낼 수 있었다 — 선박 작업이
     * 구독이 정해진 뒤에 돌면(우편함 순서상 초기 세트보다 먼저) 스냅샷 1, 초기 세트 훅이 다시 강제해 스냅샷 2. 두 번째가 다음 위치 반영 뒤에 나가면 그 변화가
     * 스냅샷에 실려 diff 가 오지 않았다(ShipsIT.wsShipsLayer_snapshotThenDiffWithContiguousSseq 가 가끔 실패 — 2026-09-30 '건너뜀: ships_snapshot=1').
     * 우편함을 손으로 돌려 그 순서를 만든다: 스냅샷은 하나, 다음 변화는 sseq 2 의 diff.
     */
    @Test void layersThenSubscribe_sendOneShipsSnapshot_evenWhenTheLayersJobRunsAfterTheSubscriptionIsSet() throws Exception {
        java.util.ArrayDeque<Runnable> q = new java.util.ArrayDeque<>();
        Runnable drain = () -> { for (Runnable r; (r = q.poll()) != null; ) r.run(); };
        try (WsTestKit k = new WsTestKit(q::add, 5_000, 200, 5)) {
            publish(k, List.of(pos("440000001", 35.1, 129.1, T)), List.of());
            drain.run();
            FakeWsSession f = k.connect("race", "10.0.0.9");
            k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
            drain.run();
            k.msg(f, "{\"type\":\"layers\",\"aircraft\":false,\"ships\":true}"); // 선박 작업이 우편함에 — 아직 돌지 않는다
            k.msg(f, BUSAN);                                                         // 구독이 정해지고 초기 세트가 그 뒤에
            drain.run();
            assertThat(ofType(f, "ships_snapshot")).as("one ships snapshot for one subscription").hasSize(1);
            publish(k, List.of(pos("440000001", 35.2, 129.1, T.plusSeconds(10))), List.of());
            drain.run();
            assertThat(sseqs(f)).containsExactly(1, 2);
        }
    }

    @Test void diffs_areContiguous_noEmptyDiffs_removalsOnExpiryAndLeavingTheViewport() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            publish(k, List.of(pos("440000001", 35.1, 129.1, T), pos("440000002", 35.2, 129.2, T)), List.of());
            FakeWsSession f = session(k, "s", BUSAN, true);
            publish(k, List.of(pos("440000001", 35.12, 129.1, T.plusSeconds(10))), List.of());                 // 이동 → diff 2
            publish(k, List.of(pos("440000001", 35.12, 129.1, T.plusSeconds(20))), List.of());                 // 표시 값 같음, seen +10 s → 없음
            publish(k, List.of(pos("440000001", 35.12, 129.1, T.plusSeconds(75))), List.of());                 // seen +65 s → diff 3(나이 갱신)
            publish(k, List.of(pos("440000002", 37.5, 129.2, T.plusSeconds(80))), List.of());                  // 뷰포트 밖으로 → remove
            publish(k, List.of(), List.of(stat("440000001", "NAMED LATER", 80)));                              // 정적 정보가 붙음 → diff 5
            assertThat(sseqs(f)).containsExactly(1, 2, 3, 4, 5);
            List<JsonNode> diffs = ofType(f, "ships_diff");
            assertThat(diffs.get(0).path("upsert").get(0).path("lat").asDouble()).isEqualTo(35.12);
            assertThat(diffs.get(2).path("remove")).extracting(JsonNode::asString).containsExactly("440000002");
            assertThat(diffs.get(3).path("upsert").get(0).path("name").asString()).isEqualTo("NAMED LATER");
            // 만료(실시간 목록에서 빠짐) → remove
            ShipStore.Change c = k.ships.expire(System.currentTimeMillis() + 3_600_000L, false);
            k.shipFanout.onShips(ShipEvents.ShipsUpdated.liveOnly(Set.of(), c.removed()));
            assertThat(sseqs(f)).containsExactly(1, 2, 3, 4, 5, 6);
            assertThat(ofType(f, "ships_diff").getLast().path("remove")).extracting(JsonNode::asString).containsExactly("440000001");
        }
    }

    @Test void resync_andPeriodicSnapshot_restartSseqAt1() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            publish(k, List.of(pos("440000001", 35.1, 129.1, T)), List.of());
            FakeWsSession f = session(k, "s", BUSAN, true);
            publish(k, List.of(pos("440000001", 35.2, 129.1, T.plusSeconds(10))), List.of());
            k.msg(f, "{\"type\":\"resync\"}"); // 웹은 sseq 틈에도 resync 를 보낸다 → 선박 스냅샷도
            assertThat(sseqs(f)).containsExactly(1, 2, 1);
            assertThat(ofType(f, "snapshot")).as("aircraft snapshot too").hasSize(2);
            k.shipClock.addAndGet(ShipFanout.RESYNC_MS + 1);
            publish(k, List.of(pos("440000001", 35.3, 129.1, T.plusSeconds(20))), List.of());
            assertThat(sseqs(f)).containsExactly(1, 2, 1, 1);
        }
    }

    /** 줌 &lt; 4 는 선박 수와 무관하게 격자(계약 v4 §C) — 칸 크기는 줌으로, 같은 버전은 다시 보내지 않고, 집계는 버전당 한 번. */
    @Test void grid_belowZoom4_cellSizeByZoom_notResentWithoutChange_builtOncePerVersion() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            publish(k, List.of(pos("440000001", 35.1, 129.1, T), pos("440000002", 35.2, 129.2, T), pos("431000001", 35.5, 139.8, T)),
                    List.of(stat("440000001", "A", 70), stat("440000002", "B", 71)));
            FakeWsSession z2 = session(k, "z2", "{\"type\":\"subscribe\",\"bbox\":[-180,-90,180,90],\"zoom\":2}", true);
            FakeWsSession z3 = session(k, "z3", "{\"type\":\"subscribe\",\"bbox\":[125,30,135,40],\"zoom\":3}", true);
            JsonNode g2 = ofType(z2, "ships_grid").getFirst();
            assertThat(g2.path("cell_deg").asDouble()).isEqualTo(5.0);
            assertThat(g2.has("capped")).isFalse();
            int total = 0;
            for (JsonNode c : g2.path("cells")) total += c.get(2).asInt();
            assertThat(total).isEqualTo(3);
            JsonNode g3 = ofType(z3, "ships_grid").getFirst();
            assertThat(g3.path("cell_deg").asDouble()).isEqualTo(2.0);
            assertThat(g3.has("capped")).as("zoom, not count").isFalse();
            assertThat(g3.path("cells").size()).as("bbox filter: the Tokyo ship is outside").isEqualTo(1);
            assertThat(g3.path("cells").get(0).get(3).asString()).isEqualTo("cargo");
            // 계약 v5 §B2: 선종별 수(화물 70 · 71 → cargo 2)가 실제 메시지에 실린다
            assertThat(g3.path("cells").get(0).get(4).toString()).isEqualTo("[2,0,0,0,0,0,0,0,0,0,0]");
            assertThat(k.meters.find("wakeline_ship_grid_build_seconds").timer().count()).as("one aggregation for all sessions").isEqualTo(1);

            // 버전이 그대로면 다시 보내지 않는다(같은 보고 재전달)
            publish(k, List.of(pos("440000001", 35.1, 129.1, T)), List.of());
            assertThat(ofType(z3, "ships_grid")).hasSize(1);
            // 새 버전 → 다시(집계도 한 번 더)
            publish(k, List.of(pos("440000001", 35.3, 129.1, T.plusSeconds(10))), List.of());
            assertThat(ofType(z3, "ships_grid")).hasSize(2);
            assertThat(ofType(z2, "ships_grid")).hasSize(2);
            assertThat(k.meters.find("wakeline_ship_grid_build_seconds").timer().count()).isEqualTo(2);
            assertThat(types(z3)).doesNotContain("ships_snapshot");
            assertThat(k.meters.find("wakeline_ws_ship_capped_total").counter().count()).isZero();
            // 줌 4~6 이고 선박이 적으면 개별 선박(스냅샷 sseq 1) — 계약 v4 §C
            k.msg(z3, "{\"type\":\"subscribe\",\"bbox\":[125,30,135,40],\"zoom\":5}");
            JsonNode sn = ofType(z3, "ships_snapshot").getFirst();
            assertThat(sn.path("sseq").asInt()).isEqualTo(1);
            assertThat(sn.path("ships").size()).isEqualTo(2);
            publish(k, List.of(pos("440000001", 35.4, 129.1, T.plusSeconds(20))), List.of());
            assertThat(sseqs(z3)).containsExactly(1, 2);
        }
    }

    /** 뷰포트 [120,30,135,40] 안에 n 척(seen 시각 지정). */
    static List<ShipState> fleet(int from, int n, Instant seen) {
        List<ShipState> out = new ArrayList<>(n);
        for (int i = from; i < from + n; i++)
            out.add(pos(String.format("%09d", 300_000_000 + i), 30.05 + (i % 100) * 0.09, 120.05 + (i / 100) * 0.9, seen));
        return out;
    }

    static final String Z5 = "{\"type\":\"subscribe\",\"bbox\":[120,30,135,40],\"zoom\":5}";
    static final String Z4 = "{\"type\":\"subscribe\",\"bbox\":[120,30,135,40],\"zoom\":4}";

    /**
     * 계약 v4 §C: 줌 4~6 은 뷰포트 안 1,500 척까지 개별, 넘으면 격자(capped — 그 줌의 칸 크기). 수 때문에 격자가 된 세션은 1,200 척 이하에서만
     * 개별로 돌아온다(1,201~1,500 에서 되풀이 전환하지 않게). 처음 보는 세션은 1,500 이하면 개별.
     */
    @Test void band_zoom4to6_pointsUpTo1500_gridAbove_hysteresisBackAt1200() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant old = Instant.now().minusSeconds(40 * 60); // 만료로 뺄 선박(30분 넘게 보고 없음)
            List<ShipState> first = new ArrayList<>(fleet(0, 1_200, T));
            first.addAll(fleet(1_200, 300, old));
            publish(k, first, List.of());
            FakeWsSession f = session(k, "z5", Z5, true);
            FakeWsSession z4 = session(k, "z4", Z4, true);
            JsonNode sn = ofType(f, "ships_snapshot").getFirst();
            assertThat(sn.path("ships").size()).as("exactly 1,500 → individual ships").isEqualTo(ShipFanout.BAND_MAX_SHIPS);
            assertThat(types(z4)).contains("ships_snapshot");

            // 1,501 척 → 격자(capped, 줌 5 는 0.5° · 줌 4 는 2°)
            publish(k, fleet(1_500, 1, T), List.of());
            JsonNode g = ofType(f, "ships_grid").getLast();
            assertThat(g.path("capped").asBoolean()).isTrue();
            assertThat(g.path("cell_deg").asDouble()).isEqualTo(0.5);
            int total = 0;
            for (JsonNode c : g.path("cells")) total += c.get(2).asInt();
            assertThat(total).isEqualTo(1_501);
            assertThat(ofType(z4, "ships_grid").getLast().path("cell_deg").asDouble()).isEqualTo(2.0);
            assertThat(k.meters.find("wakeline_ws_ship_capped_total").counter().count()).isEqualTo(2);

            // 만료로 1,201 척 — 1,500 이하지만 격자 세션은 1,200 이하가 되어야 돌아온다
            ShipStore.Change c = k.ships.expire(System.currentTimeMillis(), false);
            assertThat(c.removed()).hasSize(300);
            k.shipFanout.onShips(ShipEvents.ShipsUpdated.liveOnly(Set.of(), c.removed()));
            int snaps = ofType(f, "ships_snapshot").size();
            JsonNode g2 = ofType(f, "ships_grid").getLast();
            assertThat(g2.path("capped").asBoolean()).isTrue();
            total = 0;
            for (JsonNode cell : g2.path("cells")) total += cell.get(2).asInt();
            assertThat(total).isEqualTo(1_201);
            // 처음 보는 세션은 같은 1,201 척이어도 개별(되풀이 방지는 이미 격자인 세션에만)
            FakeWsSession fresh = session(k, "fresh", Z5, true);
            assertThat(ofType(fresh, "ships_snapshot").getFirst().path("ships").size()).isEqualTo(1_201);
            // 개별 세션은 1,201 척에서 개별 그대로(diff)
            publish(k, List.of(pos("300000000", 30.06, 120.05, T.plusSeconds(10))), List.of());
            assertThat(types(fresh)).contains("ships_diff");
            assertThat(ofType(f, "ships_snapshot")).as("the grid session stays on the grid at 1,201").hasSize(snaps);

            // 한 척이 뷰포트를 떠나 1,200 척 → 격자 세션도 개별로(스냅샷 sseq 1)
            publish(k, List.of(pos("300001500", 45.0, 120.05, T.plusSeconds(20))), List.of());
            JsonNode back = ofType(f, "ships_snapshot").getLast();
            assertThat(ofType(f, "ships_snapshot")).hasSize(snaps + 1);
            assertThat(back.path("sseq").asInt()).isEqualTo(1);
            assertThat(back.path("ships").size()).isEqualTo(ShipFanout.BAND_RESUME_SHIPS);
        }
    }

    @Test void pointsLimit_byZoomAndHysteresis() {
        assertThat(ShipFanout.pointsLimit(7, false)).isEqualTo(ShipJson.MAX_SHIPS_PER_MESSAGE);
        assertThat(ShipFanout.pointsLimit(12, true)).as("no hysteresis at zoom ≥ 7").isEqualTo(ShipJson.MAX_SHIPS_PER_MESSAGE);
        assertThat(ShipFanout.pointsLimit(4, false)).isEqualTo(1_500);
        assertThat(ShipFanout.pointsLimit(6, false)).isEqualTo(1_500);
        assertThat(ShipFanout.pointsLimit(6, true)).isEqualTo(1_200);
        assertThat(ShipFanout.pointsLimit(5, true)).isEqualTo(1_200);
    }

    /** 줌 ≥ 7 에서 5,000 척을 넘어 격자가 된 세션이 줌 4~6 으로 나오면 그 줌의 되풀이 방지 기준(1,200)을 따른다. */
    @Test void cappedAtZoom7_thenZoomOutIntoTheBand_usesTheResumeThreshold() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            List<ShipState> many = new ArrayList<>();
            for (int i = 0; i <= ShipJson.MAX_SHIPS_PER_MESSAGE; i++)
                many.add(pos(String.format("%09d", 300_000_000 + i), 34.001 + (i % 100) * 0.019, 128.001 + (i / 100) * 0.03, T));
            publish(k, many, List.of());
            FakeWsSession f = session(k, "dense", BUSAN, true);
            assertThat(ofType(f, "ships_grid").getLast().path("capped").asBoolean()).isTrue();
            // 경도 128.0~128.38 에는 13열 × 100 = 1,300 척 — 1,500 이하지만 1,200 초과
            String narrow = "{\"type\":\"subscribe\",\"bbox\":[128,34,128.38,36],\"zoom\":5}";
            k.msg(f, narrow);
            assertThat(types(f)).doesNotContain("ships_snapshot");
            JsonNode g = ofType(f, "ships_grid").getLast();
            assertThat(g.path("capped").asBoolean()).isTrue();
            int total = 0;
            for (JsonNode c : g.path("cells")) total += c.get(2).asInt();
            assertThat(total).isGreaterThanOrEqualTo(1_300); // 칸이 bbox 와 겹치면 칸 전체 수(격자 규칙)
            FakeWsSession fresh = session(k, "fresh", narrow, true);
            assertThat(ofType(fresh, "ships_snapshot").getFirst().path("ships").size()).isEqualTo(1_300);
        }
    }

    @Test void moreThan5000ShipsInTheViewport_sendsACappedGridInstead() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            List<ShipState> many = new ArrayList<>();
            for (int i = 0; i <= ShipJson.MAX_SHIPS_PER_MESSAGE; i++)
                many.add(pos(String.format("%09d", 300_000_000 + i), 34.001 + (i % 100) * 0.019, 128.001 + (i / 100) * 0.03, T));
            publish(k, many, List.of());
            FakeWsSession f = session(k, "dense", BUSAN, true);
            assertThat(types(f)).doesNotContain("ships_snapshot");
            JsonNode g = ofType(f, "ships_grid").getFirst();
            assertThat(g.path("capped").asBoolean()).isTrue();
            assertThat(g.path("cell_deg").asDouble()).isEqualTo(0.5);
            assertThat(k.meters.find("wakeline_ws_ship_capped_total").counter().count()).isEqualTo(1);
            // 5,000 척 이하로 줄면(만료) 개별 선박으로 돌아온다
            k.ships.expire(System.currentTimeMillis() + 3_600_000L, false);
            publish(k, List.of(pos("440000001", 35.1, 129.1, T.plusSeconds(10))), List.of());
            JsonNode sn = ofType(f, "ships_snapshot").getFirst();
            assertThat(sn.path("sseq").asInt()).isEqualTo(1);
            assertThat(sn.path("ships").size()).isEqualTo(1);
        }
    }

    @Test void selectShip_immediateThenOnEachChange_stateNullWhenNotLive() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            publish(k, List.of(pos("440000001", 35.1, 129.1, T), pos("440000002", 35.2, 129.2, T)), List.of(stat("440000001", "HANJIN BUSAN", 70)));
            FakeWsSession f = session(k, "s", BUSAN, true);
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"44000001\"}");
            assertThat(ofType(f, "error").getLast().path("code").asString()).isEqualTo("BAD_MMSI");
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":440000001}");
            assertThat(ofType(f, "error").getLast().path("code").asString()).as("numbers are not accepted").isEqualTo("BAD_MMSI");

            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}");
            JsonNode s1 = ofType(f, "ship_selected").getLast();
            assertThat(s1.path("mmsi").asString()).isEqualTo("440000001");
            assertThat(s1.path("state").path("rot").asInt()).isEqualTo(3);
            assertThat(s1.path("state").path("class").asString()).isEqualTo("A");
            assertThat(s1.path("state").path("msg_type").asString()).isEqualTo("PositionReport");
            assertThat(s1.path("static").path("name").asString()).isEqualTo("HANJIN BUSAN");
            assertThat(s1.path("static").path("eta_minute").asInt()).isEqualTo(30);
            assertThat(s1.path("static").path("updated_at").asString()).isNotBlank();
            assertThat(s1.path("static_source").asString()).as("memory static — live").isEqualTo("live");
            assertThat(s1.get("static_updated_at").isNull()).as("the stored time is only for stored statics (key kept)").isTrue();

            publish(k, List.of(pos("440000002", 35.3, 129.2, T.plusSeconds(10))), List.of());   // 다른 선박 → 없음
            assertThat(ofType(f, "ship_selected")).hasSize(1);
            publish(k, List.of(pos("440000001", 35.3, 129.1, T.plusSeconds(10))), List.of());   // 선택 선박 → 있음
            assertThat(ofType(f, "ship_selected")).hasSize(2);
            assertThat(ofType(f, "ship_selected").getLast().path("state").path("lat").asDouble()).isEqualTo(35.3);

            // 실시간 목록에서 빠짐 → state null(키는 남는다), static 은 알고 있는 동안
            ShipStore.Change c = k.ships.expire(System.currentTimeMillis() + 3_600_000L, false);
            k.shipFanout.onShips(ShipEvents.ShipsUpdated.liveOnly(Set.of(), c.removed()));
            JsonNode gone = ofType(f, "ship_selected").getLast();
            assertThat(gone.has("state")).isTrue();
            assertThat(gone.get("state").isNull()).isTrue();

            // 정적 정보만 아는 선박 · 전혀 모르는 선박
            k.ships.apply(List.of(), List.of(stat("477000009", "ONLY STATIC", 30)), T, "aisstream", System.currentTimeMillis());
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"477000009\"}");
            JsonNode onlyStatic = ofType(f, "ship_selected").getLast();
            assertThat(onlyStatic.get("state").isNull()).isTrue();
            assertThat(onlyStatic.path("static").path("name").asString()).isEqualTo("ONLY STATIC");
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"123456789\"}");
            JsonNode unknown = ofType(f, "ship_selected").getLast();
            assertThat(unknown.get("state").isNull()).isTrue();
            assertThat(unknown.get("static").isNull()).isTrue();
            assertThat(unknown.get("static_source").isNull()).as("no stored-static reader wired — unknown, not 'none'").isTrue();

            // 선택 해제: 응답 없음, 이후 변경에도 없음
            int n = ofType(f, "ship_selected").size();
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":null}");
            publish(k, List.of(pos("123456789", 35.3, 129.1, T.plusSeconds(20))), List.of());
            assertThat(ofType(f, "ship_selected")).hasSize(n);
        }
    }

    /**
     * ADR-022 개정: ship_selected.port_calls = 정적 정보의 호출부호로 DB 색인에서 찾은 입출항. 선박이 바뀌지 않아도 주기 다시 보기(refreshSelected)가
     * 색인이 바뀐 것(빈 색인 → 기록)만 보낸다 — 같은 값이면 보내지 않는다. 선택은 외부 호출 · 임대를 만들지 않는다(색인 읽기뿐).
     */
    @Test void selectShip_carriesPortCalls_andThePeriodicRefreshSendsOnlyChanges() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            PortCallFixtures.FakeSource index = new PortCallFixtures.FakeSource();
            Instant now = Instant.parse("2026-09-29T13:00:00Z");
            java.util.concurrent.atomic.AtomicLong clock = new java.util.concurrent.atomic.AtomicLong(now.toEpochMilli());
            k.shipFanout.setPortCallSource(ShipLookups.portCalls(new PortCallReader(index, List::of, clock::get)));
            publish(k, List.of(pos("440000001", 35.1, 129.1, T), pos("440000002", 35.2, 129.2, T)), List.of(stat("440000001", "HANJIN BUSAN", 70)));
            FakeWsSession f = session(k, "s", BUSAN, true);
            FakeWsSession idle = session(k, "idle", BUSAN, true); // 선박을 고르지 않은 세션 — 받지 않는다
            FakeWsSession paused = session(k, "paused", BUSAN, true); // 고른 뒤 일시정지 — 다시 볼 때까지 받지 않는다
            k.msg(paused, "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}");
            k.msg(paused, "{\"type\":\"pause\"}");
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}");
            JsonNode first = ofType(f, "ship_selected").getLast();
            assertThat(first.path("port_calls").path("status").asString()).as("empty index — not 'none'").isEqualTo("incomplete");
            assertThat(first.path("port_calls").path("call_sign").asString()).isEqualTo("D7AB");
            assertThat(first.path("port_calls").path("index").path("gaps").size()).isEqualTo(10);

            k.shipFanout.refreshSelected(); // 같은 값 — 보내지 않는다
            assertThat(ofType(f, "ship_selected")).hasSize(1);
            index.coverage = PortCallFixtures.fullCoverage(LocalDate.parse("2026-08-20"), LocalDate.parse("2026-09-29"), now);
            PortCallIndex.Row row = PortCallFixtures.row(now);
            index.rows.put("D7AB", List.of(new PortCallIndex.Row(row.portAuthorityCode(), row.portAuthority(), "D7AB", row.listedDate(), row.reportedName(),
                    row.nationality(), row.kind(), row.purpose(), row.firstPortCode(), row.firstPortName(), row.prevPortCode(), row.prevPortName(),
                    row.nextPortCode(), row.nextPortName(), row.destPortCode(), row.destPortName(), row.entryAt(), row.entryRevision(), row.exitAt(),
                    row.exitRevision(), row.berth(), row.fetchedAt())));
            clock.addAndGet(PortCallReader.TTL_MS);
            k.shipFanout.refreshSelected();
            JsonNode ok = ofType(f, "ship_selected").getLast();
            assertThat(ofType(f, "ship_selected")).hasSize(2);
            assertThat(ok.path("port_calls").path("status").asString()).isEqualTo("ok");
            assertThat(ok.path("port_calls").path("items").get(0).path("reported_name").asString()).isEqualTo("AZAMARA PURSUIT");
            assertThat(ok.path("port_calls").path("items").get(0).path("berth").asString()).isEqualTo("북항크루즈터미널 2선석");
            assertThat(ok.path("state").path("lat").asDouble()).as("the rest of the message is the same").isEqualTo(35.1);
            clock.addAndGet(PortCallReader.TTL_MS);
            k.shipFanout.refreshSelected(); // 다시 읽어도 같은 값(새 객체) — 보내지 않는다
            assertThat(ofType(f, "ship_selected")).hasSize(2);
            assertThat(ofType(idle, "ship_selected")).isEmpty();
            assertThat(ofType(paused, "ship_selected")).as("only the answer to its own select_ship").hasSize(1);

            // 정적 정보를 아직 받지 못한 선박 → no_call_sign · not_received(호출부호를 아직 받지 않음 — '없음' 이 아니다)
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000002\"}");
            JsonNode nr = ofType(f, "ship_selected").getLast().path("port_calls");
            assertThat(nr.path("status").asString() + "/" + nr.path("call_sign_state").asString()).isEqualTo("no_call_sign/not_received");
            // 받은 호출부호가 찾는 형식 밖 → unusable
            publish(k, List.of(), List.of(new ShipStatic("440000002", "NO CS", "AB", null, 70, null, null, null, null, null, null, null, null, null, null,
                    T.minusSeconds(30), "aisstream")));
            JsonNode un = ofType(f, "ship_selected").getLast().path("port_calls");
            assertThat(un.path("status").asString() + "/" + un.path("call_sign_state").asString()).isEqualTo("no_call_sign/unusable");
            assertThat(index.queries).as("the index is read only for usable call signs").allMatch(q -> q.startsWith("D7AB "));
        }
    }

    /** 저장 정적 보고 가짜: MMSI → 정적 정보(없으면 null), fail 이면 DB 장애. 몇 번 읽었는지 센다. */
    static final class FakeStored implements StoredStaticReader.Source {
        final Map<String, ShipStatic> rows = new HashMap<>();
        volatile RuntimeException fail;
        final List<String> reads = new ArrayList<>();

        @Override public ShipStatic find(String mmsi) {
            reads.add(mmsi);
            if (fail != null) throw fail;
            return rows.get(mmsi);
        }
    }

    /**
     * static-fallback(계약 v5 §G17) 재현 · 고침: api 재시작 뒤 메모리(ShipStore)에 정적 정보가 없는 실시간 선박을 고르면 DB 의 마지막 저장 정적 보고를
     * stored 로 밝혀 싣고(static_updated_at = 저장 행의 updated_at), 입출항은 그 호출부호로 찾는다. 저장값은 메모리에 넣지 않는다(지도 목록의 ShipLite 에도
     * 없다). 한 선택을 되풀이해 다시 계산해도(선박 변화 · 주기 다시 보기) DB 는 캐시 동안 한 번 — 같은 값이면 다시 보내지 않는다. 스트림에 정적 보고가
     * 다시 오면 live 로 바뀌고 DB 는 더 읽지 않는다.
     */
    @Test void selectShip_withoutAStaticInMemory_usesTheStoredReport_markedStored_neverMergedIntoTheStore() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            java.util.concurrent.atomic.AtomicLong clock = new java.util.concurrent.atomic.AtomicLong(1_000_000);
            FakeStored db = new FakeStored();
            Instant storedAt = T.minusSeconds(5 * 3600); // 스트림 보존(약 2.5 h)보다 오래된 정적 보고
            ShipStatic kept = new ShipStatic("440000021", "AZAMARA PURSUIT", "V7A3884", null, 60, null, null, null, null, null, "KRPUS", null, null, null,
                    null, storedAt, "aisstream");
            db.rows.put("440000021", kept);
            k.shipFanout.setStoredStaticSource(ShipLookups.stored(new StoredStaticReader(db, clock::get, k.meters)));
            PortCallFixtures.FakeSource index = new PortCallFixtures.FakeSource();
            k.shipFanout.setPortCallSource(ShipLookups.portCalls(new PortCallReader(index, List::of, clock::get)));
            publish(k, List.of(pos("440000021", 35.1, 129.1, T)), List.of()); // 위치만(재시작 뒤 스트림 보존 창에 정적 보고가 없다)
            FakeWsSession f = session(k, "s", BUSAN, true);
            assertThat(ofType(f, "ships_snapshot").getLast().path("ships").get(0).has("name")).as("the map list stays live-only").isFalse();

            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000021\"}");
            JsonNode sel = ofType(f, "ship_selected").getLast();
            assertThat(sel.path("state").path("lat").asDouble()).isEqualTo(35.1);
            assertThat(sel.path("static").path("name").asString()).isEqualTo("AZAMARA PURSUIT");
            assertThat(sel.path("static").path("call_sign").asString()).isEqualTo("V7A3884");
            assertThat(sel.path("static_source").asString()).isEqualTo("stored");
            assertThat(sel.path("static_updated_at").asString()).isEqualTo(storedAt.toString()).isEqualTo(sel.path("static").path("updated_at").asString());
            assertThat(sel.path("destination_info").path("raw").asString()).as("destination of the stored report").isEqualTo("KRPUS");
            assertThat(sel.path("port_calls").path("call_sign").asString()).as("port calls use the stored call sign").isEqualTo("V7A3884");
            assertThat(sel.path("port_calls").path("status").asString()).isNotEqualTo("no_call_sign");
            // 메모리에 섞지 않는다
            assertThat(k.ships.staticOf("440000021")).isNull();
            assertThat(k.ships.view().get("440000021").stat()).isNull();
            assertThat(db.reads).containsExactly("440000021");

            // 되풀이 계산: 선박 이동(보낸다 — state 가 바뀜) · 주기 다시 보기(같은 값 — 보내지 않는다). DB 는 캐시 동안 더 읽지 않는다
            publish(k, List.of(pos("440000021", 35.2, 129.1, T.plusSeconds(10))), List.of());
            k.shipFanout.refreshSelected();
            assertThat(ofType(f, "ship_selected")).hasSize(2);
            assertThat(ofType(f, "ship_selected").getLast().path("static_source").asString()).isEqualTo("stored");
            assertThat(db.reads).as("one DB read per cache period").hasSize(1);
            clock.addAndGet(StoredStaticReader.TTL_MS);
            k.shipFanout.refreshSelected(); // 캐시가 지나 다시 읽었지만 같은 값 — 보내지 않는다
            assertThat(db.reads).hasSize(2);
            assertThat(ofType(f, "ship_selected")).hasSize(2);
            assertThat(ofType(f, "ships_diff").getLast().path("upsert").get(0).has("name")).as("still live-only on the map").isFalse();

            // 스트림에 정적 보고가 다시 왔다 → live(메모리 값 · 시각 없음), DB 는 더 읽지 않는다
            publish(k, List.of(), List.of(stat("440000021", "AZAMARA PURSUIT", 60)));
            JsonNode live = ofType(f, "ship_selected").getLast();
            assertThat(ofType(f, "ship_selected")).hasSize(3);
            assertThat(live.path("static_source").asString()).isEqualTo("live");
            assertThat(live.get("static_updated_at").isNull()).isTrue();
            assertThat(live.path("static").path("call_sign").asString()).isEqualTo("D7AB");
            clock.addAndGet(StoredStaticReader.TTL_MS);
            k.shipFanout.refreshSelected();
            assertThat(db.reads).hasSize(2);
        }
    }

    /**
     * 저장 정적 보고를 읽지 못함(DB 장애 · 시간 초과): static null · static_source stored_unavailable(저장돼 있는지 모름 — none 이 아니다) ·
     * 입출항 no_call_sign/not_received. 세션은 그대로다. 실패는 짧게만 기억한다({@link StoredStaticReader#ERROR_TTL_MS}) — DB 가 돌아오면 주기 다시 보기가
     * 저장값을 보낸다. DB 에도 없으면 none.
     */
    @Test void selectShip_storedReadFails_staticNullStoredUnavailable_noCallSign_thenRecovers() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            java.util.concurrent.atomic.AtomicLong clock = new java.util.concurrent.atomic.AtomicLong(1_000_000);
            FakeStored db = new FakeStored();
            db.rows.put("440000022", new ShipStatic("440000022", "STORED TWO", "D7AH", null, 70, null, null, null, null, null, null, null, null, null,
                    null, T.minusSeconds(9_000), "aisstream"));
            db.fail = new org.springframework.dao.QueryTimeoutException("statement timeout");
            k.shipFanout.setStoredStaticSource(ShipLookups.stored(new StoredStaticReader(db, clock::get, k.meters)));
            PortCallFixtures.FakeSource index = new PortCallFixtures.FakeSource();
            k.shipFanout.setPortCallSource(ShipLookups.portCalls(new PortCallReader(index, List::of, clock::get)));
            publish(k, List.of(pos("440000022", 35.1, 129.1, T), pos("440000023", 35.2, 129.2, T)), List.of());
            FakeWsSession f = session(k, "s", BUSAN, true);

            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000022\"}");
            JsonNode down = ofType(f, "ship_selected").getLast();
            assertThat(down.path("state").path("lat").asDouble()).as("the live state still goes out").isEqualTo(35.1);
            assertThat(down.get("static").isNull()).isTrue();
            assertThat(down.path("static_source").asString()).isEqualTo("stored_unavailable");
            assertThat(down.get("static_updated_at").isNull()).isTrue();
            assertThat(down.path("port_calls").path("status").asString() + "/" + down.path("port_calls").path("call_sign_state").asString())
                    .isEqualTo("no_call_sign/not_received");
            assertThat(f.open).isTrue();
            assertThat(k.meters.counter("wakeline_stored_static_errors_total").count()).isEqualTo(1.0);

            k.shipFanout.refreshSelected(); // 실패 기억 안 — 다시 읽지 않고 같은 값이라 보내지 않는다
            assertThat(db.reads).hasSize(1);
            assertThat(ofType(f, "ship_selected")).hasSize(1);
            db.fail = null; // DB 가 돌아왔다
            clock.addAndGet(StoredStaticReader.ERROR_TTL_MS);
            k.shipFanout.refreshSelected();
            JsonNode back = ofType(f, "ship_selected").getLast();
            assertThat(ofType(f, "ship_selected")).hasSize(2);
            assertThat(back.path("static_source").asString()).isEqualTo("stored");
            assertThat(back.path("static").path("call_sign").asString()).isEqualTo("D7AH");
            assertThat(back.path("port_calls").path("call_sign").asString()).isEqualTo("D7AH");

            // DB 에도 없는 선박(위치로만 만든 행 · 행 없음) → none
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000023\"}");
            JsonNode none = ofType(f, "ship_selected").getLast();
            assertThat(none.get("static").isNull()).isTrue();
            assertThat(none.path("static_source").asString()).isEqualTo("none");
            assertThat(none.path("port_calls").path("call_sign_state").asString()).isEqualTo("not_received");
            k.shipFanout.setStoredStaticSource(null); // 읽는 쪽을 뗀 구성 — 모름(null)
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000023\"}");
            assertThat(ofType(f, "ship_selected").getLast().get("static_source").isNull()).isTrue();
        }
    }

    @Test void portCallRefreshIsScheduledEveryReaderTtl_notAfterStop() throws Exception {
        final class Recording extends ScheduledThreadPoolExecutor {
            final List<Long> periods = new ArrayList<>();
            Recording() { super(1); }
            @Override public ScheduledFuture<?> scheduleWithFixedDelay(Runnable r, long initial, long delay, TimeUnit unit) {
                if (isShutdown()) throw new java.util.concurrent.RejectedExecutionException("stopped");
                periods.add(unit.toMillis(delay));
                return null;
            }
        }
        try (WsTestKit k = new WsTestKit()) {
            Recording timer = new Recording();
            ShipFanout f = new ShipFanout(k.hub, k.ships, k.meters, timer, k.shipClock::get);
            assertThat(f.isRunning()).as("running from construction — Spring never calls start()").isTrue();
            f.scheduleSelectedRefresh();
            assertThat(timer.periods).containsExactly(ShipFanout.SELECTED_REFRESH_MS);
            f.stop();
            f.scheduleSelectedRefresh(); // 멈춘 타이머 — 예약하지 못해도 예외 없이
            assertThat(timer.periods).hasSize(1);
            new ShipFanout(k.hub, k.ships, k.meters, null, k.shipClock::get).scheduleSelectedRefresh(); // 타이머 없음(시험 구성) — 아무것도 안 한다
        }
    }

    @Test void layersToggle_andPauseResume() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            publish(k, List.of(pos("440000001", 35.1, 129.1, T)), List.of());
            FakeWsSession f = session(k, "s", BUSAN, true);
            k.msg(f, "{\"type\":\"layers\",\"ships\":\"yes\"}");
            assertThat(ofType(f, "error").getLast().path("code").asString()).isEqualTo("BAD_LAYERS");
            k.msg(f, "{\"type\":\"layers\",\"ships\":false}");
            publish(k, List.of(pos("440000001", 35.2, 129.1, T.plusSeconds(10))), List.of());
            assertThat(sseqs(f)).containsExactly(1);
            k.msg(f, "{\"type\":\"layers\",\"ships\":true}");
            assertThat(sseqs(f)).containsExactly(1, 1);
            // 일시정지 중에는 보내지 않고, resume 의 초기 세트가 선박 스냅샷을 다시 보낸다
            k.msg(f, "{\"type\":\"pause\"}");
            publish(k, List.of(pos("440000001", 35.3, 129.1, T.plusSeconds(20))), List.of());
            assertThat(sseqs(f)).containsExactly(1, 1);
            k.msg(f, "{\"type\":\"resume\"}");
            assertThat(sseqs(f)).containsExactly(1, 1, 1);
            assertThat(ofType(f, "ships_snapshot").getLast().path("ships").get(0).path("lat").asDouble()).isEqualTo(35.3);
        }
    }

    @Test void aircraftLayerOff_stopsAircraftSnapshotsAndDiffs_onAgainStartsAtSeq1() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 35, 129, 30000, now, "adsb_lol"));
            FakeWsSession f = k.connect("s", "10.9.9.9");
            k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(f, "{\"type\":\"layers\",\"aircraft\":false,\"ships\":true}");
            k.msg(f, BUSAN);
            assertThat(types(f)).doesNotContain("snapshot").contains("alerts", "sigmets", "status", "ships_snapshot");
            k.publish("region", now.plusSeconds(10), ac("aaa001", 35.2, 129, 30000, now.plusSeconds(10), "adsb_lol"));
            assertThat(types(f)).doesNotContain("snapshot", "diff");
            k.msg(f, "{\"type\":\"layers\",\"aircraft\":true}");
            List<JsonNode> snaps = ofType(f, "snapshot");
            assertThat(snaps).hasSize(1);
            assertThat(snaps.getFirst().path("seq").asInt()).isEqualTo(1);
            k.publish("region", now.plusSeconds(20), ac("aaa001", 35.4, 129, 30000, now.plusSeconds(20), "adsb_lol"));
            assertThat(ofType(f, "diff").getFirst().path("seq").asInt()).isEqualTo(2);
            // 선택 항공기는 레이어와 무관하게 계속 받는다(명시적 선택)
            k.msg(f, "{\"type\":\"layers\",\"aircraft\":false}");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"aaa001\"}");
            k.publish("region", now.plusSeconds(30), ac("aaa001", 35.6, 129, 30000, now.plusSeconds(30), "adsb_lol"));
            assertThat(ofType(f, "selected").getLast().path("state").path("lat").asDouble()).isEqualTo(35.6);
            assertThat(ofType(f, "diff")).hasSize(1);
        }
    }

    /** 이벤트가 몰려도(분할 발행·만료) 팬아웃은 10 s 에 한 번 — 실행기를 흉내 내 지연 값을 본다. */
    @Test void fanoutIsThrottledToOncePerTenSeconds() throws Exception {
        final class Recording extends ScheduledThreadPoolExecutor {
            final List<Long> delays = new ArrayList<>();
            Recording() { super(1); }
            @Override public ScheduledFuture<?> schedule(Runnable r, long delay, TimeUnit unit) {
                delays.add(unit.toMillis(delay));
                r.run();
                return null;
            }
        }
        try (WsTestKit k = new WsTestKit()) {
            Recording timer = new Recording();
            ShipFanout throttled = new ShipFanout(k.hub, k.ships, k.meters, timer, k.shipClock::get);
            throttled.requestFanout();
            k.shipClock.addAndGet(3_000);
            throttled.requestFanout();
            assertThat(timer.delays).containsExactly(0L, ShipFanout.MIN_INTERVAL_MS - 3_000);
            throttled.stop();
            throttled.requestFanout();
            assertThat(timer.delays).hasSize(2);
            assertThat(throttled.isRunning()).isFalse();
            assertThat(throttled.getPhase()).isLessThan(Integer.MAX_VALUE - 100); // WS 허브보다 늦게 멈춘다
        }
    }

    @Test void changedRules() {
        ShipStore.Ship a = new ShipStore.Ship(pos("440000001", 35, 129, T), null);
        assertThat(ShipFanout.changed(null, a)).isTrue();
        assertThat(ShipFanout.changed(a, a)).isFalse();
        assertThat(ShipFanout.changed(a, new ShipStore.Ship(pos("440000001", 35.00005, 129, T.plusSeconds(10)), null))).as("GNSS jitter").isFalse();
        assertThat(ShipFanout.changed(a, new ShipStore.Ship(pos("440000001", 35.001, 129, T.plusSeconds(10)), null))).isTrue();
        ShipState noSpeed = new ShipState("440000001", 35, 129, null, 45.0, 44, 0, 3, "epfs", T.plusSeconds(5), "aisstream", "PositionReport", "A");
        assertThat(ShipFanout.changed(a, new ShipStore.Ship(noSpeed, null))).as("speed became unknown").isTrue();
        ShipState manual = new ShipState("440000001", 35, 129, 12.0, 45.0, 44, 0, 3, "manual", T.plusSeconds(5), "aisstream", "PositionReport", "A");
        assertThat(ShipFanout.changed(a, new ShipStore.Ship(manual, null))).isTrue();
    }

    /**
     * 리뷰 cto-2026-10 A4(B10): 선택 선박 다시 계산(입출항 색인 갱신 · 오래됨 — 주기 작업)의 예외는 주기를 멈추지 않게 삼킨다. 예전에는 흔적이 없었다 —
     * 이제 wakeline_ws_ship_refresh_errors_total 로 세고 DEBUG 한 줄.
     */
    @Test
    void aFailingSelectedShipRefreshIsCountedAndDoesNotEscape() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            ShipFanout f = new ShipFanout(k.hub, k.ships, k.meters, null, k.shipClock::get) {
                @Override void recheckSelected(WsSession s) { throw new IllegalStateException("bug"); }
            };
            k.subscribed("s1", "1.2.3.4");
            org.assertj.core.api.Assertions.assertThatCode(f::refreshSelected).doesNotThrowAnyException();
            assertThat(k.meters.find("wakeline_ws_ship_refresh_errors_total").counter().count()).isEqualTo(1.0);
        }
    }
}
