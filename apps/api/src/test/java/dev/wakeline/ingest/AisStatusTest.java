package dev.wakeline.ingest;

import dev.wakeline.domain.AisGap;
import dev.wakeline.platform.support.Receipt;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** AIS 수집기 상태 해시: 값 검증, heartbeat 가 오래되면 '모름', 수신 끊김 판단(얼림), status.sources.ais 모양. */
class AisStatusTest {
    static final Instant NOW = Instant.parse("2026-09-28T03:00:00Z");
    static final long NOW_MS = NOW.toEpochMilli();

    static Map<Object, Object> hash(Object... kv) {
        Map<Object, Object> m = new HashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(kv[i], kv[i + 1]);
        return m;
    }

    /** 수집기가 정상일 때의 해시(계약 v2 §B1 필드 이름 그대로). */
    static Map<Object, Object> healthy(Instant updatedAt) {
        return hash("provider", "aisstream", "fixture", "0", "state", "receiving", "connected", "1", "connected_since", "2026-09-28T02:00:00.000Z",
                "last_msg_at", updatedAt.minusSeconds(1).toString(), "msgs_per_s", "5.40", "gap_open_since", "", "gap_reason", "",
                "last_gap_started_at", "2026-09-28T01:00:00.000Z", "last_gap_ended_at", "2026-09-28T01:02:00.000Z", "last_gap_reason", "server closed (1006)",
                "updated_at", updatedAt.toString());
    }

    @Test void parse_validatesEveryValue() {
        AisStatus.Feed f = AisStatus.parse(hash("provider", "  aisstream ", "connected", "yes", "updated_at", "not-a-time",
                "last_msg_at", "2026-09-28T02:59:59+09:00", "msgs_per_s", "-3", "gap_open_since", "2026-09-28T02:00:00",
                "last_gap_started_at", "2026-09-28T01:05:00Z", "last_gap_ended_at", "2026-09-28T01:00:00Z", "state", "x".repeat(500)));
        assertThat(f.present()).isTrue();
        assertThat(f.provider()).isEqualTo("aisstream");
        assertThat(f.connected()).as("only 1/0").isNull();
        assertThat(f.updatedAt()).isNull();
        assertThat(f.lastMsgAt()).isEqualTo(Instant.parse("2026-09-28T02:59:59+09:00"));
        assertThat(f.msgsPerS()).as("negative").isNull();
        assertThat(f.gapOpenSince()).as("no time zone").isNull();
        assertThat(f.lastGap()).as("end before start").isNull();
        assertThat(f.state()).as("not a known collector state").isNull();
        assertThat(f.coverage()).as("no bbox").isNull();
        assertThat(AisStatus.parse(Map.of()).present()).isFalse();
        assertThat(AisStatus.parse(null).present()).isFalse();
        assertThat(AisStatus.parse(hash("msgs_per_s", "NaN")).msgsPerS()).isNull();
        assertThat(AisStatus.parse(hash("msgs_per_s", "abc")).msgsPerS()).isNull();
        assertThat(AisStatus.parse(hash("connected", "0")).connected()).isFalse();
    }

    @Test void connectedIsUnknownWhenHeartbeatIsOld() {
        AisStatus.Feed fresh = AisStatus.parse(healthy(NOW.minusSeconds(4)));
        assertThat(fresh.heartbeatFresh(NOW_MS)).isTrue();
        assertThat(fresh.connectedNow(NOW_MS)).isTrue();
        AisStatus.Feed old = AisStatus.parse(healthy(NOW.minusSeconds(45)));
        assertThat(old.heartbeatFresh(NOW_MS)).isFalse();
        assertThat(old.connectedNow(NOW_MS)).as("the collector may be dead — do not claim connected").isNull();
        AisStatus.Feed future = AisStatus.parse(healthy(NOW.plusSeconds(3600)));
        assertThat(future.heartbeatFresh(NOW_MS)).isFalse();
    }

