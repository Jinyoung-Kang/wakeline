package dev.wakeline.domain;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 뷰포트 핫 리전 셀(ADR-013, 계약 v2 §A1). 중심은 0.5° 격자, 반경은 50 NM 단위 50–250.
 * 키 형식 {@code {lat:.1f}:{lon:.1f}:{radius}} (예: {@code 35.5:139.5:150}) — 임대 ZSET 의 member, 스트림 aircraft_payload.cell,
 * 수요 상태 필드 {@code hot:{key}} 가 모두 이 문자열이다. 같은 키를 보는 세션은 임대 하나를 나눠 쓴다.
 */
public record HotCell(double lat, double lon, int radiusNm) {
    public static final int MIN_RADIUS_NM = 50;
    public static final int MAX_RADIUS_NM = 250;
    public static final int STEP_NM = 50;
    /** 셀 중심 위도 상한(계약 v2 §A1 — 극지방은 메르카토르 뷰포트가 무의미하게 넓다). */
    public static final double MAX_ABS_LAT = 85.0;
    /** schemas/stream_envelope.v1.json aircraft_payload.cell 과 같은 패턴. */
    private static final Pattern KEY = Pattern.compile("^(-?[0-9]{1,2}\\.[05]):(-?[0-9]{1,3}\\.[05]):(50|100|150|200|250)$");

    public String key() {
        return String.format(Locale.ROOT, "%.1f:%.1f:%d", lat, lon, radiusNm);
    }

    /** 키 해석 — 형식이나 범위(위도 ±85, 경도 ±180)가 맞지 않으면 null. */
    public static HotCell parse(String key) {
        if (key == null || key.length() > 20) return null;
        Matcher m = KEY.matcher(key);
        if (!m.matches()) return null;
        double lat = Double.parseDouble(m.group(1)), lon = Double.parseDouble(m.group(2));
        if (Math.abs(lat) > MAX_ABS_LAT || Math.abs(lon) > 180.0) return null;
        return new HotCell(lat, lon, Integer.parseInt(m.group(3)));
    }

    /**
     * 세션 뷰포트 → 셀(계약 v2 §A1): 화면 중심을 0.5° 격자로 맞추고, 반경 = min(250, ⌈반대각선 NM / 50⌉ × 50), 최소 50.
     * 반대각선은 두 대각선(남서–북동 · 북서–남동) 중 긴 쪽의 절반 — 메르카토르 화면은 위도에 따라 두 대각선 길이가 다르다.
     * 격자 중심이 위도 ±85 를 넘으면 null(핫 리전을 만들지 않는다).
     */
    public static HotCell forViewport(Bbox b) {
        double clat = (b.lamin() + b.lamax()) / 2.0, clon = (b.lomin() + b.lomax()) / 2.0;
        double glat = Math.round(clat * 2.0) / 2.0, glon = Math.round(clon * 2.0) / 2.0;
        if (!Double.isFinite(glat) || !Double.isFinite(glon) || Math.abs(glat) > MAX_ABS_LAT || Math.abs(glon) > 180.0) return null;
        double diag = Math.max(Geo.haversineNm(b.lamin(), b.lomin(), b.lamax(), b.lomax()),
                Geo.haversineNm(b.lamax(), b.lomin(), b.lamin(), b.lomax()));
        int r = (int) (Math.ceil(diag / 2.0 / STEP_NM) * STEP_NM);
        return new HotCell(glat, glon, Math.max(MIN_RADIUS_NM, Math.min(MAX_RADIUS_NM, r)));
    }
}
