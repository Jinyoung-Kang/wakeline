package dev.wakeline.settings;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 운영 설정 retain_targets(ADR-038 · 계약 v5 §G52 · SPEC F7): 기록을 1년 남길 항공기 hex(16진 6자리) · 선박 MMSI(9자리)를 쉼표로 — 합쳐 {@link #MAX}개, 같은 값 두 번 금지.
 * 빈 문자열 = 지정 없음. hex 는 소문자로 맞춘다. 브라우저의 관심 대상(ADR-037)과는 별개다 — 서버는 그 목록을 모른다.
 */
public record RetainTargets(List<String> aircraft, List<String> ships) {
    public static final int MAX = 20;
    public static final RetainTargets NONE = new RetainTargets(List.of(), List.of());

    public boolean isEmpty() { return aircraft.isEmpty() && ships.isEmpty(); }

    /** 틀리면 IllegalArgumentException(까닭) — 설정 검사가 400 으로, 유지보수 작업은 '지정 없음'으로 본다 */
    public static RetainTargets parse(String raw) {
        if (raw == null || raw.isBlank()) return NONE;
        String[] parts = raw.split(",", -1);
        if (parts.length > MAX) throw new IllegalArgumentException("at most " + MAX + " targets");
        List<String> ac = new ArrayList<>(), ships = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (String p : parts) {
            String v = p.strip();
            if (v.matches("^[0-9A-Fa-f]{6}$")) v = v.toLowerCase(Locale.ROOT);
            else if (!v.matches("^[0-9]{9}$")) throw new IllegalArgumentException("each target must be a 6-hex aircraft address or a 9-digit MMSI: '" + v + "'");
            if (!seen.add(v)) throw new IllegalArgumentException("each target at most once: " + v);
            (v.length() == 6 ? ac : ships).add(v);
        }
        return new RetainTargets(List.copyOf(ac), List.copyOf(ships));
    }
}
