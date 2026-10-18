package dev.wakeline.platform.support;

import java.time.Instant;

/**
 * fetched_at 단조 가드(REL-8)의 '새 값인가' 판단 — 이 한 곳에서만 한다(IM-08). 실시간 상태는 '최신만 의미'라 지금 값보다 새 것만 받는다:
 * 항공기 region · global 스냅샷 · hot 셀 · focus hex(SnapshotStore), SIGMET · 기상특보 · 레이더 목록(SigmetStore · WarningStore · RadarStore),
 * 그리고 StreamConsumer 의 사전 검사(region · global · SIGMET). 받지 않은 메시지는 백로그 · 재전달 · 중복이다 — 이력(항적 · SIGMET · 특보)은
 * 스트림 순서대로 따로 남는다.
 * <p>
 * nowMs 는 api 의 지금(ms)이다. 저장소는 시계를 읽지 않고 받는다(ShipStore.apply(nowMs) 와 같은 방식 — 시험이 시계를 정한다).
 * 아직 판단에 쓰지 않는다.
 */
public final class FetchedAtGuard {
    private FetchedAtGuard() {}

    /**
     * @param candidate 받은 메시지의 fetched_at
     * @param current   지금 값의 fetched_at(받은 적이 없으면 EPOCH)
     * @param nowMs     api 의 지금(ms)
     * @return candidate 를 새 값으로 받아야 하면 true
     */
    public static boolean newer(Instant candidate, Instant current, long nowMs) {
        return candidate.isAfter(current);
    }
}
