package dev.wakeline.geo;

import java.math.BigDecimal;

/** lomin,lamin,lomax,lamax (WGS84). REST 문자열 해석과 면적 상한(400 · 422)은 platform.web.BboxParam 이 한다. */
public record Bbox(double lomin, double lamin, double lomax, double lamax) {
    /**
     * REST·WS 공통 규칙(R-16): 네 값 모두 유한하고, 위도 −90~90 · 경도 −180~180 안이며, 최소 &lt; 최대. 아니면 null.
     */
    public static Bbox checked(double lomin, double lamin, double lomax, double lamax) {
        if (!Double.isFinite(lomin) || !Double.isFinite(lamin) || !Double.isFinite(lomax) || !Double.isFinite(lamax)) return null;
        if (lamin < -90 || lamax > 90 || lamin >= lamax || lomin < -180 || lomax > 180 || lomin >= lomax) return null;
        return new Bbox(lomin, lamin, lomax, lamax);
    }

    /**
     * 넓이(sq° — 경도 폭 × 위도 폭). 뺄셈 · 곱셈은 네 값의 10진 표기(Double.toString 의 가장 짧은 표기 — 클라이언트가 보낸 10진 값)로 한다(QA-1311):
     * 이진 부동소수 뺄셈은 150.3 − 100.3 = 50.000000000000014 처럼 오차가 있어, 10진 표기로 정확히 50° × 50°(= 2,500 sq°, 상한 안)인 상자가 자리에 따라
     * 상한(REST 422 · WS BBOX_TOO_LARGE — '초과'만)에 걸렸다. 정말 넘는 상자(50.0000001° 폭 등)는 그대로 넘는다.
     */
    public double area() {
        return BigDecimal.valueOf(lomax).subtract(BigDecimal.valueOf(lomin))
                .multiply(BigDecimal.valueOf(lamax).subtract(BigDecimal.valueOf(lamin))).doubleValue();
    }

    public boolean contains(double lat, double lon) {
        return lat >= lamin && lat <= lamax && lon >= lomin && lon <= lomax;
    }

    /** 두 bbox 가 겹치는가(경계 포함). */
    public boolean intersects(Bbox o) {
        return o != null && lomin <= o.lomax && o.lomin <= lomax && lamin <= o.lamax && o.lamin <= lamax;
    }

    public static Bbox world() { return new Bbox(-180, -90, 180, 90); }
}
