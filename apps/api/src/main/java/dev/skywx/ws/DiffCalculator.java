package dev.skywx.ws;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Bbox;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** diff(prev_sent, curr, bbox) (10.6절). 세션별 '마지막으로 보낸 상태' 와 현재 뷰포트 안 상태를 비교한다. */
public final class DiffCalculator {
    private DiffCalculator() {}

    public record Diff(List<AircraftState> upsert, List<String> remove) {
        public boolean isEmpty() { return upsert.isEmpty() && remove.isEmpty(); }
    }

    /** @param sent 세션이 마지막으로 받은 상태(갱신됨) */
    public static Diff compute(Map<String, AircraftState> sent, Iterable<AircraftState> current, Bbox bbox) {
        List<AircraftState> upsert = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (AircraftState s : current) {
            if (!bbox.contains(s.lat(), s.lon())) continue;
            seen.add(s.hex());
            AircraftState prev = sent.get(s.hex());
            if (prev == null || s.changedFrom(prev)) {
                upsert.add(s);
                sent.put(s.hex(), s);
            }
        }
        List<String> remove = new ArrayList<>();
        for (String hex : List.copyOf(sent.keySet())) {
            if (!seen.contains(hex)) { remove.add(hex); sent.remove(hex); }
        }
        return new Diff(upsert, remove);
    }
}
