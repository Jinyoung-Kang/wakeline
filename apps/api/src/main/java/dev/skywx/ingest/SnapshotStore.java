package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** 핫 상태는 메모리에(4.1절). region 10 s · global 120 s 스냅샷 2벌. 이전 스냅샷은 diff 계산용으로 1벌 유지. */
@Component
public class SnapshotStore {
    /** 전세계(global) 항공기는 자기 seen_at 이 이보다 오래되면 병합 뷰에서 뺀다(더 이상 '현재' 가 아님, 계약 §1). */
    public static final long GLOBAL_MAX_AGE_S = 600;
    /** 시간 경과만으로 병합 뷰를 다시 만드는 최소 간격 — 요청·세션마다 9,000 항목 맵을 새로 만들지 않도록. */
    static final long MERGE_RECHECK_MS = 5_000;

    private final AtomicLong version = new AtomicLong();
    private final AtomicReference<Snapshot> region = new AtomicReference<>(Snapshot.empty("region"));
    private final AtomicReference<Snapshot> global = new AtomicReference<>(Snapshot.empty("global"));

    public long nextVersion() { return version.incrementAndGet(); }
    public long version() { return version.get(); }

    public Snapshot region() { return region.get(); }
    public Snapshot global() { return global.get(); }

    /** scope 문자열로 현재 스냅샷("global" 이 아니면 region — replace 와 같은 규칙). */
    public Snapshot current(String scope) { return "global".equals(scope) ? global.get() : region.get(); }

    /**
     * 병합 뷰: 두 스냅샷과 그것으로 만든 불변 맵. recheckAtMs 가 지나면(가장 이른 global 만료 시각, 최소 5 s 간격)
     * 스냅샷이 그대로여도 다시 만들어 600 s 넘은 global 기체를 뺀다.
     */
    public record View(Snapshot region, Snapshot global, Map<String, AircraftState> states, long recheckAtMs) {}

    private final AtomicReference<View> merged =
            new AtomicReference<>(new View(Snapshot.empty("region"), Snapshot.empty("global"), Map.of(), Long.MIN_VALUE));

    /** 전세계 스냅샷 위에 관심 지역 스냅샷을 덮어쓴 불변 맵(관심 지역이 더 자주·정확하게 갱신되므로 우선). */
    public Map<String, AircraftState> merged() { return view(Instant.now()).states(); }

    public Map<String, AircraftState> merged(Instant now) { return view(now).states(); }

    public Collection<AircraftState> mergedValues() { return merged().values(); }

    /** 일관된 한 벌(region·global·병합 맵). 같은 스냅샷·같은 만료 구간이면 캐시를 재사용한다. */
    public View view(Instant now) {
        Snapshot r = region.get(), g = global.get();
        long nowMs = now.toEpochMilli();
        View m = merged.get();
        if (m.region() == r && m.global() == g && nowMs < m.recheckAtMs()) return m;
        View v = build(r, g, nowMs);
        merged.set(v);
        return v;
    }

    static View build(Snapshot r, Snapshot g, long nowMs) {
        long maxAgeMs = GLOBAL_MAX_AGE_S * 1000;
        long cutoff = nowMs - maxAgeMs;
        long earliestExpiry = Long.MAX_VALUE;
        Map<String, AircraftState> out = new LinkedHashMap<>(g.states().size() + r.states().size());
        for (AircraftState a : g.states().values()) {
            long seen = a.seenAt().toEpochMilli();
            if (seen < cutoff) continue; // 자기 위치가 600 s 넘게 오래된 global 기체는 '현재' 가 아니다
            out.put(a.hex(), a);
            earliestExpiry = Math.min(earliestExpiry, seen + maxAgeMs);
        }
        out.putAll(r.states());
        long recheck = earliestExpiry == Long.MAX_VALUE ? Long.MAX_VALUE : Math.max(earliestExpiry, nowMs + MERGE_RECHECK_MS);
        return new View(r, g, Collections.unmodifiableMap(out), recheck);
    }

    public Snapshot replace(Snapshot s) {
        return "global".equals(s.scope()) ? global.getAndSet(s) : region.getAndSet(s);
    }

    /**
     * fetched_at 단조 보장 교체(REL-8): 같은 스코프의 현재 스냅샷보다 새 것일 때만 바꾼다.
     * @return 이전 스냅샷, 거부되면(백로그·중복) null
     */
    public Snapshot replaceIfNewer(Snapshot s) {
        AtomicReference<Snapshot> ref = "global".equals(s.scope()) ? global : region;
        while (true) {
            Snapshot cur = ref.get();
            if (!s.fetchedAt().isAfter(cur.fetchedAt())) return null;
            if (ref.compareAndSet(cur, s)) return cur;
        }
    }

    /** hex 로 현재 상태(관심 지역 우선, 병합 뷰와 같은 규칙 — 600 s 넘은 global 기체는 없음). */
    public AircraftState find(String hex) {
        return hex == null ? null : merged().get(hex);
    }
}
