package dev.wakeline.platform.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * @Scheduled 작업의 스케줄러(R-44). spring.threads.virtual.enabled 일 때 Boot 가 만드는 SimpleAsyncTaskScheduler 는 fixedDelay 작업을
 * 모두 스케줄러 스레드 하나에서 직렬로 돌린다 — 유지보수 catch-up(DB)·스트림 지표(Redis, 명령 한도 3 s × 8)가 걸리면 그 사이 SIGMET 만료 점검
 * (REL-13)·WS heartbeat·AIS 수신 상태 갱신이 수십 초 밀렸다.
 * <p>
 * 여기서는 작업 수보다 넉넉한 풀(가상 스레드)로 둔다: 모든 @Scheduled 작업(현재 fixedDelay 10 · cron 3)이 동시에 걸려도 서로를 기다리지 않는다.
 * fixedDelay 의미(끝난 뒤 지연)는 그대로이고, 같은 작업이 겹쳐 돌지는 않는다. 작업을 더하면 {@link #POOL_SIZE} 를 넘지 않는지
 * SchedulingIT 가 확인한다. 작업 예외는 기본 오류 처리기가 로그로 남기고 다음 주기는 계속된다(이전과 같다).
 */
@Profile("!cli & !migrate")
@Configuration(proxyBeanMethods = false)
public class SchedulingConfig {
    /** @Scheduled 작업 수(13)보다 크게 — 한 작업이 막혀도 다른 작업은 제때 돈다. */
    public static final int POOL_SIZE = 16;

    @Bean(name = "taskScheduler")
    ThreadPoolTaskScheduler taskScheduler() {
        ThreadPoolTaskScheduler s = new ThreadPoolTaskScheduler();
        s.setPoolSize(POOL_SIZE);
        s.setVirtualThreads(true);
        s.setThreadNamePrefix("sched-");
        s.setRemoveOnCancelPolicy(true);
        return s;
    }
}
