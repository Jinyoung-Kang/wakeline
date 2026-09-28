package dev.wakeline.ops;

import java.time.Duration;

/**
 * 주기 작업의 실패 경고 간격: 성공 뒤 첫 실패는 바로 경고, 계속 실패하면 {@code every} 마다 한 번(그 사이는 조용히), 실패 뒤 첫 성공은 회복으로 한 번.
 * 60 s 마다 도는 안전망이 멈춘 것을 기본 로그 수준에서 놓치지 않으면서 같은 경고를 쌓지 않는다. 시각은 부르는 쪽이 준다(시험).
 */
final class FailureWarnings {
    /** @param warn 이번 실패를 경고로 남길 차례 @param failures 연속 실패 수(이번 포함) @param sinceMs 연속 실패가 시작된 시각 */
    record Failure(boolean warn, int failures, long sinceMs) {}

    /** 회복: 끝난 연속 실패의 수와 시작 시각 */
    record Recovery(int failures, long sinceMs) {}

    private final long everyMs;
    private int failures;
    private long sinceMs;
    private long lastWarnMs;

    FailureWarnings(Duration every) { this.everyMs = every.toMillis(); }

    synchronized Failure failed(long nowMs) {
        boolean warn;
        if (failures == 0) {
            sinceMs = nowMs;
            warn = true;
        } else {
            warn = nowMs - lastWarnMs >= everyMs;
        }
        failures++;
        if (warn) lastWarnMs = nowMs;
        return new Failure(warn, failures, sinceMs);
    }

    /** @return 실패 뒤 첫 성공이면 끝난 연속 실패, 아니면 null */
    synchronized Recovery succeeded() {
        if (failures == 0) return null;
        Recovery r = new Recovery(failures, sinceMs);
        failures = 0;
        return r;
    }
}
