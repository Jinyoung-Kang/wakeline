package dev.wakeline.demand;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** 임대 키 만료(ms) = api 시계로 잰 남은 시간 — Redis 없이(RedisDemandLeasesIT 가 실제 Redis 에서 시계 차이를 본다). */
class RedisDemandLeasesTest {
    @Test
    void keyTtlIsTheRemainingLeaseOnTheApiClock_andAtLeastOneMillisecond() {
        RedisDemandLeases leases = new RedisDemandLeases(null, () -> 1_000_000L);
        assertThat(leases.keyTtlMs(1_060_000L)).isEqualTo(60_000L);
        assertThat(leases.keyTtlMs(1_000_001L)).isEqualTo(1L);
        // 이미 지난 만료: 0 이나 음수를 PEXPIRE 에 주지 않는다(1 ms — 곧 사라진다)
        assertThat(leases.keyTtlMs(1_000_000L)).isEqualTo(1L);
        assertThat(leases.keyTtlMs(999_000L)).isEqualTo(1L);
    }
}
