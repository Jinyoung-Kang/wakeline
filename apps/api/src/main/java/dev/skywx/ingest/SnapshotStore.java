package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** 핫 상태는 메모리에(4.1절). region 10 s · global 120 s 스냅샷 2벌. 이전 스냅샷은 diff 계산용으로 1벌 유지. */
@Component
public class SnapshotStore {
    private final AtomicLong version = new AtomicLong();
    private final AtomicReference<Snapshot> region = new AtomicReference<>(Snapshot.empty("region"));
    private final AtomicReference<Snapshot> global = new AtomicReference<>(Snapshot.empty("global"));

    public long nextVersion() { return version.incrementAndGet(); }
    public long version() { return version.get(); }

    public Snapshot region() { return region.get(); }
    public Snapshot global() { return global.get(); }

    /** 병합 뷰 캐시: (region.version, global.version) 이 같으면 재사용. 세션·요청마다 7,000+ 항목 맵을 새로 만들지 않는다. */
    private record Merged(long regionV, long globalV, Map<String, AircraftState> states) {}
    private final AtomicReference<Merged> merged = new AtomicReference<>(new Merged(-1, -1, Map.of()));

    /** 전세계 스냅샷 위에 관심 지역 스냅샷을 덮어쓴 불변 맵(관심 지역이 더 자주·정확하게 갱신되므로 우선). */
    public Map<String, AircraftState> merged() {
        Snapshot r = region.get(), g = global.get();
        Merged m = merged.get();
        if (m.regionV == r.version() && m.globalV == g.version()) return m.states;
        Map<String, AircraftState> out = new LinkedHashMap<>(g.states().size() + r.states().size());
        out.putAll(g.states());
        out.putAll(r.states());
        Map<String, AircraftState> frozen = java.util.Collections.unmodifiableMap(out);
        merged.set(new Merged(r.version(), g.version(), frozen));
        return frozen;
    }

    public Collection<AircraftState> mergedValues() { return merged().values(); }

    public Snapshot replace(Snapshot s) {
        return "global".equals(s.scope()) ? global.getAndSet(s) : region.getAndSet(s);
    }

    /** hex 로 현재 상태(관심 지역 우선). */
    public AircraftState find(String hex) {
        AircraftState a = region.get().states().get(hex);
        return a != null ? a : global.get().states().get(hex);
    }
}
