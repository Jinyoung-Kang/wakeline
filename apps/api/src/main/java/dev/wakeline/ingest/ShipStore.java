package dev.wakeline.ingest;

import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.ShipCategory;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * 선박 실시간 상태(메모리, ADR-014 · 계약 v2 §B3). MMSI → 최신 위치(ShipState) + 정적 정보(ShipStatic).
 * <ul>
 *   <li>쓰는 쪽은 스트림 소비 스레드(apply·addGap)와 만료 점검(expire)뿐이고 잠금 하나로 직렬화한다. 읽는 쪽(WS·REST)은 불변 {@link View}
 *       참조만 읽고 기다리지 않는다(쓰기마다 새 맵 — copy-on-write, O(선박 수) · 10 s 에 한 번 정도).</li>
 *   <li>MMSI 별 단조: seen_at 이 더 새 보고만 바꾼다(재전달·백로그·부트스트랩이 순서 없이 와도 최신을 되돌리지 않는다). 정적 정보도
 *       updated_at 이 더 오래된 것은 무시한다.</li>
 *   <li>만료: 수신이 정상인 시간으로 30분 동안 보고가 없으면 뺀다. 수신이 끊긴 동안(열린 공백·수집기 상태 없음·소비 멈춤)은 빼지 않고 그대로
 *       둔다(얼려 두고 화면이 오래됨으로 표시). 끝난 공백과 겹친 시간은 '보고 없음' 으로 세지 않는다 — 공백이 끝난 직후 아직 다시 보고하지 않은
 *       선박이 한꺼번에 사라졌다 나타나지 않게.</li>
 *   <li>상한: 선박 {@value #MAX_SHIPS} · 정적 정보 {@value #MAX_STATICS}. 넘으면 새 MMSI 를 받지 않고 센다(기존 선박 갱신은 계속). 공백 기록은
 *       최근 48 h · {@value #MAX_GAPS} 건.</li>
 * </ul>
 */
@Component
public class ShipStore {
    /** 수신이 정상인 시간으로 이만큼 보고가 없으면 실시간 목록에서 뺀다(계약 v2 §B3). */
    public static final long LIVE_MAX_AGE_MS = 30 * 60_000L;
    /** 메모리 상한 — 전세계 구독 실측(70 s 에 6,093 척, ADR-014)의 30분 누적을 넉넉히 덮는다. */
    public static final int MAX_SHIPS = 60_000;
    static final int MAX_STATICS = 100_000;
    /** 위치가 없는(또는 빠진) 선박의 정적 정보를 받은 뒤 들고 있는 시간 — 수집기는 같은 내용을 30분마다 다시 보낸다. */
    static final long STATIC_KEEP_MS = 60 * 60_000L;
    static final int MAX_GAPS = 256;
    static final long GAP_KEEP_MS = 48 * 3600_000L;
    /** seen_at 이 지금보다 이만큼 넘게 미래면 받지 않는다(수집기 품질 게이트가 먼저 거르지만 한 번 더). */
    static final long FUTURE_SKEW_MS = 5 * 60_000L;

    /** 실시간 선박 하나: 최신 위치 + 알고 있는 정적 정보(없으면 null). */
    public record Ship(ShipState state, ShipStatic stat) {
        public String mmsi() { return state.mmsi(); }
        /** 선종 코드의 결정적 분류(코드가 없으면 unknown — {@link ShipCategory}). */
        public ShipCategory category() { return ShipCategory.of(stat == null ? null : stat.shipType()); }
    }

    /** 쓰기 한 번의 결과: 바뀐 MMSI · 뺀 MMSI · 상한·미래 시각으로 받지 않은 수. */
    public record Change(Set<String> changed, Set<String> removed, int rejectedCap, int rejectedFuture) {
        static final Change NONE = new Change(Set.of(), Set.of(), 0, 0);
        public boolean isEmpty() { return changed.isEmpty() && removed.isEmpty(); }
    }

    private record StaticEntry(ShipStatic stat, long receivedAtMs) {}

    /**
     * 불변 상태 한 벌. version 은 선박 목록이 바뀔 때만 오른다(격자·JSON 캐시의 키). fetchedAt·provider = 마지막으로 반영한 ships 메시지의
     * 봉투 값, newestSeenAt = 가장 최근 보고의 seen_at, appliedAtMs = api 가 마지막으로 ships 메시지를 반영한 시각(소비가 멈췄는지 판단).
     * bbox 조회용 1° 버킷 색인은 처음 필요할 때 한 번 만든다(O(선박 수)).
     */
    public static final class View {
        static final View EMPTY = new View(0, Map.of(), null, null, null, 0);
        private final long version;
        private final Map<String, Ship> ships;
        private final Instant fetchedAt;
        private final String provider;
        private final Instant newestSeenAt;
        private final long appliedAtMs;
        private volatile Map<Integer, List<Ship>> index;

        View(long version, Map<String, Ship> ships, Instant fetchedAt, String provider, Instant newestSeenAt, long appliedAtMs) {
            this.version = version;
            this.ships = ships;
            this.fetchedAt = fetchedAt;
            this.provider = provider;
            this.newestSeenAt = newestSeenAt;
            this.appliedAtMs = appliedAtMs;
        }

        public long version() { return version; }
        public Map<String, Ship> ships() { return ships; }
        public Instant fetchedAt() { return fetchedAt; }
        public String provider() { return provider; }
        public Instant newestSeenAt() { return newestSeenAt; }
        public long appliedAtMs() { return appliedAtMs; }
        public int size() { return ships.size(); }
        public Ship get(String mmsi) { return ships.get(mmsi); }

        static int bucket(double lat, double lon) {
            int row = (int) Math.floor(lat) + 90, col = (int) Math.floor(lon) + 180;
            return row * 361 + col;
        }

        private Map<Integer, List<Ship>> index() {
            Map<Integer, List<Ship>> ix = index;
            if (ix == null) { // 경쟁해도 같은 결과(불변 입력) — 잠금 없이
                Map<Integer, List<Ship>> m = new HashMap<>();
                for (Ship s : ships.values()) m.computeIfAbsent(bucket(s.state().lat(), s.state().lon()), k -> new ArrayList<>()).add(s);
                index = ix = m;
            }
            return ix;
        }

        /** bbox 안(경계 포함)의 선박을 차례로 넘긴다 — 겹치는 1° 버킷만 본다. */
        public void forEachIn(Bbox b, Consumer<Ship> c) {
            Map<Integer, List<Ship>> ix = index();
            int r0 = (int) Math.floor(b.lamin()) + 90, r1 = (int) Math.floor(b.lamax()) + 90;
            int c0 = (int) Math.floor(b.lomin()) + 180, c1 = (int) Math.floor(b.lomax()) + 180;
            long cells = (long) (r1 - r0 + 1) * (c1 - c0 + 1);
            if (cells > ix.size()) { // 넓은 bbox — 빈 칸을 헤아리지 않고 차 있는 버킷만
                for (var e : ix.entrySet()) {
                    int row = e.getKey() / 361, col = e.getKey() % 361;
                    if (row < r0 || row > r1 || col < c0 || col > c1) continue;
                    for (Ship s : e.getValue()) if (b.contains(s.state().lat(), s.state().lon())) c.accept(s);
                }
                return;
            }
            for (int r = r0; r <= r1; r++) for (int col = c0; col <= c1; col++) {
                List<Ship> l = ix.get(r * 361 + col);
                if (l != null) for (Ship s : l) if (b.contains(s.state().lat(), s.state().lon())) c.accept(s);
            }
        }

        /** bbox 안 선박 수(limit 에 닿으면 거기서 멈춘다). */
        public int countIn(Bbox b, int limit) {
            int[] n = {0};
            try {
                forEachIn(b, s -> { if (++n[0] >= limit) throw Stop.INSTANCE; });
            } catch (Stop stop) {
                return limit;
            }
            return n[0];
        }

        private static final class Stop extends RuntimeException {
            static final Stop INSTANCE = new Stop();
            private Stop() { super(null, null, false, false); }
        }
    }

    private final int maxShips;
    private final int maxStatics;
    private final Object lock = new Object();
    private volatile View view = View.EMPTY;
    private final ConcurrentHashMap<String, StaticEntry> statics = new ConcurrentHashMap<>();
    /** 끝난 공백(started_at 순). lock 안에서만 바꾸고 불변 사본을 읽게 한다. */
    private final List<AisGap> gaps = new ArrayList<>();
    private volatile List<AisGap> gapsView = List.of();

    public ShipStore() { this(MAX_SHIPS, MAX_STATICS); }

    /** 테스트용: 작은 상한. */
    ShipStore(int maxShips, int maxStatics) {
        this.maxShips = maxShips;
        this.maxStatics = maxStatics;
    }

    public View view() { return view; }

    /** 알고 있는 정적 정보(실시간 목록에 없는 선박 포함, 받은 지 60분 안). */
    public ShipStatic staticOf(String mmsi) {
        StaticEntry e = statics.get(mmsi);
        return e == null ? null : e.stat();
    }

    public int staticCount() { return statics.size(); }

    /** 메모리에 있는 끝난 공백(오래된 것부터). */
    public List<AisGap> gaps() { return gapsView; }

    /** 가장 최근에 끝난 공백(없으면 null). */
    public AisGap lastGap() {
        List<AisGap> g = gapsView;
        AisGap best = null;
        for (AisGap x : g) if (best == null || x.endedAt().isAfter(best.endedAt())) best = x;
        return best;
    }

    /**
     * ships 메시지 하나를 반영한다(스트림 소비 스레드·부트스트랩). 정적 정보 먼저(같은 메시지의 위치가 새 선박을 만들 때 붙도록), 그다음 위치.
     * @param nowMs 지금(ms) — 미래 시각 검사·정적 정보 보관 기준
     */
    public Change apply(Collection<ShipState> states, Collection<ShipStatic> stats, Instant fetchedAt, String provider, long nowMs) {
        Set<String> changed = new HashSet<>();
        int cap = 0, future = 0;
        synchronized (lock) {
            View cur = view;
            HashMap<String, Ship> next = null;
            for (ShipStatic st : stats) {
                StaticEntry prev = statics.get(st.mmsi());
                if (prev != null && prev.stat().updatedAt().isAfter(st.updatedAt())) continue; // 더 오래된 내용 — 최신을 되돌리지 않는다
                if (prev == null && statics.size() >= maxStatics) { cap++; continue; }
                statics.put(st.mmsi(), new StaticEntry(st, nowMs));
                Ship live = (next == null ? cur.ships : next).get(st.mmsi());
                if (live != null && !st.equals(live.stat())) {
                    if (next == null) next = new HashMap<>(cur.ships);
                    next.put(st.mmsi(), new Ship(live.state(), st));
                    changed.add(st.mmsi());
                }
            }
            Instant newest = cur.newestSeenAt;
            for (ShipState s : states) {
                if (s.seenAt().toEpochMilli() > nowMs + FUTURE_SKEW_MS) { future++; continue; }
                Map<String, Ship> m = next == null ? cur.ships : next;
                Ship live = m.get(s.mmsi());
                if (live != null && !s.seenAt().isAfter(live.state().seenAt())) continue; // 같거나 오래된 보고(재전달·백로그)
                if (live == null && m.size() >= maxShips) { cap++; continue; }
                if (next == null) next = new HashMap<>(cur.ships);
                StaticEntry se = statics.get(s.mmsi());
                next.put(s.mmsi(), new Ship(s, se == null ? null : se.stat()));
                changed.add(s.mmsi());
                if (newest == null || s.seenAt().isAfter(newest)) newest = s.seenAt();
            }
            Instant fa = fetchedAt != null && (cur.fetchedAt == null || fetchedAt.isAfter(cur.fetchedAt)) ? fetchedAt : cur.fetchedAt;
            String pv = fa == fetchedAt && provider != null ? provider : cur.provider;
            view = new View(next == null ? cur.version : cur.version + 1, next == null ? cur.ships : Collections.unmodifiableMap(next),
                    fa, pv, newest, nowMs);
        }
        return new Change(changed, Set.of(), cap, future);
    }

    /** 끝난 공백 하나를 기억한다(같은 시작 시각이면 무시). @return 새로 넣었으면 true */
    public boolean addGap(AisGap g) {
        if (g == null || g.endedAt() == null) return false;
        synchronized (lock) {
            for (AisGap x : gaps) if (x.startedAt().equals(g.startedAt())) return false;
            gaps.add(g);
            gaps.sort(Comparator.comparing(AisGap::startedAt));
            while (gaps.size() > MAX_GAPS) gaps.removeFirst();
            gapsView = List.copyOf(gaps);
            return true;
        }
    }

    /**
     * 만료 점검. inputDown(수신이 끊겼거나 확인할 수 없음)이면 선박을 빼지 않는다(얼림). 아니면 '수신이 정상이던 시간' 으로 30분 넘게 보고가
     * 없는 선박을 뺀다 — 보고 뒤 경과에서 끝난 공백과 겹친 시간을 뺀다. 오래된 공백·주인 없는 정적 정보도 여기서 정리한다.
     */
    public Change expire(long nowMs, boolean inputDown) {
        synchronized (lock) {
            if (gaps.removeIf(g -> nowMs - g.endedAt().toEpochMilli() > GAP_KEEP_MS)) gapsView = List.copyOf(gaps);
            View cur = view;
            statics.entrySet().removeIf(e -> !cur.ships.containsKey(e.getKey()) && nowMs - e.getValue().receivedAtMs() > STATIC_KEEP_MS);
            if (inputDown) return Change.NONE;
            List<AisGap> gs = gapsView;
            Set<String> removed = new HashSet<>();
            for (Ship s : cur.ships.values()) {
                long seen = s.state().seenAt().toEpochMilli();
                long age = nowMs - seen;
                if (age <= LIVE_MAX_AGE_MS) continue;
                long down = 0;
                for (AisGap g : gs) down += g.overlapMs(seen, nowMs);
                if (age - down > LIVE_MAX_AGE_MS) removed.add(s.mmsi());
            }
            if (removed.isEmpty()) return Change.NONE;
            HashMap<String, Ship> next = new HashMap<>(cur.ships);
            next.keySet().removeAll(removed);
            view = new View(cur.version + 1, Collections.unmodifiableMap(next), cur.fetchedAt, cur.provider, cur.newestSeenAt, cur.appliedAtMs);
            return new Change(Set.of(), removed, 0, 0);
        }
    }
}
