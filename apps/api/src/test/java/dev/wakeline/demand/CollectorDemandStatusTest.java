package dev.wakeline.demand;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/** 수집기 수요 상태 필드(계약 v2 §A2) 해석: 값을 믿지 않고 다시 검사, 오래된 active 는 active 가 아니다. */
class CollectorDemandStatusTest {
    static final ObjectMapper JSON = JsonMapper.builder().build();
    static final Instant T = Instant.parse("2026-09-28T03:00:00Z");

    @Test void parse_validEntry() {
        var c = CollectorDemandStatus.parse("""
                {"state":"active","interval_s":5,"last_success_at":"2026-09-28T02:59:58Z","last_error":null,"provider":"adsb_fi"}""", JSON);
        assertThat(c).isEqualTo(new CollectorDemandStatus("active", 5, Instant.parse("2026-09-28T02:59:58Z")));
    }

    @Test void parse_rejectsUnknownStateAndBadShapes_toleratesBadOptionalFields() {
        assertThat(CollectorDemandStatus.parse("{\"state\":\"covered\"}", JSON)).isNull();
        assertThat(CollectorDemandStatus.parse("{\"state\":1}", JSON)).isNull();
        assertThat(CollectorDemandStatus.parse("[]", JSON)).isNull();
        assertThat(CollectorDemandStatus.parse("not json", JSON)).isNull();
        assertThat(CollectorDemandStatus.parse("", JSON)).isNull();
        assertThat(CollectorDemandStatus.parse(null, JSON)).isNull();
        assertThat(CollectorDemandStatus.parse("{\"state\":\"active\",\"pad\":\"" + "x".repeat(1100) + "\"}", JSON)).isNull(); // 1 KiB 상한
        // 선택 필드가 이상하면 그 값만 모름
        var c = CollectorDemandStatus.parse("{\"state\":\"throttled\",\"interval_s\":0,\"last_success_at\":\"yesterday\"}", JSON);
        assertThat(c).isEqualTo(new CollectorDemandStatus("throttled", null, null));
        assertThat(CollectorDemandStatus.parse("{\"state\":\"error\",\"interval_s\":99999}", JSON).intervalS()).isNull();
        assertThat(CollectorDemandStatus.parse("{\"state\":\"error\",\"interval_s\":2.5}", JSON).intervalS()).isNull();
    }

    @Test void activeAt_trustsOnlyRecentSuccess_windowIsMax15sOr3Intervals() {
        long now = T.toEpochMilli();
        assertThat(new CollectorDemandStatus("active", 5, T.minusSeconds(14)).activeAt(now)).isTrue();
        assertThat(new CollectorDemandStatus("active", 5, T.minusSeconds(16)).activeAt(now)).isFalse(); // 5 s 주기 → 15 s 창
        assertThat(new CollectorDemandStatus("active", 30, T.minusSeconds(89)).activeAt(now)).isTrue();  // 30 s 주기 → 90 s 창
        assertThat(new CollectorDemandStatus("active", 30, T.minusSeconds(91)).activeAt(now)).isFalse();
        assertThat(new CollectorDemandStatus("active", null, T.minusSeconds(10)).activeAt(now)).isTrue();
        assertThat(new CollectorDemandStatus("active", 5, null).activeAt(now)).isFalse();
        assertThat(new CollectorDemandStatus("throttled", 5, T).activeAt(now)).isFalse();
    }

    @Test void stats_holder() {
        DemandStats s = new DemandStats();
        assertThat(s.counts()).isEqualTo(DemandStats.Counts.NONE);
        s.update(new DemandStats.Counts(1, 2, 3, 4, 5, 6));
        assertThat(s.counts().focusActive()).isEqualTo(2);
        s.update(null);
        assertThat(s.counts()).isEqualTo(DemandStats.Counts.NONE);
    }
}
