package dev.wakeline.domain;

import dev.wakeline.domain.DestinationInfo.Place;

import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AIS 목적지 풀이(계약 v4 §B) — 결정적 규칙만 쓴다(추정하지 않는다).
 * <ol>
 *   <li>정규화: 대문자 · 앞뒤 공백 제거 · 연속 공백 하나로.</li>
 *   <li>구분: {@code A<=>B} · {@code A<>B} → between, {@code A>B} → from_to, 앞에만 {@code >} 가 있는 {@code >B} → to, 그 밖 → text.
 *       구분자가 두 번 이상이거나 조각이 비었거나 다른 꺾쇠가 섞이면 text(어느 쪽인지 규칙으로 정할 수 없다).</li>
 *   <li>조각의 UN/LOCODE: 공백형 {@code "KR PUS"}(뒤에 선석 등 문구 허용) 또는 붙임형 {@code "KRPUS"}(정확히 5자). 항구·내륙항 표에 있는
 *       코드만 푼다. 붙임형이 같은 글자의 지명과도 같으면 ambiguous.</li>
 * </ol>
 */
public final class DestinationParser {
    static final Pattern SPACED = Pattern.compile("^([A-Z]{2}) ([A-Z0-9]{3})(?: .*)?$");
    static final Pattern COMPACT = Pattern.compile("^([A-Z]{2})([A-Z0-9]{3})$");
    private static final Pattern SPACES = Pattern.compile("\\s+");

    private final UnlocodePorts ports;

    public DestinationParser(UnlocodePorts ports) { this.ports = ports; }

    private static final class Holder {
        static final DestinationParser BUNDLED = new DestinationParser(UnlocodePorts.bundled());
    }

    /** 앱에 실린 항구 표를 쓰는 풀이기(JVM 에서 한 번 만든다). */
    public static DestinationParser bundled() { return Holder.BUNDLED; }

    /** 보고된 목적지 → 풀이. 없거나 공백뿐이면 null(모름). */
    public DestinationInfo parse(String raw) {
        if (raw == null) return null;
        String n = normalize(raw);
        if (n.isEmpty()) return null;
        String[] between = split(n, "<=>");
        if (between == null && !n.contains("<=>")) between = split(n, "<>");
        if (between != null) return new DestinationInfo(raw, DestinationInfo.BETWEEN, null, null, List.of(place(between[0]), place(between[1])));
        if (n.indexOf('<') < 0 && n.indexOf('>') >= 0 && n.indexOf('>') == n.lastIndexOf('>')) {
            int i = n.indexOf('>');
            String a = n.substring(0, i).strip(), b = n.substring(i + 1).strip();
            if (!b.isEmpty()) {
                Place to = place(b);
                if (a.isEmpty()) return new DestinationInfo(raw, DestinationInfo.TO, null, to, List.of(to));
                Place from = place(a);
                return new DestinationInfo(raw, DestinationInfo.FROM_TO, from, to, List.of(from, to));
            }
        }
        Place whole = place(n);
        return new DestinationInfo(raw, DestinationInfo.TEXT, null, whole, List.of(whole));
    }

    static String normalize(String raw) {
        return SPACES.matcher(raw.toUpperCase(Locale.ROOT).strip()).replaceAll(" ");
    }

    /** sep 이 정확히 한 번이고 양쪽 조각이 비어 있지 않으며 다른 꺾쇠가 없으면 [A, B], 아니면 null. */
    static String[] split(String n, String sep) {
        int i = n.indexOf(sep);
        if (i < 0 || n.indexOf(sep, i + 1) >= 0) return null;
        String a = n.substring(0, i).strip(), b = n.substring(i + sep.length()).strip();
        if (a.isEmpty() || b.isEmpty() || hasAngle(a) || hasAngle(b)) return null;
        return new String[]{a, b};
    }

    private static boolean hasAngle(String s) { return s.indexOf('<') >= 0 || s.indexOf('>') >= 0; }

    /** 조각 하나: UN/LOCODE 형식이고 항구 표에 있으면 풀고, 아니면 문구만. */
    Place place(String text) {
        String code = null;
        boolean compact = false;
        Matcher m = SPACED.matcher(text);
        if (m.matches()) {
            code = m.group(1) + m.group(2);
        } else {
            m = COMPACT.matcher(text);
            if (m.matches()) {
                code = m.group(1) + m.group(2);
                compact = true;
            }
        }
        UnlocodePorts.Port p = code == null ? null : ports.find(code);
        if (p == null) return new Place(text, null, null, null, null, false);
        return new Place(text, p.code(), p.name(), p.country(), p.subdivision(), compact && p.nameCollision());
    }
}
