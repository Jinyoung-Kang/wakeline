package dev.wakeline.ingest;

import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.core.WarningRecord;
import dev.wakeline.weather.core.WarningStore;
import dev.wakeline.weather.core.WeatherEvents;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 기상특보 스트림(ADR-036 · 계약 v5 §G49): wakeline:wxwarn 의 wx_warnings 를 스키마로 검증해 목록 전체를 바꾸고(더 새 것만), 이력 이벤트는 스트림 순서대로
 * 낸다(백로그 포함). 다른 스트림에 온 wx_warnings · 틀린 payload(예비특보에 지어 낸 시각)는 거절(DLQ).
 */
class StreamConsumerWarningsTest {
    static final Instant T = Instant.parse("2026-10-09T07:05:00Z");
    final List<Object> events = new ArrayList<>();
    final WarningStore store = new WarningStore();
    final StreamConsumer consumer = new StreamConsumer(null, new SchemaValidator(), new SnapshotStore(), new SigmetStore(), new RadarStore(),
            new ShipStore(), null, events::add, JsonMapper.builder().build(), new SimpleMeterRegistry());

    { consumer.setWarningStore(store); }

    static final String PRELIM = """
            {"zone_code":"S1312020","zone_name":"남해동부바깥먼바다","parent_code":"S1310000","parent_name":"남해동부전해상","sea":true,"kind":"풍랑",
             "level":"예비","command":"발표","preliminary":true,"issued_at":"2026-10-09T07:00:00Z","effective_from":"2026-10-10T03:00:00Z",
             "effective_to":"2026-10-10T09:00:00Z","effective_text":"10-10 오후(12–18시 KST)","raw":"S1310000, 남해동부전해상, S1312020, …,="}""";
    static final String REGULAR = """
            {"zone_code":"L1100100","zone_name":"서울","sea":false,"kind":"호우","level":"주의보","command":"발표","preliminary":false,
             "issued_at":"2026-10-09T06:00:00Z","effective_at":"2026-10-09T07:00:00Z","end_notice":"202610091800","raw":"L1000000, 전국, L1100100, 서울, …,="}""";

    static String payload(String... ws) { return "{\"complete\":true,\"dropped\":0,\"warnings\":[" + String.join(",", ws) + "]}"; }

    @Test
    void aWarningListReplacesTheCurrentSetAndIsQueuedForHistory() throws Exception {
        consumer.process(StreamConsumerShipsTest.rec(StreamConsumer.S_WXWARN, "wx_warnings", "-", T, payload(PRELIM, REGULAR), 0), true);
        WarningStore.State st = store.state();
        assertThat(st.received()).isTrue();
        assertThat(st.warnings()).extracting(WarningRecord::zoneCode).containsExactly("S1312020", "L1100100");
        WarningRecord p = st.warnings().getFirst();
        assertThat(p.preliminary()).isTrue();
        assertThat(p.effectiveAt()).isNull();
        assertThat(p.effectiveFrom()).isEqualTo(Instant.parse("2026-10-10T03:00:00Z"));
        assertThat(st.warnings().get(1).endNotice()).isEqualTo("202610091800");
        assertThat(events).singleElement().isInstanceOf(WeatherEvents.WarningsReceived.class);

        // 오래된 목록(백로그): 실시간 목록은 그대로, 이력 이벤트는 낸다
        consumer.process(StreamConsumerShipsTest.rec(StreamConsumer.S_WXWARN, "wx_warnings", "-", T.minusSeconds(300), payload(), 1), true);
        assertThat(store.state().warnings()).hasSize(2);
        assertThat(events).hasSize(2);
        // 더 새 빈 목록: 특보 없음
        consumer.process(StreamConsumerShipsTest.rec(StreamConsumer.S_WXWARN, "wx_warnings", "-", T.plusSeconds(300), payload(), 2), true);
        assertThat(store.state().warnings()).isEmpty();
        assertThat(store.state().version()).isEqualTo(2);
    }

    @Test
    void wrongStreamOrAnInventedPreliminaryTimeIsRefused() throws Exception {
        assertThatThrownBy(() -> consumer.parse(StreamConsumerShipsTest.rec(StreamConsumer.S_SIGMET, "wx_warnings", "-", T, payload(PRELIM), 0)))
                .hasMessageContaining("not accepted on stream");
        String invented = PRELIM.replace("\"effective_from\"", "\"effective_at\":\"2026-10-10T03:00:00Z\",\"effective_from\"");
        assertThatThrownBy(() -> consumer.parse(StreamConsumerShipsTest.rec(StreamConsumer.S_WXWARN, "wx_warnings", "-", T, payload(invented), 0)))
                .hasMessageStartingWith("payload:");
        String noTime = REGULAR.replace("\"effective_at\":\"2026-10-09T07:00:00Z\",", "");
        assertThatThrownBy(() -> consumer.parse(StreamConsumerShipsTest.rec(StreamConsumer.S_WXWARN, "wx_warnings", "-", T, payload(noTime), 0)))
                .hasMessageStartingWith("payload:");
        assertThatThrownBy(() -> consumer.parse(StreamConsumerShipsTest.rec(StreamConsumer.S_WXWARN, "wx_warnings", "region", T, payload(), 0)))
                .hasMessageContaining("scope");
        assertThat(store.state().received()).isFalse();
    }
}
