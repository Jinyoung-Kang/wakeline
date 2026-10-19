package dev.wakeline.weather.web;

import dev.wakeline.airspace.core.AirspaceRecord;
import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.weather.core.SigmetRecord;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 알림 근거의 구역 사본(계약 v5 §G51)을 메모리에서 만든다 — DB 사본(AlertRepository.sigmetCopy · airspaceCopy)과 같은 키 · 같은 순서(AlertCopiesDbTest 가
 * 같은 행으로 대조한다). 열린 알림의 사본을 DB 에서 읽지 못할 때(저장소 장애)만 쓴다({@link WeatherController#alert}). 메모리에 없는 값은 null 이다:
 * withdrawn_at(철회는 저장소만 안다), 출처 필드가 없던 이전 형식 메시지의 base_source · top_source(DB 는 저장할 때 json · unknown 으로 채운다).
 */
final class AlertCopies {
    private AlertCopies() {}

    /** SIGMET 사본 — 메모리(SigmetStore)에 그 SIGMET 이 없으면 null. */
    static Map<String, Object> sigmet(SigmetRecord s) {
        if (s == null) return null;
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", s.id());
        m.put("fir_id", s.firId());
        m.put("fir_name", s.firName());
        m.put("hazard", s.hazard());
        m.put("qualifier", s.qualifier());
        m.put("base_ft", s.baseFt());
        m.put("top_ft", s.topFt());
        m.put("base_source", s.baseSource());
        m.put("top_source", s.topSource());
        m.put("valid_from", s.validFrom());
        m.put("valid_to", s.validTo());
        m.put("withdrawn_at", null);
        m.put("raw_text", s.rawText());
        m.put("provider", s.provider());
        return m;
    }

    /**
     * 공역 사본 — 메모리는 켜진 차수 하나만 든다(AirspaceStore)라 edition_active 는 true. 차수가 없거나 그 차수에 이 id 가 없으면 null
     * (차수가 바뀌면 엔진이 그 차수의 알림을 닫는다 — 열린 알림의 공역은 보통 켜진 차수에 있다).
     */
    static Map<String, Object> airspace(AirspaceStore.Snapshot snap, long id) {
        if (snap.edition() == null) return null;
        for (AirspaceRecord r : snap.records()) {
            if (r.id() != id) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.id());
            m.put("category", r.category());
            m.put("type_ko", r.typeKo());
            m.put("ident", r.ident());
            m.put("name", r.name());
            m.put("lower_ft", r.lower().ft());
            m.put("lower_basis", r.lower().basis());
            m.put("lower_raw", r.lower().raw());
            m.put("upper_ft", r.upper().ft());
            m.put("upper_basis", r.upper().basis());
            m.put("upper_raw", r.upper().raw());
            m.put("edition", snap.edition().label());
            m.put("edition_active", true);
            return m;
        }
        return null;
    }
}
