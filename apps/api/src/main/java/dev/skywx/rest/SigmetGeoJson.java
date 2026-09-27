package dev.skywx.rest;

import dev.skywx.domain.GeoJson;
import dev.skywx.domain.SigmetRecord;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** SIGMET → GeoJSON FeatureCollection. 폴리곤이 없는 경보도 geometry=null 로 목록에 남긴다(판정 제외 사실 표시). */
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
        f.put("geometry", geom);
        f.put("properties", props);
        return f;
    }
}
