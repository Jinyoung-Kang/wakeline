package dev.skywx.ws;

import dev.skywx.domain.AircraftState;
import dev.skywx.domain.Bbox;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * diff(prev_sent, curr, bbox) (10.6절). 세션별 '마지막으로 보낸 상태' 와 현재 뷰포트 안 상태를 비교한다.
 * remove 는 병합 스냅샷에서 사라졌거나(공급자가 더 이상 보고하지 않음) bbox 밖으로 나간 hex 뿐이다 — 나이로 지우지 않는다(계약 §1).
 */
public final class DiffCalculator {
    private DiffCalculator() {}

    /**
     * 위치·고도 등이 그대로여도 seen_at 이 이만큼 앞으로 가면 다시 보낸다. 클라이언트는 seen_at 으로 나이·stale(60 s/300 s)을 계산하므로,
     * 서 있는 항공기(주기·계류)의 seen_at 이 갱신되지 않으면 실제로는 새 보고가 오는데도 화면에서 stale 로 보인다.
     * 20 s + 스냅샷 주기(10 s) < 60 s 이므로 새 보고가 계속 오는 항공기가 stale 로 잘못 보이지 않는다.
     */
    static final long SEEN_REFRESH_S = 20;
    /** 상승률 변화 임계(ft/min) — lite 인코딩에 vrate_fpm 이 들어간다. */
    static final double VRATE_TOL_FPM = 100;

    public record Diff(List<AircraftState> upsert, List<String> remove) {
        public boolean isEmpty() { return upsert.isEmpty() && remove.isEmpty(); }
    }

    /** @param sent 세션이 마지막으로 받은 상태(갱신됨) */
    public static Diff compute(Map<String, AircraftState> sent, Iterable<AircraftState> current, Bbox bbox) {
        List<AircraftState> upsert = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (AircraftState s : current) {
            if (!bbox.contains(s.lat(), s.lon())) continue;
            seen.add(s.hex());
            AircraftState prev = sent.get(s.hex());
            if (changed(prev, s)) {
                upsert.add(s);
                sent.put(s.hex(), s);
            }
        }
        List<String> remove = new ArrayList<>();
        if (sent.size() > seen.size()) { // seen ⊆ sent(보이는 hex 는 이미 보냈거나 방금 넣었다) — 크기가 같으면 지울 것이 없다
            for (var it = sent.keySet().iterator(); it.hasNext(); ) {
                String hex = it.next();
                if (!seen.contains(hex)) { remove.add(hex); it.remove(); }
            }
        }
        return new Diff(upsert, remove);
    }

    /** 클라이언트에 보낸 값(prev)과 비교해 다시 보낼 만큼 바뀌었는가. */
    static boolean changed(AircraftState prev, AircraftState cur) {
        if (prev == null) return true;
        if (prev == cur) return false;
        if (cur.changedFrom(prev)) return true;
        if (cur.quality() != prev.quality()) return true;
        if (!Objects.equals(cur.callsign(), prev.callsign()) || !Objects.equals(cur.provider(), prev.provider())) return true;
        if (cur.vrateFpm() == null ? prev.vrateFpm() != null
                : prev.vrateFpm() == null || Math.abs(cur.vrateFpm() - prev.vrateFpm()) > VRATE_TOL_FPM) return true;
        if (cur.seenAt() == null || prev.seenAt() == null) return !Objects.equals(cur.seenAt(), prev.seenAt());
        return cur.seenAt().getEpochSecond() - prev.seenAt().getEpochSecond() >= SEEN_REFRESH_S;
    }
}
