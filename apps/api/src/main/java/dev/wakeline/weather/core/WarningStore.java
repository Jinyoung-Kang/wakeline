package dev.wakeline.weather.core;

import dev.wakeline.platform.support.FetchedAtGuard;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 지금 발효 중인 기상특보 목록(ADR-036) — 수집기가 보낸 마지막 목록 전체. 바꿀 때마다 version 이 오르고(ETag), 더 새 목록만 받는다(백로그 재생이
 * 되돌리지 않게). 받은 적이 없으면 fetchedAt EPOCH · 빈 목록 — 화면은 '수신 전'으로 보인다(빈 목록과 구분).
 */
@Component
public class WarningStore {
    public record State(long version, Instant fetchedAt, String provider, List<WarningRecord> warnings, int dropped) {
        public boolean received() { return !Instant.EPOCH.equals(fetchedAt); }
    }

    private final AtomicLong version = new AtomicLong();
    private final AtomicReference<State> state = new AtomicReference<>(new State(0, Instant.EPOCH, null, List.of(), 0));

    public State state() { return state.get(); }

    /**
     * 새 목록일 때만 바꾼다({@link FetchedAtGuard}).
     * @param nowMs api 의 지금(ms)
     * @return 새 상태, 더 새 목록이 이미 있으면 null
     */
    public synchronized State replaceIfNewer(Instant fetchedAt, String provider, List<WarningRecord> warnings, int dropped, long nowMs) {
        if (!FetchedAtGuard.newer(fetchedAt, state.get().fetchedAt(), nowMs)) return null;
        State s = new State(version.incrementAndGet(), fetchedAt, provider, List.copyOf(warnings), dropped);
        state.set(s);
        return s;
    }
}
