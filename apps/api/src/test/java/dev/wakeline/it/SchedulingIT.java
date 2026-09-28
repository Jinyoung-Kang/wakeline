package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.scheduling.TaskScheduler;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-44: @Scheduled 작업이 쓰는 스케줄러(빈 이름 taskScheduler)에서 fixedDelay 작업 하나가 오래 걸려도(유지보수 catch-up·Redis 지연)
 * 다른 fixedDelay 작업(SIGMET 만료 점검·WS heartbeat·AIS 상태 갱신)이 그 뒤에 줄 서지 않는다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class SchedulingIT extends IntegrationTest {
    @Autowired @Qualifier("taskScheduler") TaskScheduler scheduler;
    @Autowired org.springframework.scheduling.config.ScheduledTaskHolder scheduledTasks;

    /** 풀이 등록된 @Scheduled 작업 수보다 크다 — 모두 동시에 걸려도 서로를 기다리지 않는다(작업을 더하면 여기서 알린다). */
    @Test
    void poolIsLargerThanTheNumberOfScheduledJobs() {
        assertThat(scheduledTasks.getScheduledTasks()).isNotEmpty();
        assertThat(scheduledTasks.getScheduledTasks().size()).isLessThan(dev.wakeline.config.SchedulingConfig.POOL_SIZE);
        assertThat(scheduler).isInstanceOf(org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler.class);
        // 앱의 @Scheduled 작업이 실제로 이 풀에 걸려 있다
        var pool = ((org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler) scheduler).getScheduledThreadPoolExecutor();
        assertThat(pool.getTaskCount()).isGreaterThanOrEqualTo(scheduledTasks.getScheduledTasks().size());
    }

    @Test
    void aBlockedFixedDelayJobDoesNotHoldBackTheOthers() throws Exception {
        CountDownLatch slowStarted = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch otherRan = new CountDownLatch(1);
        ScheduledFuture<?> slow = scheduler.scheduleWithFixedDelay(() -> {
            slowStarted.countDown();
            try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        }, Duration.ofHours(1));
        try {
            assertThat(slowStarted.await(5, TimeUnit.SECONDS)).as("slow job started").isTrue();
            ScheduledFuture<?> other = scheduler.scheduleWithFixedDelay(otherRan::countDown, Duration.ofHours(1));
            try {
                assertThat(otherRan.await(3, TimeUnit.SECONDS)).as("another fixed-delay job ran while the slow one was still running").isTrue();
            } finally {
                other.cancel(false);
            }
        } finally {
            release.countDown();
            slow.cancel(false);
        }
    }
}
