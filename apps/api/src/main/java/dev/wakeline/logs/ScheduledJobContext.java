package dev.wakeline.logs;

import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationHandler;
import org.slf4j.MDC;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.support.ScheduledTaskObservationContext;
import org.springframework.stereotype.Component;

/**
 * @Scheduled 작업의 이름을 로그 항목의 context.job 에 싣는다(계약 v5 §C2 "context 는 스레드 이름 외에 작업 이름 등").
 * <p>
 * 예약 작업은 스케줄러 풀(sched-1 … sched-16, SchedulingConfig)에서 돌아 thread 칸만으로는 어느 작업인지 알 수 없다. Spring 은 @Scheduled
 * 메서드를 부를 때마다 그 스레드에서 관측(tasks.scheduled.execution)을 열고 닫는다 — Boot 가 스케줄러에 관측 레지스트리를 넣고
 * (ScheduledTasksObservationAutoConfiguration) 이 빈을 처리기로 붙인다. 범위가 열린 동안 MDC "job" = 클래스 이름.메서드 이름
 * (예: MaintenanceJobs.dropOldPartitions)을 두고, 닫히면 전 값으로 되돌린다. 싱크는 request_id 외의 MDC 를 context 에 싣는다
 * (LogEvents.fromLogback) — 이름은 추측이 아니라 지금 도는 메서드 그대로다.
 * <ul>
 *   <li>전용 스레드에서 도는 일(stream-consumer · track-writer · ship-fanout 등)은 thread 칸의 이름이 곧 작업 이름이라 따로 싣지 않는다.
 *       요청 처리 중의 로그는 request_id 로 묶는다.</li>
 *   <li>작업이 예외를 던져 Spring 의 오류 처리기가 남기는 ERROR 는 범위가 닫힌 뒤라 job 이 없다 — 그 스택에 메서드가 있다.</li>
 * </ul>
 */
@Profile("!cli & !migrate")
@Component
public class ScheduledJobContext implements ObservationHandler<ScheduledTaskObservationContext> {
    public static final String MDC_JOB = "job";
    /** 범위를 열기 전의 MDC job(작업 안에서 다른 작업을 직접 부른 경우) — 관측 컨텍스트에 맡겨 둔다. */
    private static final String PREVIOUS = ScheduledJobContext.class.getName() + ".previous";

    @Override
    public boolean supportsContext(Observation.Context context) {
        return context instanceof ScheduledTaskObservationContext;
    }

    @Override
    public void onScopeOpened(ScheduledTaskObservationContext context) {
        String previous = MDC.get(MDC_JOB);
        if (previous != null) context.put(PREVIOUS, previous);
        MDC.put(MDC_JOB, name(context));
    }

    @Override
    public void onScopeClosed(ScheduledTaskObservationContext context) {
        String previous = context.get(PREVIOUS);
        if (previous != null) MDC.put(MDC_JOB, previous);
        else MDC.remove(MDC_JOB);
    }

    /** 클래스 이름(패키지 없이 — 로거 칸에 이미 있다).메서드 이름. 익명 클래스는 전체 이름. */
    static String name(ScheduledTaskObservationContext context) {
        Class<?> type = context.getTargetClass();
        String simple = type.getSimpleName();
        return (simple.isEmpty() ? type.getName() : simple) + "." + context.getMethod().getName();
    }
}