    @Test void inputDown_openGapStaleHeartbeatDisconnectedOrStalledPipeline() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(ships);
        assertThat(st.inputDown(NOW_MS)).as("nothing known").isTrue();
        st.update(healthy(NOW.minusSeconds(3)));
        assertThat(st.inputDown(NOW_MS)).as("no ships message applied yet").isTrue();
        ships.apply(List.of(ShipStoreTest.pos("440000001", 35, 129, NOW)), List.of(), NOW, "aisstream", NOW_MS - 5_000);
        assertThat(st.inputDown(NOW_MS)).isFalse();
        assertThat(st.inputDown(NOW_MS + AisStatus.STALL_MS + 6_000)).as("api has not received ships for 2 min").isTrue();
        Map<Object, Object> gap = healthy(NOW.minusSeconds(3));
        gap.put("gap_open_since", "2026-09-28T02:50:00.000Z");
        st.update(gap);
        assertThat(st.inputDown(NOW_MS)).isTrue();
        Map<Object, Object> disc = healthy(NOW.minusSeconds(3));
        disc.put("connected", "0");
        st.update(disc);
        assertThat(st.inputDown(NOW_MS)).isTrue();
        st.update(healthy(NOW.minusSeconds(60)));
        assertThat(st.inputDown(NOW_MS)).as("stale heartbeat").isTrue();
    }

    @Test void refreshFailureKeepsThePreviousValue() {
        AisStatus st = new AisStatus(new ShipStore());
        st.update(healthy(NOW));
        new AisStatusReader(new StringRedisTemplate(), st).refresh(); // 연결 팩토리 없음 → 읽기 실패
        assertThat(st.current().provider()).isEqualTo("aisstream");
    }

    @Test void publicView_shapeAndHonesty() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(ships);
        assertThat(st.publicView(NOW_MS)).as("AIS never seen").isNull();

        st.update(healthy(NOW.minusSeconds(3)));
        ships.apply(List.of(ShipStoreTest.pos("440000001", 35, 129, NOW.minusSeconds(12))), List.of(), NOW.minusSeconds(2), "aisstream", NOW_MS - 2_000);
        Map<String, Object> v = st.publicView(NOW_MS);
        assertThat(v).containsEntry("connected", true).containsEntry("lag_s", 12.0).containsEntry("msgs_per_s", 5.4)
                .containsEntry("gap_open_since", null).containsEntry("provider", "aisstream").containsEntry("ships", 1)
                .containsEntry("heartbeat_stale", false);
        @SuppressWarnings("unchecked") Map<String, Object> lg = (Map<String, Object>) v.get("last_gap");
        assertThat(lg).containsEntry("started_at", Instant.parse("2026-09-28T01:00:00Z")).containsEntry("reason", "server closed (1006)")
                .doesNotContainKey("scope"); // 구역 없는 공백

        // 계약 v4 G: 상태 해시의 last_gap_scope 가 맞는 구역이면 last_gap.scope 로, 틀리면 구역 없음
        Map<Object, Object> scoped = new java.util.HashMap<>(healthy(NOW.minusSeconds(3)));
        scoped.put("last_gap_scope", "-90,45,90,180");
        st.update(scoped);
        @SuppressWarnings("unchecked") Map<String, Object> lgs = (Map<String, Object>) st.publicView(NOW_MS).get("last_gap");
        assertThat(lgs).containsEntry("scope", "-90,45,90,180");
        scoped.put("last_gap_scope", "a|b");
        st.update(scoped);
        @SuppressWarnings("unchecked") Map<String, Object> lgBad = (Map<String, Object>) st.publicView(NOW_MS).get("last_gap");
        assertThat(lgBad).doesNotContainKey("scope");
        st.update(healthy(NOW.minusSeconds(3)));

        // api 가 받은 공백이 더 늦게 끝났으면 그것
        ships.addGap(new AisGap(Instant.parse("2026-09-28T02:00:00Z"), Instant.parse("2026-09-28T02:03:00Z"), "idle 120 s", "aisstream"));
        @SuppressWarnings("unchecked") Map<String, Object> lg2 = (Map<String, Object>) st.publicView(NOW_MS).get("last_gap");
        assertThat(lg2).containsEntry("reason", "idle 120 s");

        // heartbeat 가 오래되면 연결·수신률은 모름(키 생략), 지연은 계속 자란다
        Map<String, Object> stale = st.publicView(NOW_MS + 120_000);
        assertThat(stale.get("connected")).isNull();
        assertThat(stale.get("msgs_per_s")).isNull();
        assertThat(stale).containsEntry("heartbeat_stale", true).containsEntry("lag_s", 132.0);
    }

    /** 계약 v3 §A: state 는 알려진 수집기 상태만, coverage 는 상태 해시의 bbox 를 운영 설정과 같은 규칙으로 — 아니면 null(모름). */
    @Test void parse_stateIsValidated_coverageFollowsTheSettingRules() {
        for (String s : new String[]{"starting", "connecting", "subscribed", "receiving", "backoff", "replaying", "disabled", "stopped"})
            assertThat(AisStatus.parse(hash("state", s)).state()).isEqualTo(s);
        assertThat(AisStatus.parse(hash("state", "RECEIVING")).state()).isNull();
        assertThat(AisStatus.parse(hash("state", "")).state()).isNull();

        assertThat(AisStatus.parse(hash("bbox", "-90,-180,90,0;-90,45,90,180")).coverage())
                .containsExactly(List.of(-90.0, -180.0, 90.0, 0.0), List.of(-90.0, 45.0, 90.0, 180.0));
        assertThat(AisStatus.parse(hash("bbox", " 18,105,46,150; ")).coverage()).containsExactly(List.of(18.0, 105.0, 46.0, 150.0));
        StringBuilder sixteen = new StringBuilder();
        for (int i = 0; i < 16; i++) sixteen.append(i == 0 ? "" : ";").append(i).append(".123456,100.123456,").append(i + 1).append(".5,101.654321");
        assertThat(sixteen.length()).isGreaterThan(AisStatus.TEXT_MAX);
        assertThat(AisStatus.parse(hash("bbox", sixteen.toString())).coverage()).hasSize(16) // 다른 문자열 필드의 200자 상한과 별개(1,024자까지)
                .first().isEqualTo(List.of(0.123456, 100.123456, 1.5, 101.654321));
        for (String bad : new String[]{"", ";", "18,105,46", "18,105,46,x", "91,0,10,10", "0,181,10,10", "0,0,0,10", "1e1,0,20,10",
                sixteen + ";20,0,21,1", "0,0,1,1;".repeat(200)})
            assertThat(AisStatus.parse(hash("provider", "aisstream", "bbox", bad)).coverage()).as(bad).isNull();
    }

    /** 계약 v3 §A: state·coverage 는 connected 처럼 heartbeat 가 30 s 안일 때만(죽은 수집기의 마지막 값을 지금 값으로 말하지 않는다). */
    @Test void publicView_stateAndCoverage_onlyWhileTheHeartbeatIsFresh() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(ships);
        Map<Object, Object> h = healthy(NOW.minusSeconds(3));
        h.put("bbox", "18,105,46,150");
        st.update(h);
        Map<String, Object> v = st.publicView(NOW_MS);
        assertThat(v).containsEntry("state", "receiving").containsEntry("coverage", List.of(List.of(18.0, 105.0, 46.0, 150.0)));
        Map<String, Object> stale = st.publicView(NOW_MS + 60_000);
        assertThat(stale.get("state")).isNull();
        assertThat(stale.get("coverage")).isNull();
        // aisstream 키가 없어 꺼진 수집기(리뷰 #15): state disabled 를 그대로 알리고, 구독이 없으니 coverage 는 null
        Map<Object, Object> disabled = healthy(NOW.minusSeconds(3));
        disabled.put("state", "disabled");
        disabled.put("connected", "0");
        disabled.put("bbox", "");
        st.update(disabled);
        assertThat(st.publicView(NOW_MS)).containsEntry("state", "disabled").containsEntry("connected", false).containsEntry("coverage", null);
    }

    static final String AMERICAS = "-90,-180,90,0", ASIA_PACIFIC = "-90,45,90,180";

    /** 수집기의 구역별 상태(계약 v4 §D shards 원소 모양 그대로 — api 가 쓰지 않는 필드도 싣는다). */
    static String shard(String scope, String state, Object connected, String gapOpenSince, String gapReason) {
        return "{\"scope\":\"" + scope + "\",\"state\":\"" + state + "\",\"connected\":" + connected + ",\"last_msg_at\":\"2026-09-28T02:59:59Z\","
                + "\"msgs_per_s\":40.5,\"lag_p50_s\":1.9,\"gap_open_since\":" + (gapOpenSince == null ? "null" : "\"" + gapOpenSince + "\"")
                + ",\"gap_reason\":" + (gapReason == null ? "null" : "\"" + gapReason + "\"") + ",\"sessions_ended\":0"
                + ",\"ping_rtt_max_s\":0.31,\"ws_queue_max\":2}"; // 진단(ADR-014 부록 C) — api 는 읽지 않는다
    }

    static Map<Object, Object> sharded(Instant updatedAt, String... shards) {
        Map<Object, Object> h = healthy(updatedAt);
        h.put("bbox", AMERICAS + "|" + ASIA_PACIFIC);
        h.put("shards", "[" + String.join(",", shards) + "]");
        return h;
    }

    /** 계약 v4 §D: shards 는 배열 ≤ 3, scope 는 구역 규칙 — 하나라도 틀리면 구역 정보 전체를 모름(null). 다른 필드는 값마다 검사. */
    @Test void parse_shardsAreValidated() {
        AisStatus.Feed f = AisStatus.parse(sharded(NOW, shard(AMERICAS, "receiving", true, null, null),
                shard(ASIA_PACIFIC, "backoff", false, "2026-09-28T02:58:00Z", "server closed (1006)")));
        assertThat(f.shards()).hasSize(2);
        AisStatus.Shard am = f.shards().get(0), ap = f.shards().get(1);
        assertThat(am.scope().text()).isEqualTo(AMERICAS);
        assertThat(am.state()).isEqualTo("receiving");
        assertThat(am.connected()).isTrue();
        assertThat(am.gapOpenSince()).isNull();
        assertThat(ap.connected()).isFalse();
        assertThat(ap.gapOpenSince()).isEqualTo(Instant.parse("2026-09-28T02:58:00Z"));
        assertThat(ap.gapReason()).isEqualTo("server closed (1006)");
        assertThat(f.coverage()).as("union of the shard boxes").containsExactly(List.of(-90.0, -180.0, 90.0, 0.0), List.of(-90.0, 45.0, 90.0, 180.0));

        // 값마다: 모르는 상태 · 참거짓이 아닌 connected · 시간대 없는 시각 → 그 값만 null. "1"/"0" 은 해시 필드처럼 받는다
        AisStatus.Shard odd = AisStatus.parse(sharded(NOW, shard(AMERICAS, "RECEIVING", "\"yes\"", "2026-09-28T02:58:00", null))).shards().getFirst();
        assertThat(odd.state()).isNull();
        assertThat(odd.connected()).isNull();
        assertThat(odd.gapOpenSince()).isNull();
        assertThat(AisStatus.parse(sharded(NOW, shard(AMERICAS, "receiving", "\"1\"", null, null))).shards().getFirst().connected()).isTrue();
        assertThat(AisStatus.parse(sharded(NOW, shard(AMERICAS, "receiving", 0, null, null))).shards().getFirst().connected()).isFalse();
        assertThat(AisStatus.parse(sharded(NOW, shard(AMERICAS, "receiving", "1.5", null, null))).shards().getFirst().connected()).isNull();
        assertThat(AisStatus.parse(sharded(NOW, shard(AMERICAS, "receiving", "\"x\"", null, null))).shards().getFirst().connected()).isNull();
        assertThat(AisStatus.parse(sharded(NOW, "{\"scope\":\"" + AMERICAS + "\",\"state\":5,\"gap_reason\":\"" + "r".repeat(500) + "\"}"))
                .shards().getFirst()).satisfies(s -> {
                    assertThat(s.state()).isNull();
                    assertThat(s.gapReason()).hasSize(AisStatus.TEXT_MAX);
                });

        // 전체가 모름: 배열 아님 · 빈 배열 · 4개 · 원소가 객체 아님 · scope 없음/형식 오류/'|' 포함 · JSON 오류 · 너무 김
        String ok = shard(AMERICAS, "receiving", true, null, null);
        for (String bad : new String[]{"{}", "[]", "[" + String.join(",", java.util.Collections.nCopies(4, ok)) + "]", "[1]", "[\"x\"]",
                "[{\"state\":\"receiving\"}]", "[{\"scope\":5}]", "[" + ok + "," + shard("91,0,1,1", "receiving", true, null, null) + "]",
                "[" + shard(AMERICAS + "|" + ASIA_PACIFIC, "receiving", true, null, null) + "]", "[{", " ", "[" + ok + "," + " ".repeat(9000) + ok + "]"}) {
            Map<Object, Object> h = healthy(NOW);
            h.put("bbox", AMERICAS + "|" + ASIA_PACIFIC);
            h.put("shards", bad);
            AisStatus.Feed bf = AisStatus.parse(h);
            assertThat(bf.shards()).as(bad).isNull();
            assertThat(bf.coverage()).as("falls back to the bbox field (union of its shards)").hasSize(2);
        }
        assertThat(AisStatus.parse(healthy(NOW)).shards()).as("older collector: no shards field").isNull();
    }

    /**
     * 계약 v4 §G D-2(리뷰 api-ships-realtime #2): 수신 범위는 실제로 구독한 구역만 — 상태 해시 bbox('|' 로 이은 구독 문자열)에 든 구역의 상자 합.
     * 구역의 scope 는 설정에서 오므로 꺼진·구독 전 구역에도 있다. 그 상자를 범위로 그리지 않는다(구역별 상태·상자는 shards 가 따로 말한다).
     */
    @Test void coverage_isOnlyTheShardsActuallySubscribed() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(ships);
        // aisstream 키 없음 → 설정의 구역 하나가 disabled, 구독 없음(bbox 빈 값)
        Map<Object, Object> disabled = sharded(NOW.minusSeconds(3), shard("18,105,46,150", "disabled", false, null, null));
        disabled.put("state", "disabled");
        disabled.put("connected", "0");
        disabled.put("bbox", "");
        st.update(disabled);
        assertThat(st.current().coverage()).isNull();
        Map<String, Object> v = st.publicView(NOW_MS);
        assertThat(v).containsEntry("state", "disabled").containsEntry("coverage", null);
        @SuppressWarnings("unchecked") List<Map<String, Object>> shardView = (List<Map<String, Object>>) v.get("shards");
        assertThat(shardView).singleElement().satisfies(sh -> assertThat(sh).containsEntry("state", "disabled").containsEntry("connected", false)
                .containsEntry("coverage", List.of(List.of(18.0, 105.0, 46.0, 150.0))));
        disabled.remove("bbox"); // bbox 필드 없음도 구독 없음
        assertThat(AisStatus.parse(disabled).coverage()).isNull();

        // 둘 중 하나만 구독됨(다른 하나는 아직 연결 중) → 구독한 구역의 상자만
        Map<Object, Object> half = sharded(NOW.minusSeconds(3), shard(AMERICAS, "receiving", true, null, null),
                shard(ASIA_PACIFIC, "connecting", false, null, null));
        half.put("bbox", AMERICAS);
        assertThat(AisStatus.parse(half).coverage()).containsExactly(List.of(-90.0, -180.0, 90.0, 0.0));
        half.put("bbox", " " + ASIA_PACIFIC + " | " + AMERICAS + " "); // 조각 순서와 상관없이 구역 순서대로
        assertThat(AisStatus.parse(half).coverage()).containsExactly(List.of(-90.0, -180.0, 90.0, 0.0), List.of(-90.0, 45.0, 90.0, 180.0));
        half.put("bbox", "0,0,1,1"); // 구독 문자열에 든 구역이 없다 → 모름
        assertThat(AisStatus.parse(half).coverage()).isNull();

        // disabled 모드 수집기(계약 v4 §G D-2): 구역 없는(scope null) 항목 하나 → 구역 정보 없음 · 범위 없음 · 상태는 disabled 그대로
        Map<Object, Object> noScope = healthy(NOW.minusSeconds(3));
        noScope.put("state", "disabled");
        noScope.put("connected", "0");
        noScope.put("bbox", "");
        noScope.put("shards", "[{\"scope\":null,\"state\":\"disabled\",\"connected\":false,\"last_msg_at\":null,\"msgs_per_s\":null,"
                + "\"lag_p50_s\":null,\"gap_open_since\":null,\"gap_reason\":null,\"sessions_ended\":0,\"ping_rtt_max_s\":null,\"ws_queue_max\":null}]");
        st.update(noScope);
        assertThat(st.current().shards()).isNull();
        assertThat(st.publicView(NOW_MS)).containsEntry("state", "disabled").containsEntry("connected", false)
                .containsEntry("coverage", null).containsEntry("shards", null);
    }

    /** 계약 v4 §D: bbox 필드도 '|' 구역 문법 — coverage 는 모든 구역 상자의 합. */
    @Test void coverageFromTheBboxField_isTheUnionOfItsShards() {
        assertThat(AisStatus.parse(hash("bbox", AMERICAS + "|" + ASIA_PACIFIC + ";0,0,1,1")).coverage())
                .containsExactly(List.of(-90.0, -180.0, 90.0, 0.0), List.of(-90.0, 45.0, 90.0, 180.0), List.of(0.0, 0.0, 1.0, 1.0));
        assertThat(AisStatus.parse(hash("bbox", "0,0,1,1|")).coverage()).isNull();
        assertThat(AisStatus.parse(hash("bbox", "0,0,1,1|2,2,3,3|4,4,5,5|6,6,7,7")).coverage()).isNull();
    }

    /** 계약 v4 §D: publicView.shards = [{coverage, state, connected, gap_open_since}] — heartbeat 가 30 s 안일 때만, 모르는 값은 키 없음. */
    @Test void publicView_shards_onlyWhileTheHeartbeatIsFresh() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(ships);
        st.update(sharded(NOW.minusSeconds(3), shard(AMERICAS, "receiving", true, null, null),
                shard(ASIA_PACIFIC, "backoff", false, "2026-09-28T02:58:00Z", "server closed (1006)")));
        Map<String, Object> v = st.publicView(NOW_MS);
        @SuppressWarnings("unchecked") List<Map<String, Object>> shards = (List<Map<String, Object>>) v.get("shards");
        assertThat(shards).hasSize(2);
        assertThat(shards.get(0)).containsEntry("coverage", List.of(List.of(-90.0, -180.0, 90.0, 0.0))).containsEntry("state", "receiving")
                .containsEntry("connected", true).containsEntry("gap_open_since", null);
        assertThat(shards.get(1)).containsEntry("coverage", List.of(List.of(-90.0, 45.0, 90.0, 180.0))).containsEntry("state", "backoff")
                .containsEntry("connected", false).containsEntry("gap_open_since", Instant.parse("2026-09-28T02:58:00Z"));
        assertThat(shards.get(1)).as("the reason text is not part of the public shard view").doesNotContainKey("gap_reason");
        assertThat(v.get("coverage")).isEqualTo(List.of(List.of(-90.0, -180.0, 90.0, 0.0), List.of(-90.0, 45.0, 90.0, 180.0)));
        Map<String, Object> stale = st.publicView(NOW_MS + 60_000);
        assertThat(stale.get("shards")).isNull();
        assertThat(stale.get("coverage")).isNull();
        st.update(healthy(NOW.minusSeconds(3)));
        assertThat(st.publicView(NOW_MS).get("shards")).as("no shard info → key omitted").isNull();
    }

    static ShipStore liveStore(long appliedAtMs) {
        ShipStore ships = new ShipStore();
        ships.apply(List.of(ShipStoreTest.pos("440000001", 35, 129, NOW)), List.of(), NOW, "aisstream", appliedAtMs);
        return ships;
    }

    /**
     * 계약 v4 §D: 만료 멈춤은 열린 공백이 있거나 연결되지 않은(모름 포함) 구역의 상자 안만. 수집기 상태를 모르면(heartbeat 오래됨·소비 멈춤)·구역 정보가
     * 없는데 합계가 끊김이면·합계와 구역이 어긋나면 전체.
     */
    @Test void freeze_onlyTheShardsThatAreDown() {
        AisStatus st = new AisStatus(liveStore(NOW_MS - 5_000));
        String amOk = shard(AMERICAS, "receiving", true, null, null);
        String apGap = shard(ASIA_PACIFIC, "backoff", false, "2026-09-28T02:58:00Z", "server closed (1006)");

        Map<Object, Object> h = sharded(NOW.minusSeconds(3), amOk, apGap);
        h.put("connected", "0");
        h.put("gap_open_since", "2026-09-28T02:58:00Z");
        st.update(h);
        ShipStore.Freeze fz = st.freeze(NOW_MS);
        assertThat(fz.all()).isFalse();
        assertThat(fz.scopes()).extracting(s -> s.text()).containsExactly(ASIA_PACIFIC);
        assertThat(fz.covers(35, 129)).as("Busan is in the Asia-Pacific shard").isTrue();
        assertThat(fz.covers(40, -70)).as("New York is in the Americas shard").isFalse();
        assertThat(fz.covers(50, 10)).as("outside every shard").isFalse();
        assertThat(st.inputDown(NOW_MS)).isTrue();

        // 모두 정상
        st.update(sharded(NOW.minusSeconds(3), amOk, shard(ASIA_PACIFIC, "receiving", true, null, null)));
        assertThat(st.freeze(NOW_MS)).isEqualTo(ShipStore.Freeze.NONE);
        assertThat(st.inputDown(NOW_MS)).isFalse();
        // 연결 상태를 모르는 구역은 멈춘다(열린 공백이 없어도)
        st.update(sharded(NOW.minusSeconds(3), amOk, shard(ASIA_PACIFIC, "connecting", "null", null, null)));
        assertThat(st.freeze(NOW_MS).scopes()).extracting(s -> s.text()).containsExactly(ASIA_PACIFIC);
        // 합계는 공백인데 끊긴 구역이 없다(어긋남) → 전체
        Map<Object, Object> mismatch = sharded(NOW.minusSeconds(3), amOk, shard(ASIA_PACIFIC, "receiving", true, null, null));
        mismatch.put("gap_open_since", "2026-09-28T02:58:00Z");
        st.update(mismatch);
        assertThat(st.freeze(NOW_MS)).isEqualTo(ShipStore.Freeze.ALL);
        // heartbeat 가 오래됨 → 전체(구역 정보가 있어도)
        st.update(sharded(NOW.minusSeconds(60), amOk, apGap));
        assertThat(st.freeze(NOW_MS)).isEqualTo(ShipStore.Freeze.ALL);
        // 구역 정보 없는 수집기: 기존 규칙
        Map<Object, Object> legacy = healthy(NOW.minusSeconds(3));
        st.update(legacy);
        assertThat(st.freeze(NOW_MS)).isEqualTo(ShipStore.Freeze.NONE);
        legacy.put("gap_open_since", "2026-09-28T02:58:00Z");
        st.update(legacy);
        assertThat(st.freeze(NOW_MS)).isEqualTo(ShipStore.Freeze.ALL);

        // api 가 ships 메시지를 2분 넘게 받지 못함 → 전체
        AisStatus stalled = new AisStatus(liveStore(NOW_MS - AisStatus.STALL_MS - 1_000));
        stalled.update(sharded(NOW.minusSeconds(3), amOk, apGap));
        assertThat(stalled.freeze(NOW_MS)).isEqualTo(ShipStore.Freeze.ALL);
    }

    /** 계약 v4 §D: 열린 공백은 구역마다 하나(scope 포함). 구역 정보가 없으면 합계 하나(구역 없음), 합계만 열려 있으면(어긋남) 합계를 구역 없이. */
    @Test void openGaps_perShardWithScope() {
        String apGap = shard(ASIA_PACIFIC, "backoff", false, "2026-09-28T02:58:00Z", "server closed (1006)");
        String amGap = shard(AMERICAS, "backoff", false, "2026-09-28T02:50:00Z", "idle 120 s");
        List<AisGap> two = AisStatus.parse(sharded(NOW, amGap, apGap)).openGaps();
        assertThat(two).extracting(AisGap::scopeText).containsExactly(AMERICAS, ASIA_PACIFIC);
        assertThat(two).extracting(AisGap::reason).containsExactly("idle 120 s", "server closed (1006)");
        assertThat(two).allSatisfy(g -> {
            assertThat(g.endedAt()).isNull();
            assertThat(g.provider()).isEqualTo("aisstream");
        });
        assertThat(AisStatus.parse(sharded(NOW, shard(AMERICAS, "receiving", true, null, null))).openGaps()).isEmpty();
        Map<Object, Object> legacy = healthy(NOW);
        legacy.put("gap_open_since", "2026-09-28T02:58:00Z");
        legacy.put("gap_reason", "server closed (1006)");
        assertThat(AisStatus.parse(legacy).openGaps()).singleElement().satisfies(g -> {
            assertThat(g.scope()).isNull();
            assertThat(g.startedAt()).isEqualTo(Instant.parse("2026-09-28T02:58:00Z"));
        });
        Map<Object, Object> mismatch = sharded(NOW, shard(AMERICAS, "receiving", true, null, null));
        mismatch.put("gap_open_since", "2026-09-28T02:58:00Z");
        assertThat(AisStatus.parse(mismatch).openGaps()).singleElement().extracting(AisGap::scope).isNull();
        assertThat(AisStatus.parse(Map.of()).openGaps()).isEmpty();
    }

    /** 계약 v4 §D: 스위퍼는 끊긴 구역의 선박만 남기고 다른 구역의 오래된 선박은 뺀다. */
    @Test void sweeperExpiresShipsOutsideTheDownShards() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(ships);
        List<Object> events = new java.util.ArrayList<>();
        ShipSweeper sw = new ShipSweeper(ships, st, events::add, new SimpleMeterRegistry());
        ships.apply(List.of(ShipStoreTest.pos("440000001", 35, 129, NOW.minusSeconds(40 * 60)), ShipStoreTest.pos("366000001", 40, -70, NOW.minusSeconds(40 * 60))),
                List.of(), NOW, "aisstream", NOW_MS);
        st.update(sharded(NOW.minusSeconds(2), shard(AMERICAS, "receiving", true, null, null),
                shard(ASIA_PACIFIC, "backoff", false, "2026-09-28T02:58:00Z", "server closed (1006)")));
        assertThat(sw.sweep(NOW_MS).removed()).as("the Asia-Pacific ship is frozen, the Americas ship expires").containsExactly("366000001");
        assertThat(ships.view().get("440000001")).isNotNull();
    }

    @Test void sweeperFreezesWhileDownAndPublishesRemovals() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(ships);
        List<Object> events = new java.util.ArrayList<>();
        ShipSweeper sw = new ShipSweeper(ships, st, events::add, new SimpleMeterRegistry());
        ships.apply(List.of(ShipStoreTest.pos("440000001", 35, 129, NOW.minusSeconds(40 * 60))), List.of(), NOW, "aisstream", NOW_MS);
        assertThat(sw.sweep(NOW_MS).removed()).as("no collector status → input down → frozen").isEmpty();
        st.update(healthy(NOW.minusSeconds(2)));
        assertThat(sw.sweep(NOW_MS).removed()).containsExactly("440000001");
        assertThat(events).hasSize(1);
        IngestEvents.ShipsUpdated e = (IngestEvents.ShipsUpdated) events.getFirst();
        assertThat(e.removed()).containsExactly("440000001");
        assertThat(e.states()).isEmpty();
        assertThat(e.receipt()).isSameAs(Receipt.NONE);
        new AisStatusReader(new StringRedisTemplate(), st).refresh(); // 연결 팩토리 없음 — 조용히 이전 값
        assertThat(st.current().present()).isTrue();
    }
}
