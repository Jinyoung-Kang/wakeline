package dev.wakeline.ships.core;

import java.time.Instant;

/**
 * AIS 수신 공백(ADR-014): 받던 데이터가 끊겼다가 다시 이어진 구간. aisstream 은 재전송이 없어 메울 수 없다 — 기록해 보여 줄 뿐이다.
 * startedAt = 끊기기 전 마지막 메시지 시각, endedAt = 다시 구독한 연결의 첫 메시지 시각(열린 공백이면 null), provider = aisstream | fixture.
 * scope = 공백이 난 구역(계약 v4 §D). null = 구역 나누기 전 기록이거나 모름 — 모든 곳에 적용한다.
 */
public record AisGap(Instant startedAt, Instant endedAt, String reason, String provider, AisScope scope) {

    /** 구역 없는 공백(옛 기록·구역 나누기 전 수집기). */
    public AisGap(Instant startedAt, Instant endedAt, String reason, String provider) {
        this(startedAt, endedAt, reason, provider, null);
    }

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

    /** 이 위치에 적용되는가 — scope 가 없으면 모든 곳, 있으면 그 구역 상자 안만. */
    public boolean appliesAt(double lat, double lon) { return scope == null || scope.contains(lat, lon); }

    /** 구역 문자열(없으면 null). */
    public String scopeText() { return scope == null ? null : scope.text(); }
}
