package dev.wakeline.engine;

/** 구면 dead reckoning(10.1절 서버판). 1 kt = 1,852 m/h, R = 6,371 km. */
public final class DeadReckoning {
    public static final double R_M = 6_371_000.0;
    public static final double NM_M = 1852.0;

    private DeadReckoning() {}

    /** @return {lat, lon} */
    public static double[] predict(double lat, double lon, double trackDeg, double gsKt, double dtS) {
        double d = gsKt * NM_M * dtS / 3600.0;
        double delta = d / R_M;
        double th = Math.toRadians(trackDeg);
        double p1 = Math.toRadians(lat), l1 = Math.toRadians(lon);
        double p2 = Math.asin(Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(th));
        double l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(delta) * Math.cos(p1), Math.cos(delta) - Math.sin(p1) * Math.sin(p2));
        return new double[]{Math.toDegrees(p2), wrap180(Math.toDegrees(l2))};
    }

    public static double wrap180(double lon) {
        double x = ((lon + 180.0) % 360.0 + 360.0) % 360.0 - 180.0;
        return x;
    }

    public static double haversineNm(double lat1, double lon1, double lat2, double lon2) {
        return dev.wakeline.geo.Geo.haversineNm(lat1, lon1, lat2, lon2);
    }
}
