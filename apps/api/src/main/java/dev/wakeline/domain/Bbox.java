package dev.wakeline.domain;

import dev.wakeline.config.Problem;

import java.util.regex.Pattern;

/** lomin,lamin,lomax,lamax (WGS84). 면적 상한 검사 포함. */
public record Bbox(double lomin, double lamin, double lomax, double lamax) {
    /**
     * REST bbox 의 숫자 하나: 10진 소수 표기만(부호·소수점 허용). NaN·Infinity·지수 표기(1e2)·16진 실수(0x1p3)·형 접미사(1d)는 받지 않는다(R-16) —
     * Double.parseDouble 은 이것들을 모두 받아 NaN 이 범위·면적 검사를 통과했다.
     */
    private static final Pattern DECIMAL = Pattern.compile("^[+-]?(?:\\d{1,20}(?:\\.\\d{1,20})?|\\.\\d{1,20})$");

    public static Bbox parse(String s, double maxAreaSqdeg) {
        if (s == null) throw Problem.badRequest("BAD_BBOX", "bbox required: lomin,lamin,lomax,lamax");
        String[] p = s.split(",", -1);
        if (p.length != 4) throw Problem.badRequest("BAD_BBOX", "bbox must have 4 numbers");
        double[] v = new double[4];
        for (int i = 0; i < 4; i++) {
            String t = p[i].trim();
            if (!DECIMAL.matcher(t).matches()) throw Problem.badRequest("BAD_BBOX", "bbox must be 4 decimal numbers");
            v[i] = Double.parseDouble(t);
        }
        Bbox b = checked(v[0], v[1], v[2], v[3]);
        if (b == null) throw Problem.badRequest("BAD_BBOX", "bbox out of range");
        if (maxAreaSqdeg > 0 && b.area() > maxAreaSqdeg)
            throw Problem.unprocessable("BBOX_TOO_LARGE", "bbox too large",
                    "bbox area %.0f sq° exceeds %.0f".formatted(b.area(), maxAreaSqdeg));
        return b;
    }

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
