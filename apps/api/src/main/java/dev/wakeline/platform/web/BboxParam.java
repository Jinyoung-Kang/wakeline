package dev.wakeline.platform.web;

import dev.wakeline.geo.Bbox;

import java.util.regex.Pattern;

/**
 * REST bbox 파라미터 "lomin,lamin,lomax,lamax"(WGS84) 해석 — 틀리면 400 BAD_BBOX, 면적 상한을 넘으면 422 BBOX_TOO_LARGE({@link Problem}).
 * 값 규칙(유한 · 범위 · 최소 &lt; 최대)은 REST · WS 가 같은 {@link Bbox#checked}. 예전에는 Bbox.parse 라 값 타입(domain)이 HTTP 오류형을 알았다(api-review E1).
 */
public final class BboxParam {
    private BboxParam() {}

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
            String t = p[i].strip(); // 공백만 — trim() 은 NUL 같은 제어 문자도 지워 '124\u0000' 이 지났다(§G43)
            if (!DECIMAL.matcher(t).matches()) throw Problem.badRequest("BAD_BBOX", "bbox must be 4 decimal numbers");
            v[i] = Double.parseDouble(t);
        }
        Bbox b = Bbox.checked(v[0], v[1], v[2], v[3]);
        if (b == null) throw Problem.badRequest("BAD_BBOX", "bbox out of range");
        if (maxAreaSqdeg > 0 && b.area() > maxAreaSqdeg)
            throw Problem.unprocessable("BBOX_TOO_LARGE", "bbox too large",
                    "bbox area %.0f sq° exceeds %.0f".formatted(b.area(), maxAreaSqdeg));
        return b;
    }
}
