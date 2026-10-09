package dev.wakeline.airspace.core;

import dev.wakeline.weather.core.AlertStateMachine;
import dev.wakeline.weather.core.Zone;
import dev.wakeline.weather.core.ZoneSource;
import org.locationtech.jts.geom.MultiPolygon;
import org.locationtech.jts.geom.Polygon;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 공역 판정 구역 공급원(ADR-035 · SPEC F2 — PLAN 결정 D2): 켜진 차수에서 판정 대상만 고른다.
 * <ul>
 *   <li>알림(alert): 비행금지(prohibited) · 원전 임시비행금지(nuclear) · 안보 임시비행금지(security).</li>
 *   <li>정보(info): 비행제한(restricted) — 목록 · 카드에만, 배너 · 브라우저 알림 없음.</li>
 *   <li>하한 · 상한 중 하나라도 고도 기준을 비교할 수 없으면(지면 기준 AGL · 모름) 판정하지 않는다 — 수는 {@link #skipped} 에.
 *       위험구역(상한이 지면 기준)과 그 밖의 종류는 판정하지 않는다(위험구역은 항공기 카드에 '고도 판정 안 함'으로만 — AirspaceLookup).</li>
 * </ul>
 * 차수가 바뀌면 판(version)이 바뀌어 엔진이 색인을 다시 짓고, 새 판에 없는 구역의 알림은 구역 종료(edition_replaced)로 닫힌다.
 * 운영 설정 airspace_alerts(off · shadow · on)는 data 층(AirspaceRefresher)이 읽어 {@link #setMode} 로 넘긴다 — core 는 DB 를 모른다.
 */
@Component
public class AirspaceZones implements ZoneSource {
    public static final Set<String> ALERT_CATEGORIES = Set.of("prohibited", "nuclear", "security");
    public static final Set<String> INFO_CATEGORIES = Set.of("restricted");
    public static final String END_EDITION_REPLACED = "edition_replaced";

    private final AirspaceStore store;
    private volatile String mode = MODE_SHADOW;
    private volatile Built built = new Built(-1, List.of(), Map.of(), Map.of());

    record Built(long version, List<AirspaceZone> zones, Map<String, AirspaceZone> byId, Map<String, Integer> skipped) {}

    public AirspaceZones(AirspaceStore store) { this.store = store; }

    @Override public String zoneType() { return Zone.AIRSPACE; }

    @Override
    public long version() {
        var ed = store.snapshot().edition();
        return ed == null ? 0 : ed.id();
    }

    @Override public List<AirspaceZone> zones() { return current().zones(); }

    /** 판정하지 않은 구역 수(까닭별 — 판정 대상 종류 중에서만): no_vertical(지면 기준 · 모름) · not_polygon. */
    public Map<String, Integer> skipped() { return current().skipped(); }

    @Override
    public AlertStateMachine.ZoneSet set() {
        Built b = current();
        return (zoneId, known, now) -> b.byId().containsKey(zoneId) ? null : new AlertStateMachine.Ended(END_EDITION_REPLACED, now, known);
    }

    @Override public String mode() { return mode; }

    /** 운영 설정 반영. 모르는 값은 무시한다(설정 검증이 막는다). */
    public void setMode(String m) {
        if (MODE_OFF.equals(m) || MODE_SHADOW.equals(m) || MODE_ON.equals(m)) mode = m;
    }

    private Built current() {
        AirspaceStore.Snapshot snap = store.snapshot();
        long v = snap.edition() == null ? 0 : snap.edition().id();
        Built b = built;
        if (b.version() == v) return b;
        b = build(snap, v);
        built = b;
        return b;
    }

    static Built build(AirspaceStore.Snapshot snap, long version) {
        List<AirspaceZone> zones = new ArrayList<>();
        Map<String, AirspaceZone> byId = new LinkedHashMap<>();
        Map<String, Integer> skipped = new LinkedHashMap<>();
        if (snap.edition() == null) return new Built(version, List.of(), Map.of(), Map.of());
        for (AirspaceRecord r : snap.records()) {
            String level = ALERT_CATEGORIES.contains(r.category()) ? Zone.LEVEL_ALERT : INFO_CATEGORIES.contains(r.category()) ? Zone.LEVEL_INFO : null;
            if (level == null) continue;
            if (!r.lower().comparable() || !r.upper().comparable()) { skipped.merge("no_vertical", 1, Integer::sum); continue; }
            MultiPolygon mp = multi(r);
            if (mp == null) { skipped.merge("not_polygon", 1, Integer::sum); continue; }
            int base = r.lower().ft() == null ? 0 : r.lower().ft();
            Integer top = "UNL".equals(r.upper().basis()) ? null : r.upper().ft();
            AirspaceZone z = new AirspaceZone(r, snap.edition(), level, mp, base, top);
            zones.add(z);
            byId.put(z.zoneId(), z);
        }
        return new Built(version, List.copyOf(zones), Collections.unmodifiableMap(byId), Collections.unmodifiableMap(skipped));
    }

    private static MultiPolygon multi(AirspaceRecord r) {
        if (r.geometry() instanceof MultiPolygon mp) return mp;
        if (r.geometry() instanceof Polygon p) return p.getFactory().createMultiPolygon(new Polygon[]{p});
        return null;
    }

    /** 판정 시각과 무관한 시험용 — 지금 판의 구역 하나. */
    public AirspaceZone zone(String zoneId) { return current().byId().get(zoneId); }

}
