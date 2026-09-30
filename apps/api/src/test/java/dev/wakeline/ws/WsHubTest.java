package dev.wakeline.ws;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.domain.Alert;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.engine.AlertStateMachine;
import dev.wakeline.engine.EngineEvents;
import dev.wakeline.engine.PredictionAvailability;
import dev.wakeline.ingest.IngestEvents;
import dev.wakeline.ingest.RadarStore;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.CloseStatus;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

import static dev.wakeline.ws.WsTestKit.ac;
import static dev.wakeline.ws.WsTestKit.ofType;
import static dev.wakeline.ws.WsTestKit.types;
import static org.assertj.core.api.Assertions.assertThat;

/** 팬아웃 허브: seq 연속성, 비차단 팬아웃·단일 비행, 알림 버전·재동기, SIGMET/레이더 버전, select, 타이머. */
class WsHubTest {

    /** 보낸 snapshot/diff 의 seq 를 순서대로 */
    static List<Integer> seqs(FakeWsSession f) {
        List<Integer> out = new ArrayList<>();
        for (String s : f.sent) {
            JsonNode n = WsTestKit.parse(s);
            String t = n.path("type").asString();
            if (t.equals("snapshot") || t.equals("diff")) out.add(n.path("seq").asInt());
        }
        return out;
    }

    static void await(BooleanSupplier cond) throws InterruptedException {
        long end = System.nanoTime() + 5_000_000_000L;
        while (!cond.getAsBoolean()) {
            if (System.nanoTime() > end) throw new AssertionError("timed out");
            Thread.sleep(5);
        }
    }

    static Alert alert(long id, String kind, String hex, Instant at, Integer etaS) {
        return new Alert(id, kind, hex, "KAL081", "S1", "RKRR", "TS", null, at, null, null, etaS,
                etaS == null ? null : at.plusSeconds(etaS), 35000, Map.of("judged_at", at.toString()), "PREDICTED".equals(kind));
    }

    static EngineEvents.AlertsChanged changed(AlertStateMachine.EventType t, Alert a) {
        return new EngineEvents.AlertsChanged(List.of(new AlertStateMachine.Event(t, a)));
    }

    static SigmetRecord sig(String id, Instant from, Instant to) {
        return new SigmetRecord(id, "RKRR", null, null, "1", "TS", null, 0, null, from, to, null, "no_polygon",
                null, null, null, "RAW", "awc_isigmet", from, SigmetRecord.BASE_ASSUMED_SURFACE, SigmetRecord.TOP_UNKNOWN);
    }

    // ---------------------------------------------------------------- seq

    @Test void seq_isContiguousPerSession_emptyDiffsNotSent_globalRegionInterleaved() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession f = k.subscribed("s1", "1.1.1.1");
            assertThat(types(f)).containsExactly("welcome", "snapshot", "alerts", "sigmets", "radar", "status");

            k.publish("region", now.plusSeconds(10), ac("aaa001", 36.1, 127, 30000, now.plusSeconds(10), "adsb_lol")); // diff seq 2
            AircraftState same = ac("aaa001", 36.1, 127, 30000, now.plusSeconds(10), "adsb_lol");
            k.publish("region", now.plusSeconds(20), same);                                                             // 변화 없음 → 안 보냄
            k.publish("global", now.plusSeconds(21), ac("bbb001", 50, 10, 30000, now, "opensky"));                   // bbox 밖 → 안 보냄
            k.publish("global", now.plusSeconds(22), ac("bbb002", 35, 128, 30000, now, "opensky"));                  // bbox 안 → diff seq 3
            k.publish("region", now.plusSeconds(30), ac("aaa001", 36.3, 127, 30000, now.plusSeconds(30), "adsb_lol")); // diff seq 4

