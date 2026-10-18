package dev.wakeline.platform.support;

import java.time.Instant;

/**
 * fetched_at 단조 가드(REL-8)의 '새 값인가' 판단 — 이 한 곳에서만 한다(IM-08). 실시간 상태는 '최신만 의미'라 지금 값보다 새 것만 받는다:
 * 항공기 region · global 스냅샷 · hot 셀 · focus hex(SnapshotStore), SIGMET · 기상특보 · 레이더 목록(SigmetStore · WarningStore · RadarStore),
 * 그리고 StreamConsumer 의 사전 검사(region · global · SIGMET). 받지 않은 메시지는 백로그 · 재전달 · 중복이다 — 이력(항적 · SIGMET · 특보)은
 * 스트림 순서대로 따로 남는다. 알림 상태 기계(AlertStateMachine)는 기체 관측의 seen_at 에 같은 규칙을 써서 '새 관측인가' 를 본다
 * (수집기는 공급자 시각이 수신 시각과 어긋나면 수신 시각으로 seen_at 을 매기므로 역행 뒤에는 seen_at 도 작아진다).
 * <p>
 * 벽시계 역행(IM-08): fetched_at 은 수집기의 벽시계이고 수집기와 api 는 같은 호스트의 같은 시계를 쓴다. 그 시계가 실행 중 X 만큼 뒤로 가면
 * 그 뒤 메시지의 fetched_at 은 마지막으로 받은 값보다 작아, 단조 비교만으로는 시계가 그 값을 다시 지날 때까지(약 X) 새 메시지를 모두 버린다
 * (지도 · 알림 판정 · SIGMET · 특보 · 레이더가 말없이 멈춘다). 같은 호스트에서는 지금 값의 fetched_at 이 api 의 지금보다 미래일 수 없으므로
 * (수집기가 받은 뒤에 api 가 처리한다) 허용치({@link #CLOCK_BACK_TOLERANCE_MS}) 넘게 미래이면 시계가 뒤로 간 것으로 보고, 지금 근처(지금 −
 * 허용치 이상 · 지금 + 허용치 이하)의 값을 새 값으로 받는다 — 받는 순간 지금 값이 지금 근처로 내려와 그 뒤는 평소처럼 돈다.
 * 지금 값이 과거인 재전송 · 백로그는 그대로 거부한다. 계단 전에 쓴 엔트리도 거부한다: 이 값도 api 의 지금보다 허용치 넘게 미래인 것(계단 직전에
 * 쓴 것의 PEL 재처리 · 중복)과, api 의 지금보다 허용치 넘게 과거인 것(계단보다 한참 전에 쓴 것 — 재시작 때 PEL 재처리 · 백로그. 받으면 실시간
 * 상태가 그 옛 값으로 되감겼다가 뒤따르는 계단 전 엔트리로 다시 앞으로 간다, R3). 대가: 지금 값이 미래인 동안 api 가 허용치 넘게 밀려 처리하는
 * 계단 뒤 값도 받지 않아, 지금 근처의 값이 올 때까지(SIGMET · 특보는 다음 폴링) 지금 값이 계단 전 값에 남는다.
 * 허용치는 로그 읽기의 미래 허용(ADR-018)과 같은 60 s 다 — 그보다 작게 뒤로 간 경우는 예전처럼 그 폭만큼(폴링 간격을 빼고) 기다린다.
 * 한계: 시계가 api 보다 허용치 넘게 앞선 다른 호스트에 수집기를 두면 오래된 재전달을 역행으로 볼 수 있다(지금 구성은 수집기와 api 가 한 호스트 — 같은 시계).
 * <p>
 * nowMs 는 api 의 지금(ms)이다. 저장소는 시계를 읽지 않고 받는다(ShipStore.apply(nowMs) 와 같은 방식 — 시험이 시계를 정한다).
 */
public final class FetchedAtGuard {
    /** 지금 값의 fetched_at 이 api 의 지금보다 이만큼 넘게 미래이면 벽시계가 뒤로 간 것으로 본다(그때 받는 값은 api 의 지금 ± 이만큼 안). */
    public static final long CLOCK_BACK_TOLERANCE_MS = 60_000;

    private FetchedAtGuard() {}

    /** 판단 결과. */
    public enum Verdict {
        /** fetched_at 이 지금 값보다 크다 — 받는다. */
        NEWER,
        /** fetched_at 은 크지 않지만 지금 값이 api 의 지금보다 허용치 넘게 미래이고 이 값은 지금 근처(지금 ± 허용치) — 벽시계가 뒤로 갔다. 받는다(센다). */
        CLOCK_STEPPED_BACK,
        /** 백로그 · 재전달 · 중복 — 받지 않는다. */
        NOT_NEWER;

        public boolean accepted() { return this != NOT_NEWER; }
    }

    /**
     * @param candidate 받은 메시지의 fetched_at
     * @param current   지금 값의 fetched_at(받은 적이 없으면 EPOCH)
     * @param nowMs     api 의 지금(ms)
     */
    public static Verdict judge(Instant candidate, Instant current, long nowMs) {
        if (candidate.isAfter(current)) return Verdict.NEWER;
        boolean currentAhead = current.toEpochMilli() - nowMs > CLOCK_BACK_TOLERANCE_MS;
        long fromNow = candidate.toEpochMilli() - nowMs;
        // 새 시계의 지금 근처 — 아래 한계가 없으면 계단보다 한참 전에 쓴 엔트리(재시작 때 PEL · 백로그)도 받아 상태를 되감는다(R3)
        boolean candidateNearNow = fromNow <= CLOCK_BACK_TOLERANCE_MS && fromNow >= -CLOCK_BACK_TOLERANCE_MS;
        return currentAhead && candidateNearNow ? Verdict.CLOCK_STEPPED_BACK : Verdict.NOT_NEWER;
    }

    /** @return candidate 를 새 값으로 받아야 하면 true({@link #judge} 가 NEWER 또는 CLOCK_STEPPED_BACK) */
    public static boolean newer(Instant candidate, Instant current, long nowMs) {
        return judge(candidate, current, nowMs).accepted();
    }
}
