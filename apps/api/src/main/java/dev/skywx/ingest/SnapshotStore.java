package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;
import org.springframework.stereotype.Component;

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

    public Snapshot replace(Snapshot s) {
        return "global".equals(s.scope()) ? global.getAndSet(s) : region.getAndSet(s);
    }

    /** hex 로 현재 상태(관심 지역 우선). */
    public AircraftState find(String hex) {
        AircraftState a = region.get().states().get(hex);
        return a != null ? a : global.get().states().get(hex);
    }
}
