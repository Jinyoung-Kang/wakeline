package dev.wakeline.airspace.core;

import dev.wakeline.geo.GeoJson;
import org.locationtech.jts.geom.Coordinate;
import org.locationtech.jts.geom.Point;
import org.locationtech.jts.geom.prep.PreparedGeometry;
import org.locationtech.jts.geom.prep.PreparedGeometryFactory;
import org.locationtech.jts.index.strtree.STRtree;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 항공기 카드의 '들어 있는 공역'(SPEC F2-4 · 계약 v5 §G48) — 위치 하나가 들어 있는 공역을 요청 때 계산한다(엔진 사건이 아니다 — 모드와 무관).
 * 보이는 종류: 금지 · 원전 · 안보 · 제한(고도를 비교할 수 있으면 고도대까지) · 위험구역(상한이 지면 기준 — 수평만, '고도 판정 안 함').
 * vertical: inside(고도대 안) · not_judged(지면 기준 · 모름 — 수평만 봄) · unknown(항공기 고도 모름 — 수평만 봄). 고도대 밖이면 싣지 않는다.
 * 색인은 차수마다 한 번 짓는다.
 */
@Component
public class AirspaceLookup {
    public static final Set<String> SHOWN = Set.of("prohibited", "nuclear", "security", "restricted", "danger");
    private final AirspaceStore store;
    private volatile Idx idx = new Idx("", new STRtree(), 0);

    record Item(AirspaceRecord r, PreparedGeometry g) {}

    record Idx(String tag, STRtree tree, int size) {}

    public AirspaceLookup(AirspaceStore store) { this.store = store; }

    /** 들어 있는 공역 — 차수가 없으면 null(모름 — 빈 목록과 구분한다). */
    public Map<String, Object> inside(double lat, double lon, Integer altFt) {
        AirspaceStore.Snapshot snap = store.snapshot();
        if (snap.edition() == null) return null;
        Idx x = index(snap);
        List<Map<String, Object>> items = new ArrayList<>();
        if (x.size() > 0) {
            Point pt = GeoJson.GF.createPoint(new Coordinate(lon, lat));
            @SuppressWarnings("unchecked")
            List<Item> cands = x.tree().query(pt.getEnvelopeInternal());
            for (Item it : cands) {
                if (!it.g().intersects(pt)) continue;
                AirspaceRecord r = it.r();
                String vertical;
                if (!r.lower().comparable() || !r.upper().comparable()) vertical = "not_judged";
                else if (altFt == null) vertical = "unknown";
                else {
                    int base = r.lower().ft() == null ? 0 : r.lower().ft();
                    Integer top = "UNL".equals(r.upper().basis()) ? null : r.upper().ft();
                    if (altFt < base || (top != null && altFt > top)) continue;
                    vertical = "inside";
                }
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", r.id());
                m.put("category", r.category());
                m.put("type_ko", r.typeKo());
                m.put("label", r.label());
                m.put("name", r.name());
                String level = AirspaceZones.ALERT_CATEGORIES.contains(r.category()) ? "alert" : AirspaceZones.INFO_CATEGORIES.contains(r.category()) ? "info" : null;
                if (level != null) m.put("level", level);
                m.put("vertical", vertical);
                items.add(m);
            }
        }
        items.sort((a, b) -> Long.compare((Long) a.get("id"), (Long) b.get("id")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("edition", snap.edition().label());
        out.put("items", items);
        return out;
    }

    private Idx index(AirspaceStore.Snapshot snap) {
        Idx x = idx;
        if (x.tag().equals(snap.tag())) return x;
        STRtree t = new STRtree();
        int n = 0;
        for (AirspaceRecord r : snap.records()) {
            if (r.geometry() == null || !SHOWN.contains(r.category())) continue;
            t.insert(r.geometry().getEnvelopeInternal(), new Item(r, PreparedGeometryFactory.prepare(r.geometry())));
            n++;
        }
        t.build();
        x = new Idx(snap.tag(), t, n);
        idx = x;
        return x;
    }
}
