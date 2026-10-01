package dev.wakeline.weather.web;

import dev.wakeline.geo.GeoJson;
import dev.wakeline.weather.core.SigmetRecord;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * SIGMET → GeoJSON FeatureCollection. 폴리곤이 없는 경보도 geometry=null 로 목록에 남긴다(판정 제외 사실 표시).
 * 목록은 최신 완전한 수신 세트뿐이다 — 유효시간 전에 철회(취소·대체)된 경보는 세트에서 빠지므로 active 가 될 수 없다.
 */
public final class SigmetGeoJson {
    private SigmetGeoJson() {}

    public static Map<String, Object> collection(Collection<SigmetRecord> sigmets, Instant now, boolean activeOnly) {
        List<Map<String, Object>> features = new ArrayList<>();
        for (SigmetRecord s : sigmets) {
            if (activeOnly && !s.validTo().isAfter(now)) continue;
            features.add(feature(s, now));
        }
        Map<String, Object> fc = new LinkedHashMap<>();
        fc.put("type", "FeatureCollection");
        fc.put("features", features);
        return fc;
    }

    public static Map<String, Object> feature(SigmetRecord s, Instant now) {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("id", s.id());
        props.put("fir_id", s.firId());
        props.put("fir_name", s.firName());
        props.put("issuer", s.issuer());
        props.put("series_id", s.seriesId());
        props.put("hazard", s.hazard());
        props.put("qualifier", s.qualifier());
        props.put("base_ft", s.baseFt());
        props.put("top_ft", s.topFt());
        // 고도대 출처(계약 §1·§2): base json | assumed_surface(하한 미발표 — 판정은 SFC 가정), top json | raw_text | unknown(미발표 — 무제한 가정).
        // 이전 형식 메시지는 출처를 모른다 → null(추정해 채우지 않는다).
        props.put("base_source", s.baseSource());
        props.put("top_source", s.topSource());
        props.put("valid_from", s.validFrom());
        props.put("valid_to", s.validTo());
        props.put("active", s.validAt(now));
        props.put("expiring_soon", s.validAt(now) && s.validTo().minusSeconds(1800).isBefore(now));
        props.put("move_dir", s.moveDir());
        props.put("move_spd", s.moveSpd());
        props.put("chng", s.chng());
        props.put("excluded_reason", s.excludedReason());
        props.put("raw_text", s.rawText());
        props.put("provider", s.provider());
        props.put("fetched_at", s.fetchedAt());
        Map<String, Object> geom = null;
        if (s.geometry() != null) {
            geom = new LinkedHashMap<>();
            geom.put("type", "MultiPolygon");
            geom.put("coordinates", GeoJson.coordinates(s.geometry()));
        }
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("type", "Feature");
        f.put("id", s.id());
        // RFC 7946 §3.2: Feature 는 geometry 멤버가 반드시 있어야 하고, 위치가 없으면(판정 제외 SIGMET) 값이 null 이다.
        // 전역 non_null 설정은 Java null 인 맵 값을 빼 버리므로 JSON null 노드를 넣는다(REST·WS 같은 직렬화기).
        f.put("geometry", geom == null ? tools.jackson.databind.node.NullNode.getInstance() : geom);
        f.put("properties", props);
        return f;
    }
}
