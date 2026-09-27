package dev.skywx.engine;

/**
 * 한 항공기에 대해 진입 예측(dead reckoning)을 할 수 있는가(계약 §1 "selected".prediction).
 * reason: null(가능, 또는 사유를 계약 값으로 표현할 수 없음) | turning | slow | on_ground | no_track | stale.
 */
public record PredictionAvailability(boolean available, String reason) {
    public static final String TURNING = "turning";
    public static final String SLOW = "slow";
    public static final String ON_GROUND = "on_ground";
    /** 트랙·속도·고도 중 dead reckoning 에 필요한 값이 없음. */
    public static final String NO_TRACK = "no_track";
    /** 위치가 오래됨(opensky 300 s, 그 외 60 s 초과). */
    public static final String STALE = "stale";

    public static final PredictionAvailability AVAILABLE = new PredictionAvailability(true, null);

    public static PredictionAvailability unavailable(String reason) { return new PredictionAvailability(false, reason); }
}
