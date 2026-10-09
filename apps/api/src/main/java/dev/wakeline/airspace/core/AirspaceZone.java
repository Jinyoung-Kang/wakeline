package dev.wakeline.airspace.core;

import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.Zone;
import org.locationtech.jts.geom.MultiPolygon;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 판정 구역으로서의 공역 하나(ADR-035 · SPEC F2). 고도 기준이 비교 가능한(해면 · FL · 지면 · 무제한) 금지 · 원전 · 안보 · 제한 구역만 만든다
 * ({@link AirspaceZones}). 고도 비교의 가정: 항공기 기압고도(표준 기압 1013.25 hPa)를 해면 고도로 본다(QNH 보정 없음) — 근거에 적는다.
 * 전이고도(14,000 ft) 아래에서 한계와 {@link #UNCERTAIN_MARGIN_FT} 안이면 근거에 altitude_uncertain(판정은 원래 값으로).
 * 공역에는 유효 시간이 없다 — 켜진 차수 동안 유효(validFrom = EPOCH, validTo = 먼 미래). 차수가 바뀌면 엔진이 구역 종료(zone_ended)로 닫는다.
 */
public record AirspaceZone(AirspaceRecord record, AirspaceEdition edition, String level, MultiPolygon geometry, int baseFt, Integer topFt) implements Zone {
    /** 한국 전이고도(ft) — 이 아래에서는 기압고도와 해면 고도가 QNH 만큼 다르다. */
    public static final int TRANSITION_ALTITUDE_FT = 14_000;
    /** 기압 보정 없음의 오차로 보는 폭(ft) — QNH 가 표준과 ±18 hPa 다르면 약 500 ft(1 hPa ≈ 27 ft). 선택값(잰 값 아님). */
    public static final int UNCERTAIN_MARGIN_FT = 500;
    /** 유효 끝(차수가 바뀌기 전까지) — Instant.MAX 는 epoch 밀리초로 바꿀 수 없어 먼 날짜를 쓴다. */
    static final Instant FOREVER = Instant.parse("9999-12-31T00:00:00Z");

    @Override public String zoneType() { return AIRSPACE; }
    @Override public String zoneId() { return String.valueOf(record.id()); }
    @Override public Instant validFrom() { return Instant.EPOCH; }
    @Override public Instant validTo() { return FOREVER; }
    @Override public boolean validAt(Instant t) { return true; }
    @Override public Integer judgedTopFt() { return topFt; }
    @Override public String provider() { return "molit_airspace"; }

    @Override
    public boolean bandContains(int altFt) { return altFt >= baseFt && (topFt == null || altFt <= topFt); }

    /** 고도 경계 근처인가(전이고도 아래에서 하한 · 상한과 UNCERTAIN_MARGIN_FT 안). 하한이 지면이면 하한은 보지 않는다. */
    public boolean altitudeUncertain(int altFt) {
        if (altFt >= TRANSITION_ALTITUDE_FT) return false;
        boolean nearBase = baseFt > 0 && Math.abs(altFt - baseFt) <= UNCERTAIN_MARGIN_FT;
        boolean nearTop = topFt != null && topFt < TRANSITION_ALTITUDE_FT + UNCERTAIN_MARGIN_FT && Math.abs(altFt - topFt) <= UNCERTAIN_MARGIN_FT;
        return nearBase || nearTop;
    }

    /** 근거: band_ft(판정에 쓴 값) · 하한 · 상한(값 · 기준 · 원문) · 판정 가정. */
    @Override
    public void putBand(Map<String, Object> ev) {
        ev.put("band_ft", java.util.Arrays.asList(baseFt, topFt));
        ev.put("lower", limit(record.lower()));
        ev.put("upper", limit(record.upper()));
        ev.put("assumption", "pressure_altitude_as_msl");
        if (topFt == null) ev.put("top_unlimited", true);
    }

    /** 근거: 전이고도 아래에서 한계와 가까우면 altitude_uncertain(판정은 원래 값으로 했다). */
    @Override
    public void putJudgement(Map<String, Object> ev, int altFt) {
        if (altitudeUncertain(altFt)) ev.put("altitude_uncertain", true);
    }

    /** 근거: 기준 차수(공역에는 유효 시간이 없다). */
    @Override
    public void putValidity(Map<String, Object> ev) {
        ev.put("edition_id", edition.id());
        ev.put("edition", edition.label());
    }

    @Override
    public Alert.Head head() {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("id", record.id());
        a.put("category", record.category());
        a.put("type_ko", record.typeKo());
        if (record.ident() != null) a.put("ident", record.ident());
        a.put("name", record.name());
        a.put("label", record.label());
        a.put("edition", edition.label());
        a.put("lower", limit(record.lower()));
        a.put("upper", limit(record.upper()));
        return new Alert.Head(null, null, null, null, AIRSPACE, level, Map.copyOf(a));
    }

    private static Map<String, Object> limit(AirspaceRecord.Limit l) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (l.ft() != null) m.put("ft", l.ft());
        m.put("basis", l.basis());
        m.put("raw", l.raw());
        return m;
    }
}
