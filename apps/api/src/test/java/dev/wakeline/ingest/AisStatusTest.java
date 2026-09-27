package dev.wakeline.ingest;

import dev.wakeline.domain.AisGap;
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
        AisStatus st = new AisStatus(new StringRedisTemplate(), ships);
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
        AisStatus st = new AisStatus(new StringRedisTemplate(), new ShipStore()); // 연결 팩토리 없음 → 읽기 실패
        st.update(healthy(NOW));
        st.refresh();
        assertThat(st.current().provider()).isEqualTo("aisstream");
    }

    @Test void publicView_shapeAndHonesty() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(new StringRedisTemplate(), ships);
        assertThat(st.publicView(NOW_MS)).as("AIS never seen").isNull();

        st.update(healthy(NOW.minusSeconds(3)));
        ships.apply(List.of(ShipStoreTest.pos("440000001", 35, 129, NOW.minusSeconds(12))), List.of(), NOW.minusSeconds(2), "aisstream", NOW_MS - 2_000);
        Map<String, Object> v = st.publicView(NOW_MS);
        assertThat(v).containsEntry("connected", true).containsEntry("lag_s", 12.0).containsEntry("msgs_per_s", 5.4)
                .containsEntry("gap_open_since", null).containsEntry("provider", "aisstream").containsEntry("ships", 1)
                .containsEntry("heartbeat_stale", false);
        @SuppressWarnings("unchecked") Map<String, Object> lg = (Map<String, Object>) v.get("last_gap");
        assertThat(lg).containsEntry("started_at", Instant.parse("2026-09-28T01:00:00Z")).containsEntry("reason", "server closed (1006)");

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
        AisStatus st = new AisStatus(new StringRedisTemplate(), ships);
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

    @Test void sweeperFreezesWhileDownAndPublishesRemovals() {
        ShipStore ships = new ShipStore();
        AisStatus st = new AisStatus(new StringRedisTemplate(), ships);
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
        sw.refreshStatus(); // 연결 팩토리 없음 — 조용히 이전 값
        assertThat(st.current().present()).isTrue();
    }
}
