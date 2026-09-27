package dev.skywx.engine;

import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/** REL-1/COR-2: 알림 id 는 시간 기반(epochMillis×1000+카운터)·단조 — 재시작 후 이전 실행의 id 와 겹치지 않는다. */
class AlertIdsTest {

    @Test void monotonicWithinSameMillisecond_andSeededFromClock() {
        AtomicLong clock = new AtomicLong(1_790_507_963_000L);
        AlertIds ids = new AlertIds(clock::get);
        long a = ids.next(), b = ids.next(), c = ids.next();
        assertThat(a).isEqualTo(1_790_507_963_000_000L);
        assertThat(b).isEqualTo(a + 1);
        assertThat(c).isEqualTo(a + 2);
        clock.addAndGet(5);
        assertThat(ids.next()).isEqualTo(1_790_507_963_005_000L);
    }

    @Test void burstThenRestart_newRunNeverReusesIds() {
        AtomicLong clock = new AtomicLong(1_790_507_000_000L);
        AlertIds run1 = new AlertIds(clock::get);
        Set<Long> issued = new HashSet<>();
        long max1 = 0;
        // 이전 실행: 주기마다 100건+ 폭주(같은 ms 안), 10 s 주기로 3시간
        for (int cycle = 0; cycle < 1080; cycle++) {
            for (int i = 0; i < 150; i++) { long id = run1.next(); issued.add(id); max1 = Math.max(max1, id); }
            clock.addAndGet(10_000);
        }
        // 재시작(40 s 뒤) — 새 실행의 첫 id 는 이전 실행의 모든 id 보다 크다
        clock.addAndGet(40_000);
        AlertIds run2 = new AlertIds(clock::get);
        long first = run2.next();
        assertThat(first).isGreaterThan(max1);
        assertThat(issued).doesNotContain(first);
    }

    @Test void clockGoingBackwards_staysMonotonic() {
        AtomicLong clock = new AtomicLong(2_000_000L);
        AlertIds ids = new AlertIds(clock::get);
        long a = ids.next();
        clock.set(1_000_000L);
        assertThat(ids.next()).isGreaterThan(a);
    }

    @Test void newIdsAreAboveLegacyEpochSecondIds_andJsSafe() {
        long legacy = 1_790_508_093L; // 이전 형식(epoch 초 기반)
        long id = new AlertIds(System::currentTimeMillis).next();
        assertThat(id).isGreaterThan(legacy).isLessThan(9_007_199_254_740_991L); // Number.MAX_SAFE_INTEGER
    }
}
