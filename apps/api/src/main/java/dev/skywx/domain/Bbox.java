package dev.skywx.domain;

import dev.skywx.config.Problem;

/** lomin,lamin,lomax,lamax (WGS84). 면적 상한 검사 포함. */
public record Bbox(double lomin, double lamin, double lomax, double lamax) {

    public static Bbox parse(String s, double maxAreaSqdeg) {
        if (s == null) throw Problem.badRequest("BAD_BBOX", "bbox required: lomin,lamin,lomax,lamax");
        String[] p = s.split(",");
        if (p.length != 4) throw Problem.badRequest("BAD_BBOX", "bbox must have 4 numbers");
        double[] v = new double[4];
        try {
            for (int i = 0; i < 4; i++) v[i] = Double.parseDouble(p[i].trim());
        } catch (NumberFormatException e) {
            throw Problem.badRequest("BAD_BBOX", "bbox must be numeric");
        }
        Bbox b = new Bbox(v[0], v[1], v[2], v[3]);
        if (b.lamin < -90 || b.lamax > 90 || b.lamin >= b.lamax || b.lomin < -180 || b.lomax > 180 || b.lomin >= b.lomax)
            throw Problem.badRequest("BAD_BBOX", "bbox out of range");
        if (maxAreaSqdeg > 0 && b.area() > maxAreaSqdeg)
            throw Problem.unprocessable("BBOX_TOO_LARGE", "bbox too large",
                    "bbox area %.0f sq° exceeds %.0f".formatted(b.area(), maxAreaSqdeg));
        return b;
    }

    public double area() { return (lomax - lomin) * (lamax - lamin); }

    public boolean contains(double lat, double lon) {
        return lat >= lamin && lat <= lamax && lon >= lomin && lon <= lomax;
    }

    public static Bbox world() { return new Bbox(-180, -90, 180, 90); }
}
