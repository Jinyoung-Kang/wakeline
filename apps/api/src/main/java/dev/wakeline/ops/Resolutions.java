package dev.wakeline.ops;

import dev.wakeline.platform.web.Problem;

import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 활성 해결의 한 시점 모습(불변 — ResolutionService 가 5 s 이하로 캐시한다). items 는 최신 순(resolved_at, id 내림차순).
 * key 마다 유효 해결은 upto 가 가장 늦은 행(같으면 id 가 큰 행) — 가장 최근 해결을 되돌리면 앞선 해결의 범위로 돌아간다(그 사이의 발생만 다시 보인다).
 * <p>state: {@link State#OK} = DB 에서 읽은 값 · {@link State#STALE} = DB 를 읽지 못해 마지막으로 읽은 값 · {@link State#UNAVAILABLE} = 한 번도 읽지
 * 못함(아무것도 가리지 않는다). 조회 응답의 resolution_state 로 그대로 싣는다 — 가림이 조용히 바뀌지 않게.</p>
 */
public final class Resolutions {
    public enum State {
        OK, STALE, UNAVAILABLE;

        /** 응답에 싣는 글자: "ok" | "stale" | "unavailable". */
        public String label() { return name().toLowerCase(Locale.ROOT); }
    }

    private final List<Resolution> items;
    private final Map<String, Resolution> logGroups;
    private final Map<String, Resolution> providers;
    private final State state;

    private Resolutions(List<Resolution> items, Map<String, Resolution> logGroups, Map<String, Resolution> providers, State state) {
        this.items = items;
        this.logGroups = logGroups;
        this.providers = providers;
        this.state = state;
    }

    /** @param newestFirst 활성 행(최신 순) */
    public static Resolutions of(List<Resolution> newestFirst, State state) {
        Map<String, Resolution> logs = new HashMap<>(), prov = new HashMap<>();
        for (Resolution r : newestFirst) {
            Map<String, Resolution> m = Resolution.LOG_GROUP.equals(r.kind()) ? logs : Resolution.PROVIDER_ERROR.equals(r.kind()) ? prov : null;
            if (m != null) m.merge(r.key(), r, Resolutions::later);
        }
        return new Resolutions(List.copyOf(newestFirst), Map.copyOf(logs), Map.copyOf(prov), state);
    }

    /**
     * 조회 매개변수 resolved=hide(기본 — 없거나 빈 값) | show → 가리는가. 대소문자 · 앞뒤 공백은 가리지 않는다. 그 밖은 400 BAD_RESOLVED
     * (/ops/logs · /ops/logs/groups · /ops/runs 가 같은 규칙).
     */
    public static boolean hide(String resolved) {
        String v = resolved == null ? "" : resolved.strip().toLowerCase(Locale.ROOT);
        return switch (v) {
            case "", "hide" -> true;
            case "show" -> false;
            default -> throw Problem.badRequest("BAD_RESOLVED", "resolved must be hide or show");
        };
    }

    /** DB 를 한 번도 읽지 못했다: 아무것도 가리지 않는다. */
    public static Resolutions unavailable() { return of(List.of(), State.UNAVAILABLE); }

    private static Resolution later(Resolution a, Resolution b) {
        int c = a.upto().compareTo(b.upto());
        return c > 0 || (c == 0 && a.id() > b.id()) ? a : b;
    }

    Resolutions withState(State s) { return new Resolutions(items, logGroups, providers, s); }

    public List<Resolution> items() { return items; }

    public State state() { return state; }

    /** 그 지문의 유효 해결(없으면 null). */
    public Resolution logGroup(String fp) { return fp == null ? null : logGroups.get(fp); }

    /** 그 공급자의 유효 해결(없으면 null). */
    public Resolution provider(String name) { return name == null ? null : providers.get(name); }
}
