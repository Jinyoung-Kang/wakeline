package dev.wakeline.coverage;

import java.util.Arrays;

/**
 * 0 이상 int 키 → int 값의 작은 열린 주소 표(선형 탐사) — 관측 수신 격자(ADR-027)의 칸마다 'MMSI → 마지막으로 위치를 받은 시(에포크 시)'.
 * {@code HashMap<Integer, Integer>}(항목마다 약 50–60 B)보다 작게: 항목마다 키 · 값 int 둘, 채움 1/2 에 넓히므로 항목당 16–32 B(ADR-027 의 상한 계산).
 * 스레드 안전하지 않다 — 주인(CoverageGrid → ShipCoverage 의 잠금)만 부른다.
 */
final class IntIntMap {
    /** 없음(get · put 의 앞 값). 값은 에포크 시라 늘 0 이상이다. */
    static final int MISSING = Integer.MIN_VALUE;
    static final int INITIAL_CAPACITY = 8;
    private static final int EMPTY = -1;

    private int[] keys;
    private int[] vals;
    private int size;

    IntIntMap() { reset(INITIAL_CAPACITY); }

    private void reset(int capacity) {
        keys = new int[capacity];
        vals = new int[capacity];
        Arrays.fill(keys, EMPTY);
        size = 0;
    }

    int size() { return size; }

    /** 배열 칸 수(2의 거듭제곱) — 시험 · 메모리 셈. */
    int capacity() { return keys.length; }

    int get(int key) {
        if (key < 0) return MISSING;
        int mask = keys.length - 1;
        for (int i = mix(key) & mask; ; i = (i + 1) & mask) {
            int k = keys[i];
            if (k == key) return vals[i];
            if (k == EMPTY) return MISSING;
        }
    }

    /** @return 앞 값(없었으면 {@link #MISSING}) */
    int put(int key, int value) {
        if (key < 0) throw new IllegalArgumentException("key must be >= 0: " + key);
        int mask = keys.length - 1;
        for (int i = mix(key) & mask; ; i = (i + 1) & mask) {
            int k = keys[i];
            if (k == key) {
                int prev = vals[i];
                vals[i] = value;
                return prev;
            }
            if (k == EMPTY) {
                keys[i] = key;
                vals[i] = value;
                if (++size * 2 > keys.length) rehash(keys.length * 2);
                return MISSING;
            }
        }
    }

    /**
     * 값이 min 미만인 항목을 모두 지우고 지운 수를 돌려준다. 남은 항목으로 다시 채운다(열린 주소에서 한 칸씩 지우면 탐사 사슬이 끊긴다) —
     * 크기는 남은 수의 2배 이상인 가장 작은 2의 거듭제곱(최소 {@value #INITIAL_CAPACITY}).
     */
    int removeBelow(int min) {
        int removed = 0;
        for (int i = 0; i < keys.length; i++) if (keys[i] != EMPTY && vals[i] < min) removed++;
        if (removed == 0) return 0;
        int[] ok = keys, ov = vals;
        int left = size - removed;
        reset(capacityFor(left));
        for (int i = 0; i < ok.length; i++) if (ok[i] != EMPTY && ov[i] >= min) insertFresh(ok[i], ov[i]);
        size = left;
        return removed;
    }

    static int capacityFor(int entries) {
        int c = INITIAL_CAPACITY;
        while (c < entries * 2) c <<= 1;
        return c;
    }

    private void rehash(int capacity) {
        int[] ok = keys, ov = vals;
        int n = size;
        reset(capacity);
        for (int i = 0; i < ok.length; i++) if (ok[i] != EMPTY) insertFresh(ok[i], ov[i]);
        size = n;
    }

    /** 없는 키를 넣는다(크기는 부르는 쪽이 맞춘다). */
    private void insertFresh(int key, int value) {
        int mask = keys.length - 1;
        int i = mix(key) & mask;
        while (keys[i] != EMPTY) i = (i + 1) & mask;
        keys[i] = key;
        vals[i] = value;
    }

    /** MMSI 는 앞자리(국가 MID)가 몰려 있다 — 낮은 비트가 고르게 퍼지게 섞는다(Murmur3 마무리 단계). */
    private static int mix(int h) {
        h ^= h >>> 16;
        h *= 0x85ebca6b;
        h ^= h >>> 13;
        h *= 0xc2b2ae35;
        h ^= h >>> 16;
        return h;
    }
}
