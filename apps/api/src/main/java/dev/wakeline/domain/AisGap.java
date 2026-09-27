package dev.wakeline.domain;

import java.time.Instant;

/**
 * AIS 수신 공백(ADR-014): 받던 데이터가 끊겼다가 다시 이어진 구간. aisstream 은 재전송이 없어 메울 수 없다 — 기록해 보여 줄 뿐이다.
 * startedAt = 끊기기 전 마지막 메시지 시각, endedAt = 다시 구독한 연결의 첫 메시지 시각(열린 공백이면 null), provider = aisstream | fixture.
 */
public record AisGap(Instant startedAt, Instant endedAt, String reason, String provider) {

    /** [from, to] 와 겹치는 시간(ms). 열린 공백은 to 까지로 본다. */
    public long overlapMs(long fromMs, long toMs) {
        long s = Math.max(fromMs, startedAt.toEpochMilli());
        long e = Math.min(toMs, endedAt == null ? toMs : endedAt.toEpochMilli());
        return Math.max(0, e - s);
    }

    /** (a, b) 사이에 이 공백이 걸쳐 있는가(두 관측 사이에 수신이 끊겼는가). */
    public boolean between(Instant a, Instant b) {
        return startedAt.isBefore(b) && (endedAt == null || endedAt.isAfter(a));
    }
}