            assertThat(seqs(f)).containsExactly(1, 2, 3, 4);
            List<JsonNode> diffs = ofType(f, "diff");
            assertThat(diffs.get(1).path("upsert").get(0).path("hex").asString()).isEqualTo("bbb002");
            assertThat(diffs.get(1).path("upsert").get(0).path("provider").asString()).isEqualTo("opensky");
        }
    }

    @Test void clientResync_sendsSnapshotImmediately_seqRestartsAt1() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession f = k.subscribed("s1", "1.1.1.1");
            k.publish("region", now.plusSeconds(10), ac("aaa001", 36.2, 127, 30000, now, "adsb_lol"));
            k.msg(f, "{\"type\":\"resync\"}");
            assertThat(seqs(f)).containsExactly(1, 2, 1);
            k.publish("region", now.plusSeconds(20), ac("aaa001", 36.4, 127, 30000, now, "adsb_lol"));
            assertThat(seqs(f)).containsExactly(1, 2, 1, 2);
        }
    }

    /**
     * 계약 v5 §E2(2차 리뷰): 웹이 형식 오류로 버린 알림 · SIGMET · 레이더 메시지는 {type:"resync", scope} 로 그 목록만 다시 받는다 — 버전이 그대로여도
     * 전체를 보내고, 항공기 스냅샷 · 선박은 보내지 않는다(scope 없는 resync 만 스냅샷). 전체 알림 목록 뒤의 배치는 그 버전에서 이어진다. 모르는 scope 는 BAD_RESYNC.
     */
    @Test void clientResyncScope_resendsOnlyThatFullList_evenWhenItsVersionIsUnchanged() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            var st = k.sigmets.replace(now, "awc_isigmet", Map.of("S1", sig("S1", now.minusSeconds(60), now.plusSeconds(3600))));
            k.radar.replace(new RadarStore.Frames("https://tilecache.rainviewer.com", 1, List.of(new RadarStore.Frame(1, "/v2/radar/1")), now, "rainviewer"));
            FakeWsSession f = k.subscribed("s1", "1.1.1.1");
            k.hub.onAlerts(changed(AlertStateMachine.EventType.ENTERED, alert(1, "OBSERVED", "aaa001", now, null))); // 배치 v1
            k.alerts.set(List.of(alert(1, "OBSERVED", "aaa001", now, null)));
            f.clear();

            k.msg(f, "{\"type\":\"resync\",\"scope\":\"alerts\"}");
            assertThat(types(f)).containsExactly("alerts");
            JsonNode full = ofType(f, "alerts").get(0);
            assertThat(full.path("version").asLong()).isEqualTo(1);
            assertThat(full.path("alerts").get(0).path("id").asLong()).isEqualTo(1);
            k.hub.onAlerts(changed(AlertStateMachine.EventType.LEFT, alert(1, "OBSERVED", "aaa001", now, null).closed(now, Alert.CLOSE_LEFT, null)));
            assertThat(ofType(f, "alerts_batch")).extracting(n -> n.path("version").asLong()).containsExactly(2L);

            f.clear();
            k.msg(f, "{\"type\":\"resync\",\"scope\":\"sigmets\"}");
            assertThat(types(f)).containsExactly("sigmets");
            assertThat(ofType(f, "sigmets").get(0).path("v").asLong()).isEqualTo(st.version());

            f.clear();
            k.msg(f, "{\"type\":\"resync\",\"scope\":\"radar\"}");
            assertThat(types(f)).containsExactly("radar");

            f.clear();
            k.msg(f, "{\"type\":\"resync\",\"scope\":\"aircraft\"}");
            k.msg(f, "{\"type\":\"resync\",\"scope\":1}");
            assertThat(ofType(f, "error")).extracting(n -> n.path("code").asString()).containsExactly("BAD_RESYNC", "BAD_RESYNC");
            assertThat(types(f)).containsOnly("error");
            assertThat(seqs(f)).isEmpty();

            // 일시정지 중에는 보내지 않는다 — resume 이 전체 초기 세트를 보낸다
            k.msg(f, "{\"type\":\"pause\"}");
            f.clear();
            k.msg(f, "{\"type\":\"resync\",\"scope\":\"alerts\"}");
            assertThat(f.sent).isEmpty();
            assertThat(f.open).isTrue();
        }
    }

    @Test void periodicResync_30sForLite_120sForWorld() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession lite = k.subscribed("lite", "1.1.1.1");
            FakeWsSession world = k.connect("world", "1.1.1.2");
            k.msg(world, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(world, "{\"type\":\"subscribe\",\"bbox\":[-180,-90,180,90],\"zoom\":3}");
            WsSession ls = k.handler.session("lite"), ws = k.handler.session("world");
            ls.lastFullAt = Instant.now().minusSeconds(31);
            ws.lastFullAt = Instant.now().minusSeconds(31);
            k.publish("region", now.plusSeconds(10), ac("aaa001", 36.2, 127, 30000, now, "adsb_lol"));
            assertThat(seqs(lite)).containsExactly(1, 1);   // 30 s 지남 → 스냅샷
            assertThat(seqs(world)).containsExactly(1, 2);  // 줌 ≤ 5 는 120 s → diff
            ws.lastFullAt = Instant.now().minusSeconds(121);
            k.publish("region", now.plusSeconds(20), ac("aaa001", 36.4, 127, 30000, now, "adsb_lol"));
            assertThat(seqs(world)).containsExactly(1, 2, 1);
            // world 인코딩: vrate·quality 없음, seen_at·provider 있음
            JsonNode a = ofType(world, "snapshot").get(1).path("aircraft").get(0);
            assertThat(a.has("seen_at")).isTrue();
            assertThat(a.has("provider")).isTrue();
            assertThat(a.has("quality")).isFalse();
            assertThat(ofType(lite, "snapshot").get(0).path("aircraft").get(0).has("quality")).isTrue();
        }
    }

    @Test void snapshot_carriesPerScopeSources() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("global", now.minusSeconds(400), ac("bbb001", 35, 128, 30000, now, "opensky"));
            k.publish("region", now.minusSeconds(5), ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession f = k.subscribed("s1", "1.1.1.1");
            JsonNode src = ofType(f, "snapshot").get(0).path("sources");
            assertThat(src.path("region").path("stale").asBoolean()).isFalse();
            assertThat(src.path("global").path("provider").asString()).isEqualTo("opensky");
            assertThat(src.path("global").path("stale").asBoolean()).isTrue();   // 300 s 초과
            assertThat(src.path("global").path("lag_s").asDouble()).isGreaterThan(399);
        }
    }

    // ---------------------------------------------------------------- 비차단 팬아웃

    @Test void stalledClient_neverBlocksIngestThread_orOtherSessions_andIsCoalesced() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession slow = k.subscribed("slow", "1.1.1.1");
            FakeWsSession fast = k.subscribed("fast", "1.1.1.2");
            WsSession ss = k.handler.session("slow"), fs = k.handler.session("fast");
            await(() -> ss.idle() && fs.idle());
            CountDownLatch gate = new CountDownLatch(1);
            slow.gate = gate; // 읽지 않는 클라이언트: 전송이 막힌다

            for (int i = 1; i <= 6; i++) {
                long t0 = System.nanoTime();
                k.publish("region", now.plusSeconds(10L * i), ac("aaa001", 36 + 0.1 * i, 127, 30000, now.plusSeconds(10L * i), "adsb_lol"));
                assertThat((System.nanoTime() - t0) / 1_000_000).as("onSnapshot returns without waiting").isLessThan(500);
                int n = i;
                await(() -> ofType(fast, "diff").size() == n); // 다른 세션은 계속 받는다
            }
            // 막힌 세션: 실행 중 1 + 대기 1 이상 쌓이지 않는다(합쳐짐)
            assertThat(ss.isScheduled(WsSession.Job.FANOUT)).isTrue();
            assertThat(k.meters.counter("wakeline_ws_coalesced_total").count()).isGreaterThanOrEqualTo(4);

            gate.countDown();
            await(ss::idle);
            List<JsonNode> diffs = ofType(slow, "diff");
            assertThat(diffs).hasSizeLessThanOrEqualTo(2);
            assertThat(seqs(slow)).containsExactly(1, 2, 3).hasSize(1 + diffs.size());
            // 마지막으로 받은 상태가 최신(건너뛴 버전의 변화도 빠지지 않음)
            assertThat(diffs.get(diffs.size() - 1).path("upsert").get(0).path("lat").asDouble()).isEqualTo(36.6, org.assertj.core.data.Offset.offset(1e-9));
            assertThat(slow.maxConcurrentSends).isEqualTo(1); // 세션당 전송은 항상 한 스레드
        } finally {
            pool.shutdownNow();
        }
    }

    @Test void subscribeSpam_isCoalesced_latestBboxWins() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"), ac("aaa002", 20, 100, 30000, now, "adsb_lol"));
            FakeWsSession f = k.connect("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
            WsSession s = k.handler.session("s");
            await(s::idle);
            CountDownLatch gate = new CountDownLatch(1);
            f.gate = gate;
            k.msg(f, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
            await(() -> f.concurrentSends.get() == 1); // 첫 초기 전송이 막혀 있다
            for (int i = 0; i < 10; i++) k.msg(f, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
            k.msg(f, "{\"type\":\"subscribe\",\"bbox\":[95,15,105,25],\"zoom\":7}"); // 마지막 bbox
            gate.countDown();
            await(s::idle);
            List<JsonNode> snaps = ofType(f, "snapshot");
            assertThat(snaps).hasSize(2); // 실행 중 1 + 합쳐진 1
            JsonNode last = snaps.get(1).path("aircraft");
            assertThat(last.size()).isEqualTo(1);
            assertThat(last.get(0).path("hex").asString()).isEqualTo("aaa002");
            // 두 번째 초기 전송은 이미 받은 알림·SIGMET·레이더를 다시 보내지 않는다(PERF-9)
            assertThat(ofType(f, "alerts")).hasSize(1);
            assertThat(ofType(f, "sigmets")).hasSize(1);
            assertThat(ofType(f, "radar")).hasSize(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test void closedSession_queuedWorkIsDropped_beforeSerializing() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            WsSession s = k.handler.session("s");
            await(s::idle);
            CountDownLatch gate = new CountDownLatch(1);
            f.gate = gate;
            k.publish("region", now.plusSeconds(10), ac("aaa001", 36.1, 127, 30000, now, "adsb_lol"));
            k.publish("region", now.plusSeconds(20), ac("aaa001", 36.2, 127, 30000, now, "adsb_lol"));
            k.hub.onAlerts(changed(AlertStateMachine.EventType.ENTERED, alert(1, "OBSERVED", "aaa001", now, null)));
            k.handler.afterConnectionClosed(f, CloseStatus.GOING_AWAY);
            f.open = false;
            gate.countDown();
            await(s::idle);
            Thread.sleep(50);
            // 이미 전송 중이던 diff 하나만 끝나고, 대기 중이던 팬아웃·알림 작업은 직렬화 전에 버려졌다
            assertThat(ofType(f, "diff")).hasSizeLessThanOrEqualTo(1);
            assertThat(ofType(f, "alerts_batch")).isEmpty();
            assertThat(k.hub.count()).isZero();
            assertThat(k.handler.limiter().total()).isZero();
        } finally {
            pool.shutdownNow();
        }
    }

    // ---------------------------------------------------------------- 알림

    @Test void alerts_versionedBatches_includeCloseReasonAndEtaAt() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            assertThat(ofType(f, "alerts").get(0).path("version").asLong()).isZero();
            Alert p = alert(1, "PREDICTED", "aaa001", now, 300);
            k.hub.onAlerts(changed(AlertStateMachine.EventType.PREDICTED, p));
            Alert lost = alert(2, "OBSERVED", "aaa002", now, null).closed(now, Alert.CLOSE_SIGNAL_LOST, Map.of("absent_snapshots", 3));
            k.hub.onAlerts(changed(AlertStateMachine.EventType.LOST, lost));
            List<JsonNode> b = ofType(f, "alerts_batch");
            assertThat(b).extracting(n -> n.path("version").asLong()).containsExactly(1L, 2L);
            JsonNode item = b.get(0).path("items").get(0);
            assertThat(item.path("event").asString()).isEqualTo("PREDICTED");
            assertThat(item.path("alert").path("eta_at").asString()).isEqualTo(now.plusSeconds(300).toString());
            assertThat(item.path("alert").path("estimated").asBoolean()).isTrue();
            JsonNode l = b.get(1).path("items").get(0);
            assertThat(l.path("event").asString()).isEqualTo("LOST");
            assertThat(l.path("alert").path("close_reason").asString()).isEqualTo("signal_lost");
        }
    }

    @Test void pauseResume_resendsFullInitialSet_withCurrentAlertList() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"pause\"}");
            f.clear();
            Alert a = alert(1, "OBSERVED", "aaa001", now, null);
            k.alerts.set(List.of());
            k.hub.onAlerts(changed(AlertStateMachine.EventType.ENTERED, a));
            k.hub.onAlerts(changed(AlertStateMachine.EventType.LEFT, a.closed(now, Alert.CLOSE_LEFT, null)));
            var st = k.sigmets.replace(now, "awc_isigmet", Map.of("S1", sig("S1", now.minusSeconds(60), now.plusSeconds(3600))));
            k.hub.onSigmets(new IngestEvents.SigmetsUpdated(st));
            assertThat(f.sent).isEmpty(); // 일시정지 중엔 보내지 않는다

            k.msg(f, "{\"type\":\"resume\"}");
            assertThat(types(f)).containsExactly("snapshot", "alerts", "sigmets", "radar", "status");
            JsonNode full = ofType(f, "alerts").get(0);
            assertThat(full.path("version").asLong()).isEqualTo(2);
            assertThat(full.path("alerts").size()).isZero(); // 끝난 알림은 목록에 없다
            assertThat(ofType(f, "sigmets").get(0).path("v").asLong()).isEqualTo(st.version());
            // WS-5: 시각 의존 값(active·expiring_soon)의 기준 시각을 밝힌다
            Instant computedAt = Instant.parse(ofType(f, "sigmets").get(0).path("computed_at").asString());
            assertThat(computedAt).isBetween(now.minusSeconds(1), Instant.now().plusSeconds(1));
        }
    }

    /** DH-6: 경보 종료(SIGMET_ENDED) 이벤트는 그 이름 그대로 알림 배치에 실린다(LEFT 로 바뀌지 않는다). */
    @Test void sigmetEndedEvent_isSentWithItsOwnName() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            f.clear();
            Alert a = alert(1, "OBSERVED", "aaa001", now, null);
            k.hub.onAlerts(changed(AlertStateMachine.EventType.SIGMET_ENDED, a.closed(now, Alert.CLOSE_SIGMET_ENDED, Map.of("end_cause", "expired"))));
            JsonNode item = ofType(f, "alerts_batch").get(0).path("items").get(0);
            assertThat(item.path("event").asString()).isEqualTo("SIGMET_ENDED");
            assertThat(item.path("alert").path("close_reason").asString()).isEqualTo("sigmet_ended");
            assertThat(item.path("alert").path("evidence").path("end_cause").asString()).isEqualTo("expired");
        }
    }

    @Test void slowSession_catchesUpMissedBatchesInOrder_orGetsFullListWhenHistoryExceeded() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            WsSession s = k.handler.session("s");
            await(s::idle);
            CountDownLatch gate = new CountDownLatch(1);
            f.gate = gate;
            k.publish("region", now.plusSeconds(10), ac("aaa001", 36.1, 127, 30000, now, "adsb_lol")); // 전송이 막힌다
            for (int i = 1; i <= 3; i++) k.hub.onAlerts(changed(AlertStateMachine.EventType.ENTERED, alert(i, "OBSERVED", "aaa00" + i, now, null)));
            gate.countDown();
            await(s::idle);
            assertThat(ofType(f, "alerts_batch")).extracting(n -> n.path("version").asLong()).containsExactly(1L, 2L, 3L);

            f.clear();
            CountDownLatch gate2 = new CountDownLatch(1);
            f.gate = gate2;
            k.publish("region", now.plusSeconds(20), ac("aaa001", 36.2, 127, 30000, now, "adsb_lol"));
            for (int i = 0; i < WsHub.ALERT_BATCH_HISTORY + 6; i++) k.hub.onAlerts(changed(AlertStateMachine.EventType.ENTERED, alert(100 + i, "OBSERVED", "c" + i, now, null)));
            gate2.countDown();
            await(s::idle);
            assertThat(ofType(f, "alerts_batch")).isEmpty();
            assertThat(ofType(f, "alerts")).singleElement().satisfies(n -> assertThat(n.path("version").asLong()).isEqualTo(3 + WsHub.ALERT_BATCH_HISTORY + 6));
        } finally {
            pool.shutdownNow();
        }
    }

    @Test void stateResyncFlag_nextFanoutSendsFullSet() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            f.clear();
            k.handler.session("s").stateResync.set(true);
            k.publish("region", now.plusSeconds(10), ac("aaa001", 36.1, 127, 30000, now, "adsb_lol"));
            assertThat(types(f)).containsExactly("snapshot", "alerts", "radar", "status");
        }
    }

    @Test void alertsAndSigmetPayloads_areSerializedOnce_andShared() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession a = k.subscribed("a", "1.1.1.1");
            FakeWsSession b = k.subscribed("b", "1.1.1.2");
            assertThat(a.ofType("alerts").get(0)).isSameAs(b.ofType("alerts").get(0));
            assertThat(a.ofType("sigmets").get(0)).isSameAs(b.ofType("sigmets").get(0));
            assertThat(a.ofType("status").get(0)).isSameAs(b.ofType("status").get(0));
        }
    }

    // ---------------------------------------------------------------- SIGMET · 레이더

    @Test void sigmets_sentOncePerVersion_andPushedOnExpiry() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            var st = k.sigmets.replace(now, "awc_isigmet", Map.of("S1", sig("S1", now.minusSeconds(60), now.plusSeconds(3600))));
            k.hub.onSigmets(new IngestEvents.SigmetsUpdated(st));
            k.hub.onSigmets(new IngestEvents.SigmetsUpdated(st));  // 같은 v — 다시 보내지 않음
            k.msg(f, "{\"type\":\"subscribe\",\"bbox\":[125,33,132,39],\"zoom\":7}"); // 팬 — 받은 v 는 다시 보내지 않음
            var expired = k.sigmets.republish();
            k.hub.onSigmetsExpired(new IngestEvents.SigmetsExpired(expired, Set.of("S0")));
            assertThat(ofType(f, "sigmets")).extracting(n -> n.path("v").asLong()).containsExactly(0L, st.version(), expired.version());
            JsonNode props = ofType(f, "sigmets").get(1).path("collection").path("features").get(0).path("properties");
            assertThat(props.path("id").asString()).isEqualTo("S1");
        }
    }

    @Test void radar_pushedOnChangeOnly() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            var frames = new RadarStore.Frames("https://tilecache.rainviewer.com", 1, List.of(new RadarStore.Frame(1, "/v2/radar/1")), Instant.now(), "rainviewer");
            k.radar.replace(frames);
            k.hub.onRadar(new IngestEvents.RadarUpdated(frames));
            k.hub.onRadar(new IngestEvents.RadarUpdated(frames));
            assertThat(ofType(f, "radar")).hasSize(2); // 초기 1 + 변경 1
        }
    }

    // ---------------------------------------------------------------- 우편함 작업 예외(R-73)

    /**
     * 우편함 작업이 예외로 끝나면 조용히 삼키지 않는다: wakeline_ws_task_errors_total{job} 로 세고, 그 세션은 다음 팬아웃에서 전체 초기 세트
     * (스냅샷 seq 1 · 알림 · 레이더 · status)로 되돌린다 — diff 계산이 sent 를 먼저 바꾸므로 예외 뒤의 세션 상태는 클라이언트보다 앞서 있을 수 있다.
     * 결함 주입: 선택 항공기의 예측 조회가 팬아웃 작업 안에서 던진다.
     */
    @Test void outboxTaskError_isCounted_andTheNextFanoutResyncsTheSession() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 36, 127, 30000, now, "adsb_lol"));
            FakeWsSession f = k.subscribed("s1", "1.1.1.1");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"aaa001\"}");
            k.prediction = a -> { throw new IllegalStateException("prediction bug"); };
            k.publish("region", now.plusSeconds(10), ac("aaa001", 36.1, 127, 30000, now.plusSeconds(10), "adsb_lol"));
            assertThat(k.meters.counter("wakeline_ws_task_errors_total", "job", "fanout").count()).isEqualTo(1.0);
            assertThat(f.open).as("the session stays open").isTrue();

            k.prediction = a -> a == null ? new PredictionAvailability(false, null) : PredictionAvailability.AVAILABLE;
            int before = f.sent.size();
            k.publish("region", now.plusSeconds(20), ac("aaa001", 36.2, 127, 30000, now.plusSeconds(20), "adsb_lol"));
            List<String> next = types(f).subList(before, f.sent.size());
            assertThat(next).as("full initial set after the failed task").contains("snapshot", "alerts", "radar", "status", "selected");
            assertThat(seqs(f).getLast()).isEqualTo(1);
            // 다음부터는 평소대로 diff
            k.publish("region", now.plusSeconds(30), ac("aaa001", 36.3, 127, 30000, now.plusSeconds(30), "adsb_lol"));
            assertThat(seqs(f).getLast()).isEqualTo(2);

            // 같은 결함이 1분 안에 되풀이되면 세기만 한다(로그 폭주 없음) — 세션은 매번 재동기로 돌아온다
            k.prediction = a -> { throw new IllegalStateException("prediction bug"); };
            k.publish("region", now.plusSeconds(40), ac("aaa001", 36.4, 127, 30000, now.plusSeconds(40), "adsb_lol"));
            assertThat(k.meters.counter("wakeline_ws_task_errors_total", "job", "fanout").count()).isEqualTo(2.0);
            assertThat(k.meters.counter("wakeline_ws_task_errors_total", "job", "reply").count()).isZero(); // 미리 등록된 0
        }
    }

    // ---------------------------------------------------------------- select

    @Test void select_repliesImmediately_thenOnChangeOnly_evenOutsideBbox() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.prediction = a -> a == null ? new PredictionAvailability(false, null) : PredictionAvailability.unavailable("turning");
            AircraftState far = new AircraftState("bbb001", "AFR11", "F-GSQA", "B77W", "A5", 50, 10, 36000, 480.0, 90.0, 0.0,
                    false, null, now, "opensky", now, 0, false);
            k.publish("global", now, far);
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"BBB001\"}");
            List<JsonNode> sel = ofType(f, "selected");
            assertThat(sel).hasSize(1);
            assertThat(sel.get(0).path("hex").asString()).isEqualTo("bbb001");
            assertThat(sel.get(0).path("state").path("registration").asString()).isEqualTo("F-GSQA"); // full 인코딩
            assertThat(sel.get(0).path("prediction").path("available").asBoolean()).isFalse();
            assertThat(sel.get(0).path("prediction").path("reason").asString()).isEqualTo("turning");

            k.publish("region", now.plusSeconds(10), ac("aaa001", 36, 127, 30000, now, "adsb_lol")); // 선택 항공기 그대로 → 안 보냄
            assertThat(ofType(f, "selected")).hasSize(1);
            AircraftState moved = new AircraftState("bbb001", "AFR11", "F-GSQA", "B77W", "A5", 50, 10.5, 36000, 480.0, 90.0, 0.0,
                    false, null, now.plusSeconds(5), "opensky", now.plusSeconds(5), 0, false);
            k.publish("global", now.plusSeconds(20), moved);
            assertThat(ofType(f, "selected")).hasSize(2);
            k.publish("global", now.plusSeconds(30));                                                   // 스냅샷에서 사라짐
            List<JsonNode> all = ofType(f, "selected");
            assertThat(all).hasSize(3);
            assertThat(all.get(2).get("state").isNull()).isTrue();
            assertThat(all.get(2).path("prediction").path("available").asBoolean()).isFalse();

            k.msg(f, "{\"type\":\"select\",\"hex\":\"zz\"}");
            assertThat(ofType(f, "error").get(0).path("code").asString()).isEqualTo("BAD_HEX");
            k.msg(f, "{\"type\":\"select\",\"hex\":null}");
            k.publish("global", now.plusSeconds(40), moved);
            assertThat(ofType(f, "selected")).hasSize(3);
        }
    }

    // ---------------------------------------------------------------- 수요 스코프(hot·focus, 계약 v2 §A3)

    @Test void hotSnapshot_fansOutOnlyToSessionsWhoseBboxOverlapsTheChange() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            FakeWsSession korea = k.subscribed("korea", "1.1.1.1");
            FakeWsSession tokyo = k.connect("tokyo", "1.1.1.2");
            k.msg(tokyo, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(tokyo, "{\"type\":\"subscribe\",\"bbox\":[138,34,142,37],\"zoom\":8}");
            korea.clear();
            tokyo.clear();
            k.publishHot("35.5:139.5:150", now, ac("ccc001", 35.6, 139.7, 30000, now, "adsb_fi"));
            assertThat(ofType(tokyo, "diff")).singleElement().satisfies(d ->
                    assertThat(d.path("upsert").get(0).path("hex").asString()).isEqualTo("ccc001"));
            assertThat(korea.sent).isEmpty(); // 범위 밖 세션은 팬아웃하지 않는다
            // 셀에서 사라짐(이전 위치가 범위에 있다) → remove
            k.publishHot("35.5:139.5:150", now.plusSeconds(30));
            assertThat(ofType(tokyo, "diff").getLast().path("remove").get(0).asString()).isEqualTo("ccc001");
            assertThat(WsHub.envelope(List.of(), List.of())).isNull();
        }
    }

    @Test void focusUpdate_sendsSelectedEveryObservation_evenOutsideBbox_noDuplicates() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            FakeWsSession far = k.subscribed("far", "1.1.1.1");       // 한국 화면, 대서양 항공기 선택
            FakeWsSession near = k.connect("near", "1.1.1.2");       // 그 항공기가 화면 안
            k.msg(near, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(near, "{\"type\":\"subscribe\",\"bbox\":[-45,35,-35,45],\"zoom\":8}");
            k.msg(far, "{\"type\":\"select\",\"hex\":\"ddd001\"}");
            k.msg(near, "{\"type\":\"select\",\"hex\":\"ddd001\"}");
            assertThat(ofType(far, "selected")).hasSize(1); // 즉시 응답(아직 상태 없음)
            for (int i = 1; i <= 3; i++) {
                Instant t = now.plusSeconds(5L * i);
                k.publishFocus(t, ac("ddd001", 40, -40 + i * 0.01, 36000, t, "adsb_fi"));
            }
            List<JsonNode> sel = ofType(far, "selected");
            assertThat(sel).hasSize(4); // 즉시 1 + focus 관측마다 1
            assertThat(sel.getLast().path("state").path("provider").asString()).isEqualTo("adsb_fi");
            assertThat(ofType(far, "diff")).isEmpty(); // 화면 밖이라 항공기 diff 는 없다
            assertThat(ofType(near, "selected")).hasSize(4); // 팬아웃과 selected 작업이 같은 관측을 두 번 보내지 않는다
            assertThat(ofType(near, "diff")).hasSize(3);
            // 같은 보고를 다시 실어 온 focus 메시지(새 상태 객체지만 보이는 값이 모두 같다) — 클라이언트가 볼 것이 없어 보내지 않는다(사용자 보고 2026-09-30:
            // 같은 내용의 selected 두 번). 고치기 전에는 새 객체라 다시 갔다.
            Instant t3 = now.plusSeconds(15);
            k.publishFocus(now.plusSeconds(20), ac("ddd001", 40, -40 + 3 * 0.01, 36000, t3, "adsb_fi"));
            assertThat(ofType(far, "selected")).hasSize(4);
            // seen_at 은 같지만 공급자에서 새로 받았다(fetched_at — full 인코딩에 있다) — 보이는 값이 바뀌어 보낸다(집중 추적 갱신마다)
            k.publishFocus(now.plusSeconds(25), new AircraftState("ddd001", "CSddd", null, null, null, 40, -40 + 3 * 0.01, 36000, 400.0, 90.0, 0.0,
                    false, null, t3, "adsb_fi", now.plusSeconds(25), 0, false));
            assertThat(ofType(far, "selected")).hasSize(5);
            List<JsonNode> last2 = ofType(far, "selected").subList(3, 5);
            assertThat(last2.get(1).path("state").path("fetched_at").asString()).isNotEqualTo(last2.get(0).path("state").path("fetched_at").asString());
        }
    }

    @Test void demandListener_firesOnSubscribeSelectPauseResumeAndClose() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            java.util.concurrent.atomic.AtomicInteger n = new java.util.concurrent.atomic.AtomicInteger();
            k.hub.setDemandListener(n::incrementAndGet);
            FakeWsSession f = k.subscribed("s", "1.1.1.1");              // subscribe
            k.msg(f, "{\"type\":\"select\",\"hex\":\"abc123\"}"); // select
            k.msg(f, "{\"type\":\"pause\"}");
            k.msg(f, "{\"type\":\"resume\"}");
            k.msg(f, "{\"type\":\"resume\"}");                        // 일시정지가 아니었다 → 변화 없음
            k.handler.afterConnectionClosed(f, CloseStatus.NORMAL);         // 창 닫기
            assertThat(n.get()).isEqualTo(5);
            k.hub.setDemandListener(null);
            k.hub.demandChanged(); // 리스너 없음 — 아무 일도 없다
        }
    }

    /** 선박 선택은 수요를 다시 계산하지 않는다(입출항은 DB 색인 — 임대 없음, ADR-022 개정). 고르고 풀어도 수요 리스너는 불리지 않는다. */
    @Test void selectingOrClearingAShipDoesNotRecomputeDemand() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            java.util.concurrent.atomic.AtomicInteger n = new java.util.concurrent.atomic.AtomicInteger();
            k.hub.setDemandListener(n::incrementAndGet);
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"440000001\"}");
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":null}");
            assertThat(n.get()).isZero();
        }
    }

    // ---------------------------------------------------------------- 타이머 · heartbeat

    @Test void helloTimeout_closesExactlyAfterDeadline_perSession() throws Exception {
        try (WsTestKit k = new WsTestKit(Runnable::run, 150, 200, 5)) {
            FakeWsSession silent = k.connect("silent", "1.1.1.1");
            FakeWsSession polite = k.connect("polite", "1.1.1.2");
            k.msg(polite, "{\"type\":\"hello\",\"proto\":1}");
            Thread.sleep(50);
            assertThat(silent.closedWith).isNull();
            await(() -> silent.closedWith != null);
            assertThat(silent.closedWith.getCode()).isEqualTo(1002);
            assertThat(silent.closedWith.getReason()).isEqualTo("hello timeout");
            Thread.sleep(100);
            assertThat(polite.closedWith).isNull();
        }
    }

    @Test void heartbeat_closesAfterTwoUnansweredPings() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            FakeWsSession ok = k.subscribed("ok", "1.1.1.2");
            k.hub.heartbeat();
            k.msg(ok, "{\"type\":\"pong\"}");
            k.hub.heartbeat();
            k.msg(ok, "{\"type\":\"pong\"}");
            assertThat(f.closedWith).isNull();
            assertThat(ofType(f, "ping")).hasSize(2);
            k.hub.heartbeat(); // 두 번 연속 무응답 → 닫는다
            assertThat(f.closedWith).isNotNull();
            assertThat(f.closedWith).isEqualTo(CloseStatus.SESSION_NOT_RELIABLE.withReason("pong timeout"));
            assertThat(ok.closedWith).isNull();
        }
    }

    // ---------------------------------------------------------------- 프로토콜 오류

    @Test void protocolErrors() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.connect("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39]}");
            assertThat(ofType(f, "error").get(0).path("code").asString()).isEqualTo("HELLO_REQUIRED");
            assertThat(f.closedWith.getCode()).isEqualTo(1002);

            FakeWsSession g = k.connect("g", "1.1.1.2");
            k.msg(g, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(g, "{\"type\":\"subscribe\",\"bbox\":[-180,-90,180,90],\"zoom\":8}");
            k.msg(g, "{\"type\":\"subscribe\",\"bbox\":[\"a\",0,1,1],\"zoom\":8}");
            k.msg(g, "{\"type\":\"nope\"}");
            assertThat(ofType(g, "error")).extracting(n -> n.path("code").asString()).containsExactly("BBOX_TOO_LARGE", "BAD_BBOX", "UNKNOWN_TYPE");
            assertThat(ofType(g, "snapshot")).isEmpty();
            assertThat(g.closedWith).isNull();
            JsonNode w = ofType(g, "welcome").get(0);
            assertThat(w.path("limits").path("max_client_messages").asInt()).isEqualTo(20);
            assertThat(w.path("limits").path("resync_world_interval_s").asInt()).isEqualTo(120);
        }
    }

    @Test void stop_sendsGoingAway() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.hub.stop();
            assertThat(f.closedWith.getCode()).isEqualTo(1001);
        }
    }
}
