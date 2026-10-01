package dev.wakeline.logs;

import ch.qos.logback.classic.LoggerContext;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.micrometer.observation.ObservationRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.MDC;
import org.springframework.scheduling.support.ScheduledMethodRunnable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 v5 §C2 "context 는 스레드 이름 외에 작업 이름 등": @Scheduled 메서드가 도는 동안의 WARN·ERROR 는 context.job = 클래스.메서드,
 * 끝나면 스레드의 MDC 를 되돌린다(다음 로그에 남지 않는다). 앱 전체 경로(스케줄러 · Boot 관측 설정)는 LogsIT 가 본다.
 */
class ScheduledJobContextTest {
    static final JsonMapper M = JsonMapper.builder().build();
    final List<String> written = new ArrayList<>();
    final LoggerContext logback = new LoggerContext();
    final LogSink sink;
    final ObservationRegistry observations = ObservationRegistry.create();

    ScheduledJobContextTest() {
        logback.setMDCAdapter(MDC.getMDCAdapter()); // 처리기가 쓰는 slf4j MDC 와 같은 것
        sink = new LogSink((stream, json) -> written.add(json), new SimpleMeterRegistry(), true, LogSink.WINDOW_CLOCK, logback, 60_000, 1000, 30_000);
        sink.attach();
        observations.observationConfig().observationHandler(new ScheduledJobContext());
    }

    @AfterEach
    void clear() { MDC.clear(); }

    /** 예약 작업 흉내: 경고 하나. */
    public static final class RetentionJob {
        final Logger log;

        RetentionJob(Logger log) { this.log = log; }

        public void dropOldPartitions() { log.warn("retention {} failed: timeout", "track_point_1m"); }
    }

    JsonNode lastEntry() {
        sink.flushOnce();
        assertThat(written).isNotEmpty();
        return M.readTree(written.getLast());
    }

    @Test
    void aWarningInsideAScheduledMethodCarriesTheJobName_andTheMdcIsRestoredAfterwards() throws Exception {
        var job = new RetentionJob(logback.getLogger("dev.wakeline.history.MaintenanceJobs"));
        new ScheduledMethodRunnable(job, RetentionJob.class.getMethod("dropOldPartitions"), null, () -> observations).run();
        JsonNode e = lastEntry();
        assertThat(e.path("message").asString()).isEqualTo("retention track_point_1m failed: timeout");
        assertThat(e.path("context").path("job").asString()).isEqualTo("RetentionJob.dropOldPartitions");
        assertThat(new LogEventSchema().validate(written.getLast())).isNull();
        assertThat(MDC.get(ScheduledJobContext.MDC_JOB)).as("restored after the job").isNull();

        logback.getLogger("dev.wakeline.X").warn("not in a job");
        assertThat(lastEntry().path("context").has("job")).isFalse();
    }

    @Test
    void anOuterJobNameComesBackAfterANestedOne() throws Exception {
        MDC.put(ScheduledJobContext.MDC_JOB, "Outer.run");
        var job = new RetentionJob(logback.getLogger("dev.wakeline.history.MaintenanceJobs"));
        new ScheduledMethodRunnable(job, RetentionJob.class.getMethod("dropOldPartitions"), null, () -> observations).run();
        assertThat(lastEntry().path("context").path("job").asString()).isEqualTo("RetentionJob.dropOldPartitions");
        assertThat(MDC.get(ScheduledJobContext.MDC_JOB)).isEqualTo("Outer.run");
    }

    @Test
    void withoutAnObservationRegistryNothingIsAdded() throws Exception {
        // 관측이 꺼진 설정(NOOP)에서는 처리기가 불리지 않는다 — 항목은 그대로 실린다
        var job = new RetentionJob(logback.getLogger("dev.wakeline.history.MaintenanceJobs"));
        new ScheduledMethodRunnable(job, RetentionJob.class.getMethod("dropOldPartitions"), null, () -> ObservationRegistry.NOOP).run();
        assertThat(lastEntry().path("context").has("job")).isFalse();
    }
}
