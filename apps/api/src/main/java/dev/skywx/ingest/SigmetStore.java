package dev.skywx.ingest;

import dev.skywx.domain.SigmetRecord;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 최근 수신한 SIGMET 전체(만료분 포함 — 조회 시 필터). 갱신마다 version 증가.
 * 쓰기(교체·재발행)는 직렬화해 version 이 뒤로 가지 않게 한다. 읽기는 락 없음.
 */
@Component
public class SigmetStore {
    public record State(long version, Instant fetchedAt, Instant receivedAt, String provider, Map<String, SigmetRecord> byId) {}

    private final AtomicLong version = new AtomicLong();
    private final AtomicReference<State> state = new AtomicReference<>(new State(0, Instant.EPOCH, Instant.EPOCH, "-", Map.of()));

    public State state() { return state.get(); }

    public synchronized State replace(Instant fetchedAt, String provider, Map<String, SigmetRecord> byId) {
        State s = new State(version.incrementAndGet(), fetchedAt, Instant.now(), provider, byId);
        state.set(s);
        return s;
    }

    /** fetched_at 단조 보장: 현재보다 새 목록일 때만 교체한다(백로그 재생이 되돌리지 않게). @return 새 상태, 거부되면 null */
    public synchronized State replaceIfNewer(Instant fetchedAt, String provider, Map<String, SigmetRecord> byId) {
        if (!fetchedAt.isAfter(state.get().fetchedAt())) return null;
        return replace(fetchedAt, provider, byId);
    }

    /** 내용은 그대로, version 만 올린다 — 만료로 활성 집합이 바뀌었을 때 ETag·WS 재전송 기준을 바꾸기 위해. */
    public synchronized State republish() {
        State c = state.get();
        State s = new State(version.incrementAndGet(), c.fetchedAt(), c.receivedAt(), c.provider(), c.byId());
        state.set(s);
        return s;
    }

    public List<SigmetRecord> activeAt(Instant t) {
        return state.get().byId().values().stream().filter(s -> s.validAt(t)).toList();
    }

    public SigmetRecord get(String id) { return state.get().byId().get(id); }
}
