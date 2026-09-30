package dev.wakeline.coverage;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 관측 수신 격자(ADR-027)의 칸별 MMSI → 마지막 시 표: 열린 주소 int → int 표가 HashMap 과 같은 답을 주는지, 지우기 · 줄이기가 맞는지. */
class IntIntMapTest {

    @Test
    void getPutAndSizeMatchAHashMapUnderRandomUse() {
        IntIntMap m = new IntIntMap();
        Map<Integer, Integer> ref = new HashMap<>();
        Random r = new Random(7);
        for (int i = 0; i < 20_000; i++) {
            int k = r.nextInt(5_000) * 1_000 + 100_000_000; // MMSI 모양의 9자리
            int v = r.nextInt(1_000_000);
            assertThat(m.put(k, v)).isEqualTo(ref.containsKey(k) ? ref.get(k) : IntIntMap.MISSING);
            ref.put(k, v);
        }
        assertThat(m.size()).isEqualTo(ref.size());
        for (var e : ref.entrySet()) assertThat(m.get(e.getKey())).isEqualTo(e.getValue());
        assertThat(m.get(999_999_999)).isEqualTo(IntIntMap.MISSING);
    }

    @Test
    void removeBelowDropsOnlyOldEntriesAndKeepsTheRestReachable() {
        IntIntMap m = new IntIntMap();
        for (int k = 0; k < 1_000; k++) m.put(k, k % 10);
        assertThat(m.removeBelow(5)).isEqualTo(500);
        assertThat(m.size()).isEqualTo(500);
        for (int k = 0; k < 1_000; k++) assertThat(m.get(k)).isEqualTo(k % 10 < 5 ? IntIntMap.MISSING : k % 10);
        // 지운 뒤에도 새 키를 넣고 찾을 수 있다(열린 주소의 사슬이 끊기지 않는다)
        m.put(123_456_789, 42);
        assertThat(m.get(123_456_789)).isEqualTo(42);
        assertThat(m.removeBelow(100)).isEqualTo(501);
        assertThat(m.size()).isZero();
        assertThat(m.capacity()).as("an emptied map shrinks back to the initial arrays").isEqualTo(IntIntMap.INITIAL_CAPACITY);
    }

    @Test
    void capacityGrowsAtHalfLoadAndShrinksWhenMostlyRemoved() {
        IntIntMap m = new IntIntMap();
        for (int k = 0; k < 100; k++) m.put(k, 1);
        assertThat(m.capacity()).isGreaterThanOrEqualTo(200).isEqualTo(256);
        for (int k = 0; k < 90; k++) m.put(k, 0);
        m.removeBelow(1);
        assertThat(m.size()).isEqualTo(10);
        assertThat(m.capacity()).as("rebuilt at the smallest power of two ≥ 2 × size").isEqualTo(32);
    }

    @Test
    void negativeKeysAreRejected_mmsiIsNeverNegative() {
        IntIntMap m = new IntIntMap();
        assertThatThrownBy(() -> m.put(-1, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThat(m.get(-5)).isEqualTo(IntIntMap.MISSING);
    }
}
