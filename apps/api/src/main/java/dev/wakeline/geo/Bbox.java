package dev.wakeline.geo;

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

    public double area() { return (lomax - lomin) * (lamax - lamin); }

    public boolean contains(double lat, double lon) {
        return lat >= lamin && lat <= lamax && lon >= lomin && lon <= lomax;
    }

    /** 두 bbox 가 겹치는가(경계 포함). */
    public boolean intersects(Bbox o) {
        return o != null && lomin <= o.lomax && o.lomin <= lomax && lamin <= o.lamax && o.lamin <= lamax;
    }

    public static Bbox world() { return new Bbox(-180, -90, 180, 90); }
}
