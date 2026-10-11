package dev.wakeline.history;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.annotation.Scheduled;

import java.lang.reflect.Method;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 따라잡기 주기(AWS 리뷰 2026-10 B-2). AWS 데모는 평일 낮에만 켜고(ADR-039) 03:30 KST 정시 집계는 꺼진 시간이라 돌지 않는다 — 일 통계는
 * 기동 뒤 따라잡기에만 기댄다. 기동 직후 따라잡기는 RDS 가 아직 준비되지 않아 실패할 수 있고(10-10 재기동에서 실제로 실패), 그 뒤 다음 시도가
 * 3 h 뒤였다: 금요일 교통량은 월요일 09:00 KST(목요일 UTC 파티션 삭제) 전까지만 다시 셀 수 있어, 월요일 기동 직후 한 번 실패하면 영구히 빠졌다.
 */
class MaintenanceCatchUpScheduleTest {
    static final Instant T0 = Instant.parse("2026-10-11T23:51:00Z"); // 월 08:51 KST

    /** 시계를 옮길 수 있는 MaintenanceJobs — 따라잡기 본체는 정해 둔 결과(성공 · 실패)를 차례로 돌려준다(DB 없이 주기만 본다) */
    static final class Jobs extends MaintenanceJobs {
        final MutableClock clock;
        final Deque<Boolean> results;
        int runs;

        Jobs(MutableClock clock, Boolean... results) {
            super(null, null, null, null, DEFAULT_ALERT_RETENTION_DAYS, clock);
            this.clock = clock;
            this.results = new ArrayDeque<>(List.of(results));
        }

        @Override
        boolean runCatchUp() {
            runs++;
            return results.isEmpty() || results.pop();
        }
    }

    static final class MutableClock extends Clock {
        Instant now;
        MutableClock(Instant now) { this.now = now; }
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        void advance(Duration d) { now = now.plus(d); }
    }

    @Test
    void theCatchUpTickRunsEveryMinuteSoAFailureIsRetriedQuickly() {
        Method tick = Arrays.stream(MaintenanceJobs.class.getMethods())
                .filter(m -> m.getName().startsWith("catchUp") && m.isAnnotationPresent(Scheduled.class)).findFirst().orElseThrow();
        Scheduled s = tick.getAnnotation(Scheduled.class);
        assertThat(s.initialDelay()).isEqualTo(60_000);
        assertThat(s.fixedDelay()).as("retry interval after a failed catch-up (ms)").isLessThanOrEqualTo(60_000);
    }

    @Test
    void aFailedCatchUpIsRetriedOnTheNextTickAndASuccessfulOneWaitsThreeHours() {
        MutableClock clock = new MutableClock(T0);
        Jobs jobs = new Jobs(clock, false, false, true);
        jobs.catchUpTick();                      // 기동 1분 뒤 — RDS 준비 전이라 실패
        clock.advance(Duration.ofMinutes(1));
        jobs.catchUpTick();                      // 1분 뒤 다시 — 또 실패
        clock.advance(Duration.ofMinutes(1));
        jobs.catchUpTick();                      // 1분 뒤 다시 — 성공(아직 월 09:00 KST 전)
        assertThat(jobs.runs).isEqualTo(3);
        for (int i = 0; i < 179; i++) { clock.advance(Duration.ofMinutes(1)); jobs.catchUpTick(); }
        assertThat(jobs.runs).as("no run within 3 h of a success").isEqualTo(3);
        clock.advance(Duration.ofMinutes(1));
        jobs.catchUpTick();
        assertThat(jobs.runs).as("the 3-hour cycle after a success").isEqualTo(4);
    }
}
