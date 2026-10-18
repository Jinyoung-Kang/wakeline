package dev.wakeline.platform.support;

import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * fetched_at 단조 가드(REL-8 · IM-08): 새 fetched_at 은 받고, 백로그 · 재전달 · 중복은 받지 않는다. 다만 지금 값의 fetched_at 이 api 의 지금보다
 * 60 s 넘게 미래이면 벽시계가 뒤로 간 것이다 — 그 뒤의 값(지금 근처)은 받는다. 계단 전에 쓴 엔트리(지금 값과 함께 미래이거나 지금보다 60 s 넘게
 * 과거)는 여전히 받지 않는다.
 */
class FetchedAtGuardTest {
    static final Instant T = Instant.parse("2026-09-27T05:10:00Z");

    static long ms(Instant t) { return t.toEpochMilli(); }

    @Test void aNewerFetchedAtIsNew() {
        assertThat(FetchedAtGuard.newer(T.plusMillis(1), T, ms(T))).isTrue();
        assertThat(FetchedAtGuard.newer(T, Instant.EPOCH, ms(T))).as("nothing received yet").isTrue();
        assertThat(FetchedAtGuard.newer(T.plusSeconds(300), T, ms(T))).as("a collector clock that runs ahead is still newer").isTrue();
    }

    @Test void olderOrEqual_isBacklogWhileTheCurrentValueIsNotAheadOfTheApiClock() {
        assertThat(FetchedAtGuard.newer(T.minusSeconds(295), T, ms(T.plusSeconds(10)))).as("redelivery: now = T + 10 s").isFalse();
        assertThat(FetchedAtGuard.newer(T, T, ms(T.plusSeconds(10)))).as("duplicate").isFalse();
        assertThat(FetchedAtGuard.newer(T.minusSeconds(30), T, ms(T.minusSeconds(60)))).as("exactly 60 s ahead is within the tolerance").isFalse();
    }

    @Test void afterTheWallClockWentBack_theValueFromTheNewTimelineIsNew() {
        assertThat(FetchedAtGuard.newer(T.minusSeconds(295), T, ms(T.minusSeconds(300)))).as("now = T - 300 s").isTrue();
        assertThat(FetchedAtGuard.newer(T.minusSeconds(30), T, ms(T.minusSeconds(60)) - 1)).as("just over 60 s ahead").isTrue();
        assertThat(FetchedAtGuard.newer(T.minusSeconds(3600), T, ms(T.minusSeconds(3600)))).as("a one-hour step").isTrue();
    }

    @Test void afterTheWallClockWentBack_entriesWrittenBeforeTheStepAreStillRejected() {
        // 계단 전에 쓴 엔트리(PEL 재처리 · 중복): 지금 값과 함께 api 의 지금보다 허용치 넘게 미래 — 새 시계의 값이 아니다
        assertThat(FetchedAtGuard.newer(T.minusSeconds(5), T, ms(T.minusSeconds(300)))).isFalse();
        assertThat(FetchedAtGuard.newer(T, T, ms(T.minusSeconds(300)))).isFalse();
    }

    /**
     * R3: 지금 값이 미래여도 api 의 지금보다 허용치 넘게 과거인 값(계단 X − 60 s 보다 전에 쓴 PEL 재처리 · 백로그)은 새 시계의 값이 아니다 —
     * 받으면 실시간 상태가 그 옛 값으로 되감겼다가 뒤따르는 계단 전 엔트리로 다시 앞으로 간다. 아래 한계는 지금 − 허용치(포함).
     */
    @Test void afterTheWallClockWentBack_valuesWellBeforeTheNewNowAreStillRejected() {
        long now = ms(T.minusSeconds(300));
        assertThat(FetchedAtGuard.judge(T.minusSeconds(600), T, now)).isEqualTo(FetchedAtGuard.Verdict.NOT_NEWER);
        assertThat(FetchedAtGuard.judge(T.minusSeconds(3600), T, now)).isEqualTo(FetchedAtGuard.Verdict.NOT_NEWER);
        assertThat(FetchedAtGuard.judge(T.minusSeconds(360), T, now)).as("exactly 60 s before now is within the tolerance")
                .isEqualTo(FetchedAtGuard.Verdict.CLOCK_STEPPED_BACK);
        assertThat(FetchedAtGuard.judge(T.minusSeconds(360).minusMillis(1), T, now)).as("just over 60 s before now")
                .isEqualTo(FetchedAtGuard.Verdict.NOT_NEWER);
    }

    /** 받는 까닭을 나눠 알린다 — 소비자는 CLOCK_STEPPED_BACK 만 따로 센다(stale_skipped 와 다른 지표). */
    @Test void judge_tellsWhyAValueIsTaken() {
        assertThat(FetchedAtGuard.judge(T.plusSeconds(1), T, ms(T))).isEqualTo(FetchedAtGuard.Verdict.NEWER);
        assertThat(FetchedAtGuard.judge(T.minusSeconds(295), T, ms(T.minusSeconds(300)))).isEqualTo(FetchedAtGuard.Verdict.CLOCK_STEPPED_BACK);
        assertThat(FetchedAtGuard.judge(T.minusSeconds(295), T, ms(T.plusSeconds(10)))).isEqualTo(FetchedAtGuard.Verdict.NOT_NEWER);
        assertThat(FetchedAtGuard.Verdict.NEWER.accepted()).isTrue();
        assertThat(FetchedAtGuard.Verdict.CLOCK_STEPPED_BACK.accepted()).isTrue();
        assertThat(FetchedAtGuard.Verdict.NOT_NEWER.accepted()).isFalse();
    }
}
