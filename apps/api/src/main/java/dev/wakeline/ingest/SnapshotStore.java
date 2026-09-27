package dev.wakeline.ingest;

import dev.wakeline.domain.AircraftState;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 핫 상태는 메모리에(4.1절). 스코프 네 벌(계약 v2 §A3):
 * <ul>
 *   <li>region(고정 관심 지역 10 s) · global(전세계 120 s): 스코프마다 스냅샷 한 벌, fetched_at 이 더 새 것만 교체(REL-8).</li>
 *   <li>hot(뷰포트 핫 리전, 셀 키별 30 s): 셀마다 마지막 메시지 한 벌. 마지막 메시지 뒤 90 s 가 지나면 뺀다.</li>
 *   <li>focus(선택 항공기 집중 추적, hex 별 5 s): hex 마다 마지막 관측. 관측(seen_at) 뒤 60 s 가 지나거나 hex 가 focus 임대에서
 *       빠지면 뺀다(임대는 api 의 DemandService 가 쓰고 {@link #setLeases} 로 알려 준다).</li>
 * </ul>
 * 병합 뷰(DH-2): hex 마다 모든 스코프에서 seen_at 이 가장 최근인 관측을 고른다. 같으면 region > focus > hot > global.
 * 이전에는 region 이 무조건 이겨, 관심 지역 피드가 멈춘(동결된) 동안 전세계 피드의 새 관측이 가려져 항공기가 STALE 로 보이고 알림이
 * 신호 소실로 닫혔다. 전세계 기체는 자기 seen_at 이 600 s 를 넘으면 여전히 뺀다(더 이상 '현재' 가 아님, 계약 §1).
 * <p>
 * 모든 스코프 값은 불변 객체 한 벌({@link Scopes})로 묶어 참조를 CAS 로 바꾼다(락 없음). 쓰는 쪽은 스트림 소비 스레드와 수요 갱신
 * 스레드뿐이고 읽는 쪽(엔진·WS·REST)은 기다리지 않는다. 메모리 상한: hot 32 셀 · focus 256 hex(임대 상한 6·50 의 여유).
 */
@Component
public class SnapshotStore {
    /** 전세계(global) 항공기는 자기 seen_at 이 이보다 오래되면 병합 뷰에서 뺀다(더 이상 '현재' 가 아님, 계약 §1). */
    public static final long GLOBAL_MAX_AGE_S = 600;
    /** hot 셀은 마지막 메시지(fetched_at) 뒤 이 시간이 지나면 뺀다(계약 v2 §A3). */
    public static final long HOT_TTL_S = 90;
    /** focus 관측은 자기 seen_at 뒤 이 시간이 지나면 뺀다(계약 v2 §A3). */
    public static final long FOCUS_TTL_S = 60;
    /** 메모리 상한 — 임대 상한(hot 6 · focus 50)보다 넉넉하게. 넘으면 가장 오래된 것부터 뺀다. */
    static final int MAX_HOT_CELLS = 32;
    static final int MAX_FOCUS = 256;
    /** 시간 경과만으로 병합 뷰를 다시 만드는 최소 간격 — 요청·세션마다 9,000 항목 맵을 새로 만들지 않도록. */
    static final long MERGE_RECHECK_MS = 5_000;

    public static final String REGION = "region";
    public static final String GLOBAL = "global";
    public static final String HOT = "hot";
    public static final String FOCUS = "focus";

    /** focus 한 대의 최신 관측과 그것을 실어 온 메시지의 fetched_at. */
    public record FocusObs(AircraftState state, Instant fetchedAt) {
        long expiresAtMs() { return state.seenAt().toEpochMilli() + FOCUS_TTL_S * 1000; }
    }

    /**
     * 모든 스코프의 현재 값 한 벌(불변 — 바뀔 때마다 새 객체, 병합 뷰 캐시의 키). gen 은 바뀔 때마다 오른다(ETag·WS v).
     * focus/hot 의 version·fetchedAt 은 그 스코프의 마지막 메시지 값(엔진 부재 계수·피드 끊김 판단용, 단조).
     * hotLeased·focusLeased: 수요 임대 집합(아직 모르면 null — 거르지 않는다).
     */
    public record Scopes(long gen, Snapshot region, Snapshot global, Map<String, Snapshot> hot, Map<String, FocusObs> focus,
                         long hotVersion, Instant hotFetchedAt, long focusVersion, Instant focusFetchedAt,
                         Set<String> hotLeased, Set<String> focusLeased) {
        static Scopes empty() {
            return new Scopes(0, Snapshot.empty(REGION), Snapshot.empty(GLOBAL), Map.of(), Map.of(), 0, Instant.EPOCH, 0, Instant.EPOCH, null, null);
        }
    }

    private final AtomicLong version = new AtomicLong();
    private final AtomicReference<Scopes> scopes = new AtomicReference<>(Scopes.empty());

    public long nextVersion() { return version.incrementAndGet(); }
    public long version() { return version.get(); }

    public Snapshot region() { return scopes.get().region(); }
    public Snapshot global() { return scopes.get().global(); }
    /** 셀 키별 hot 스냅샷(만료된 셀이 남아 있을 수 있다 — 병합 뷰가 거른다). */
    public Map<String, Snapshot> hot() { return scopes.get().hot(); }
    /** hex 별 focus 관측(만료된 것이 남아 있을 수 있다 — 병합 뷰가 거른다). */
    public Map<String, FocusObs> focus() { return scopes.get().focus(); }

    /** region·global 스코프의 현재 스냅샷("global" 이 아니면 region). hot·focus 는 {@link #hot()}·{@link #focus()}. */
    public Snapshot current(String scope) { return GLOBAL.equals(scope) ? global() : region(); }

    /**
     * 병합 뷰: 스코프 한 벌과 그것으로 만든 불변 맵. recheckAtMs 가 지나면(가장 이른 만료 시각 — global 600 s · hot 90 s · focus 60 s,
     * 최소 5 s 간격) 스코프가 그대로여도 다시 만든다.
     */
    public record View(Scopes scopes, Map<String, AircraftState> states, long recheckAtMs) {
        public Snapshot region() { return scopes.region(); }
        public Snapshot global() { return scopes.global(); }
        /** 병합 뷰의 버전 — 스코프가 바뀔 때마다 오른다(ETag · WS v). */
        public long version() { return scopes.gen(); }

        /** 이 hex 의 병합 관측이 온 스코프(region|focus|hot|global). 병합 뷰에 없으면 null. */
        public String scopeOf(String hex) {
            String src = sourceOf(hex);
            if (src == null) return null;
            return src.startsWith(HOT + ":") ? HOT : src;
        }

        /** 세부 출처: region · global · focus · "hot:{셀 키}". 병합 뷰에 없으면 null. */
        public String sourceOf(String hex) {
            AircraftState a = hex == null ? null : states.get(hex);
            if (a == null) return null;
            if (scopes.region().states().get(hex) == a) return REGION;
            FocusObs f = scopes.focus().get(hex);
            if (f != null && f.state() == a) return FOCUS;
            for (Map.Entry<String, Snapshot> e : scopes.hot().entrySet())
                if (e.getValue().states().get(hex) == a) return HOT + ":" + e.getKey();
            return GLOBAL;
        }

        /**
         * 이 출처가 아직 이 hex 를 조회 대상으로 두는가: region·global 은 항상, focus 는 hex 가 focus 임대에 있음(임대를 아직 모르면
         * 관측이 남아 있음), hot 은 그 셀이 임대에 있고 만료 전(임대를 모르면 만료 전).
         */
        public boolean covering(String source, String hex, long nowMs) {
            if (source == null) return false;
            if (REGION.equals(source) || GLOBAL.equals(source)) return true;
            if (FOCUS.equals(source)) {
                Set<String> leased = scopes.focusLeased();
                return leased != null ? leased.contains(hex) : scopes.focus().containsKey(hex);
            }
            if (source.startsWith(HOT + ":")) {
                String cell = source.substring(HOT.length() + 1);
                Snapshot s = scopes.hot().get(cell);
                boolean alive = s != null && s.fetchedAt().toEpochMilli() + HOT_TTL_S * 1000 > nowMs;
                Set<String> leased = scopes.hotLeased();
                return alive && (leased == null || leased.contains(cell));
            }
            return false;
        }

        /** 스코프의 최신 메시지 버전(엔진 부재 계수 표식). */
        public long scopeVersion(String scope) {
            return switch (scope) {
                case REGION -> scopes.region().version();
                case GLOBAL -> scopes.global().version();
                case FOCUS -> scopes.focusVersion();
                case HOT -> scopes.hotVersion();
                default -> 0;
            };
        }

        /** 스코프의 마지막 메시지 fetched_at(없으면 EPOCH). */
        public Instant scopeFetchedAt(String scope) {
            return switch (scope) {
                case REGION -> scopes.region().fetchedAt();
                case GLOBAL -> scopes.global().fetchedAt();
                case FOCUS -> scopes.focusFetchedAt();
                case HOT -> scopes.hotFetchedAt();
                default -> Instant.EPOCH;
            };
        }
    }

    private final AtomicReference<View> merged = new AtomicReference<>(new View(Scopes.empty(), Map.of(), Long.MIN_VALUE));

    /** 모든 스코프를 신선도 우선으로 병합한 불변 맵(DH-2). */
    public Map<String, AircraftState> merged() { return view(Instant.now()).states(); }

    public Map<String, AircraftState> merged(Instant now) { return view(now).states(); }

    public Collection<AircraftState> mergedValues() { return merged().values(); }

    /** 일관된 한 벌(스코프·병합 맵). 같은 스코프·같은 만료 구간이면 캐시를 재사용한다. */
    public View view(Instant now) {
        Scopes sc = scopes.get();
        long nowMs = now.toEpochMilli();
        View m = merged.get();
        if (m.scopes() == sc && nowMs < m.recheckAtMs()) return m;
        View v = build(sc, nowMs);
        merged.set(v);
        return v;
    }

    /**
     * 병합: region → focus → hot → global 순서로 넣고, 이미 있는 hex 는 seen_at 이 더 최근일 때만 바꾼다 — 같은 seen_at 이면 먼저 넣은
     * (우선순위가 높은) 스코프가 남는다. 만료된 hot 셀·focus 관측·600 s 넘은 global 기체는 넣지 않는다.
     */
    static View build(Scopes sc, long nowMs) {
        long globalMaxAgeMs = GLOBAL_MAX_AGE_S * 1000;
        long cutoff = nowMs - globalMaxAgeMs;
        long earliestExpiry = Long.MAX_VALUE;
        Snapshot r = sc.region(), g = sc.global();
        Map<String, AircraftState> out = HashMap.newHashMap(g.states().size() + r.states().size() + 64);
        out.putAll(r.states()); // region 은 나이로 빼지 않는다(클라이언트가 stale 표시, 계약 §1)
        for (FocusObs f : sc.focus().values()) {
            long exp = f.expiresAtMs();
            if (exp <= nowMs) continue;
            earliestExpiry = Math.min(earliestExpiry, exp);
            putIfNewer(out, f.state());
        }
        for (Snapshot h : sc.hot().values()) {
            long exp = h.fetchedAt().toEpochMilli() + HOT_TTL_S * 1000;
            if (exp <= nowMs) continue;
            earliestExpiry = Math.min(earliestExpiry, exp);
            for (AircraftState a : h.states().values()) putIfNewer(out, a);
        }
        for (AircraftState a : g.states().values()) {
            long seen = a.seenAt().toEpochMilli();
            if (seen < cutoff) continue; // 자기 위치가 600 s 넘게 오래된 global 기체는 '현재' 가 아니다
            earliestExpiry = Math.min(earliestExpiry, seen + globalMaxAgeMs);
            putIfNewer(out, a);
        }
        long recheck = earliestExpiry == Long.MAX_VALUE ? Long.MAX_VALUE : Math.max(earliestExpiry, nowMs + MERGE_RECHECK_MS);
        return new View(sc, Collections.unmodifiableMap(out), recheck);
    }

    private static void putIfNewer(Map<String, AircraftState> out, AircraftState a) {
        out.merge(a.hex(), a, (cur, cand) -> cand.seenAt().isAfter(cur.seenAt()) ? cand : cur);
    }

    // ---- 쓰기(CAS) ----

    private Scopes swap(java.util.function.UnaryOperator<Scopes> f) {
        while (true) {
            Scopes cur = scopes.get();
            Scopes next = f.apply(cur);
            if (next == cur) return cur;
            if (scopes.compareAndSet(cur, next)) return next;
        }
    }

    private Scopes withRegionGlobal(Scopes c, Snapshot s) {
        boolean global = GLOBAL.equals(s.scope());
        return new Scopes(nextVersion(), global ? c.region() : s, global ? s : c.global(), c.hot(), c.focus(),
                c.hotVersion(), c.hotFetchedAt(), c.focusVersion(), c.focusFetchedAt(), c.hotLeased(), c.focusLeased());
    }

    /** region·global 교체(무조건). @return 이전 스냅샷 */
    public Snapshot replace(Snapshot s) {
        requireRegionOrGlobal(s);
        Snapshot[] prev = new Snapshot[1];
        swap(c -> {
            prev[0] = GLOBAL.equals(s.scope()) ? c.global() : c.region();
            return withRegionGlobal(c, s);
        });
        return prev[0];
    }

    /**
     * fetched_at 단조 보장 교체(REL-8): 같은 스코프의 현재 스냅샷보다 새 것일 때만 바꾼다(region·global).
     * @return 이전 스냅샷, 거부되면(백로그·중복) null
     */
    public Snapshot replaceIfNewer(Snapshot s) {
        requireRegionOrGlobal(s);
        Snapshot[] prev = new Snapshot[1];
        swap(c -> {
            Snapshot cur = GLOBAL.equals(s.scope()) ? c.global() : c.region();
            if (!s.fetchedAt().isAfter(cur.fetchedAt())) { prev[0] = null; return c; }
            prev[0] = cur;
            return withRegionGlobal(c, s);
        });
        return prev[0];
    }

    private static void requireRegionOrGlobal(Snapshot s) {
        if (!REGION.equals(s.scope()) && !GLOBAL.equals(s.scope()))
            throw new IllegalArgumentException("replace() takes region/global snapshots, got " + s.scope());
    }

    /**
     * hot 셀 교체: 그 셀의 현재 메시지보다 fetched_at 이 새 것일 때만. 같이 오래된 셀(이 메시지보다 90 s 넘게 오래된)을 걷어내고
     * 셀 수 상한을 지킨다. 임대에서 빠진 셀이어도 받는다(관측은 관측이다 — 90 s 뒤 스스로 빠진다).
     * @return 그 셀의 이전 스냅샷(없었으면 빈 스냅샷), 거부되면 null
     */
    public Snapshot replaceHotIfNewer(String cell, Snapshot s) {
        if (!HOT.equals(s.scope())) throw new IllegalArgumentException("hot snapshot expected");
        Snapshot[] prev = new Snapshot[1];
        swap(c -> {
            Snapshot cur = c.hot().get(cell);
            if (cur != null && !s.fetchedAt().isAfter(cur.fetchedAt())) { prev[0] = null; return c; }
            prev[0] = cur != null ? cur : Snapshot.empty(HOT);
            long horizon = s.fetchedAt().toEpochMilli() - HOT_TTL_S * 1000;
            Map<String, Snapshot> hot = new HashMap<>();
            for (var e : c.hot().entrySet()) if (e.getValue().fetchedAt().toEpochMilli() > horizon) hot.put(e.getKey(), e.getValue());
            hot.put(cell, s);
            while (hot.size() > MAX_HOT_CELLS) hot.remove(oldestKey(hot, x -> x.fetchedAt().toEpochMilli()));
            Instant hotAt = s.fetchedAt().isAfter(c.hotFetchedAt()) ? s.fetchedAt() : c.hotFetchedAt();
            return new Scopes(nextVersion(), c.region(), c.global(), Map.copyOf(hot), c.focus(),
                    Math.max(c.hotVersion(), s.version()), hotAt, c.focusVersion(), c.focusFetchedAt(), c.hotLeased(), c.focusLeased());
        });
        return prev[0];
    }

    /**
     * focus 메시지 반영. hex 마다: focus 임대에 있고(임대를 아직 모르면 통과), 그 hex 의 현재 관측보다 fetched_at 이 새롭고 seen_at 이
     * 오래되지 않았을 때만 바꾼다(묶음 요청이 여러 메시지로 나뉘어 와도 hex 별로 판단). 받은 것이 하나도 없으면 null.
     * @return 받아들인 hex 들의 이전 관측(없었으면 빠짐)을 담은 스냅샷(scope focus) — 팬아웃 범위 계산용, 없으면 null
     */
    public Snapshot applyFocus(Snapshot s) {
        if (!FOCUS.equals(s.scope())) throw new IllegalArgumentException("focus snapshot expected");
        Snapshot[] prev = new Snapshot[1];
        swap(c -> {
            Set<String> leased = c.focusLeased();
            Map<String, FocusObs> focus = null;
            Map<String, AircraftState> before = new HashMap<>();
            for (AircraftState a : s.states().values()) {
                if (leased != null && !leased.contains(a.hex())) continue;
                FocusObs cur = c.focus().get(a.hex());
                if (cur != null && (!s.fetchedAt().isAfter(cur.fetchedAt()) || a.seenAt().isBefore(cur.state().seenAt()))) continue;
                if (focus == null) focus = new HashMap<>(c.focus());
                focus.put(a.hex(), new FocusObs(a, s.fetchedAt()));
                if (cur != null) before.put(a.hex(), cur.state());
            }
            if (focus == null) { prev[0] = null; return c; }
            long horizon = s.fetchedAt().toEpochMilli();
            focus.values().removeIf(f -> f.expiresAtMs() <= horizon); // 이 메시지 시각 기준으로 이미 만료된 관측(메모리 상한)
            while (focus.size() > MAX_FOCUS) focus.remove(oldestKey(focus, f -> f.state().seenAt().toEpochMilli()));
            prev[0] = new Snapshot(c.focusVersion(), FOCUS, s.provider(), c.focusFetchedAt(), c.focusFetchedAt(), "-", Map.copyOf(before));
            Instant focusAt = s.fetchedAt().isAfter(c.focusFetchedAt()) ? s.fetchedAt() : c.focusFetchedAt();
            return new Scopes(nextVersion(), c.region(), c.global(), c.hot(), Map.copyOf(focus), c.hotVersion(), c.hotFetchedAt(),
                    Math.max(c.focusVersion(), s.version()), focusAt, c.hotLeased(), c.focusLeased());
        });
        return prev[0];
    }

    /**
     * 수요 임대 집합(DemandService 가 임대를 쓸 때마다). focus 임대에서 빠진 hex 의 관측은 바로 뺀다(계약 v2 §A3).
     * hot 셀은 빼지 않는다(마지막 메시지 뒤 90 s 에 스스로 빠진다) — 집합은 '아직 조회 중인가' 판단에만 쓴다.
     * @return focus 관측을 하나라도 뺐으면 true(병합 뷰가 바뀌었다)
     */
    public boolean setLeases(Set<String> hotCells, Set<String> focusHexes) {
        Set<String> hot = Set.copyOf(hotCells), foc = Set.copyOf(focusHexes);
        boolean[] removed = new boolean[1];
        swap(c -> {
            Map<String, FocusObs> focus = c.focus();
            boolean drop = false;
            for (String h : focus.keySet()) if (!foc.contains(h)) { drop = true; break; }
            removed[0] = drop;
            if (!drop && hot.equals(c.hotLeased()) && foc.equals(c.focusLeased())) return c;
            if (drop) {
                Map<String, FocusObs> kept = new HashMap<>(focus);
                kept.keySet().retainAll(foc);
                focus = Map.copyOf(kept);
            }
            return new Scopes(drop ? nextVersion() : c.gen(), c.region(), c.global(), c.hot(), focus,
                    c.hotVersion(), c.hotFetchedAt(), c.focusVersion(), c.focusFetchedAt(), hot, foc);
        });
        return removed[0];
    }

    private static <V> String oldestKey(Map<String, V> m, java.util.function.ToLongFunction<V> t) {
        String k = null;
        long best = Long.MAX_VALUE;
        for (var e : m.entrySet()) {
            long v = t.applyAsLong(e.getValue());
            if (k == null || v < best) { k = e.getKey(); best = v; }
        }
        return k;
    }

    /** hex 로 현재 상태(병합 뷰와 같은 규칙 — 신선도 우선, 600 s 넘은 global 기체는 없음). */
    public AircraftState find(String hex) {
        return hex == null ? null : merged().get(hex);
    }
}
