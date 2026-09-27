package dev.wakeline.domain;

/** 구면 거리(R = 6,371 km, 1 NM = 1,852 m). 엔진(DeadReckoning)·수요(HotCell)가 같은 식을 쓴다. */
public final class Geo {
    public static final double R_M = 6_371_000.0;
    public static final double NM_M = 1852.0;

    private Geo() {}

    /** 두 점 사이 대권 거리(NM, haversine). */
    public static double haversineNm(double lat1, double lon1, double lat2, double lon2) {
        double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2);
        double dp = p2 - p1, dl = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
        return 2 * R_M * Math.asin(Math.sqrt(Math.min(1.0, a))) / NM_M;
    }
}
