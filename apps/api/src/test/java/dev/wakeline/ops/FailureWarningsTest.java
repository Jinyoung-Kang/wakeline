package dev.wakeline.ops;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

/** 실패 경고 간격(StartupMirror 의 공급자 스위치 동기화): 첫 실패는 바로, 계속 실패하면 간격마다, 회복은 한 번. Docker 없이 돈다. */
class FailureWarningsTest {
    @Test
    void firstFailureWarnsThenOncePerIntervalAndRecoveryResets() {
        var w = new FailureWarnings(Duration.ofMinutes(10));
        assertThat(w.succeeded()).as("no failure yet").isNull();
        assertThat(w.failed(0)).isEqualTo(new FailureWarnings.Failure(true, 1, 0));
        assertThat(w.failed(60_000).warn()).isFalse();
        assertThat(w.failed(599_999).warn()).isFalse();
        assertThat(w.failed(600_000)).isEqualTo(new FailureWarnings.Failure(true, 4, 0));
        assertThat(w.failed(660_000).warn()).as("interval counts from the last warning").isFalse();
        assertThat(w.succeeded()).isEqualTo(new FailureWarnings.Recovery(5, 0));
        assertThat(w.succeeded()).as("recovery is reported once").isNull();
        assertThat(w.failed(700_000)).as("first failure after a success warns at once").isEqualTo(new FailureWarnings.Failure(true, 1, 700_000));
    }
}
