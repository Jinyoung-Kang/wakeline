package dev.wakeline.domain;

import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 선박 검색어(계약 v5 §B1). 앞뒤 공백을 떼고 대문자로 바꾼 2–40자 [A-Z0-9 .-/] 만 받는다(ASCII 밖 글자는 대문자로 바꾸기 전에 거부 — 'ı' 를 'I' 로
 * 바꿔 찾지 않는다). 일치 규칙:
 * <ul>
 *   <li>9자리 숫자 → MMSI 정확 일치</li>
 *   <li>7자리 숫자 → MMSI 앞부분 <b>또는</b> IMO 정확 일치(계약의 '3–8자리 숫자 → MMSI 앞부분' 과 '7자리 숫자 → IMO' 가 겹친다 — 둘 다 찾는다)</li>
 *   <li>그 밖 3–8자리 숫자 → MMSI 앞부분</li>
 *   <li>"IMO" + (공백) + 7자리 숫자 → IMO 정확 일치</li>
 *   <li>그 밖 → 선명 앞부분 또는 호출부호 앞부분(대소문자 무시)</li>
 * </ul>
 * 모든 값은 선박이 보낸 보고값과의 비교다(선명·호출부호·IMO 는 정적 정보가 있을 때만 — 없으면 MMSI 로만 찾힌다).
 */
public record ShipQuery(String text, Kind kind, Integer imo) {
    public static final int MIN_LENGTH = 2;
    public static final int MAX_LENGTH = 40;

    public enum Kind { MMSI, MMSI_PREFIX, MMSI_PREFIX_OR_IMO, IMO, NAME_OR_CALL_SIGN }

    private static final Pattern ALPHABET = Pattern.compile("^[A-Za-z0-9 .\\-/]+$");
    private static final Pattern DIGITS = Pattern.compile("^[0-9]+$");
    private static final Pattern IMO_PREFIXED = Pattern.compile("^IMO ?([0-9]{7})$");

    /** @throws IllegalArgumentException 형식이 틀리면(메시지는 그대로 400 detail 로 나간다) */
    public static ShipQuery parse(String raw) {
        String t = raw == null ? "" : raw.trim();
        if (t.length() < MIN_LENGTH || t.length() > MAX_LENGTH)
            throw new IllegalArgumentException("q must be " + MIN_LENGTH + ".." + MAX_LENGTH + " chars after trimming");
        if (!ALPHABET.matcher(t).matches()) throw new IllegalArgumentException("q may contain letters A-Z, digits, space, '.', '-' and '/' only");
        String q = t.toUpperCase(Locale.ROOT);
        if (DIGITS.matcher(q).matches()) {
            if (q.length() == 9) return new ShipQuery(q, Kind.MMSI, null);
            if (q.length() == 7) return new ShipQuery(q, Kind.MMSI_PREFIX_OR_IMO, Integer.parseInt(q));
            if (q.length() >= 3 && q.length() <= 8) return new ShipQuery(q, Kind.MMSI_PREFIX, null);
        }
        Matcher m = IMO_PREFIXED.matcher(q);
        if (m.matches()) return new ShipQuery(q, Kind.IMO, Integer.parseInt(m.group(1)));
        return new ShipQuery(q, Kind.NAME_OR_CALL_SIGN, null);
    }

    /** 이 선박(MMSI + 알고 있는 정적 정보, 없으면 null)이 검색어와 일치하는가. */
    public boolean matches(String mmsi, ShipStatic st) {
        return switch (kind) {
            case MMSI -> text.equals(mmsi);
            case MMSI_PREFIX -> mmsi.startsWith(text);
            case MMSI_PREFIX_OR_IMO -> mmsi.startsWith(text) || imoEquals(st);
            case IMO -> imoEquals(st);
            case NAME_OR_CALL_SIGN -> st != null && (startsWith(st.name()) || startsWith(st.callSign()));
        };
    }

    /** 정확 일치(결과 맨 앞): MMSI 전체 · IMO 번호 · 선명 또는 호출부호 전체가 검색어와 같다. */
    public boolean exact(String mmsi, ShipStatic st) {
        return switch (kind) {
            case MMSI -> text.equals(mmsi);
            case MMSI_PREFIX -> false;
            case MMSI_PREFIX_OR_IMO, IMO -> imoEquals(st);
            case NAME_OR_CALL_SIGN -> st != null && (text.equals(upper(st.name())) || text.equals(upper(st.callSign())));
        };
    }

    /** MMSI 앞부분 범위의 아래 끝(9자리로 0 채움) — 같은 길이 숫자열이라 DB 정렬 규칙과 무관하게 앞부분 일치와 같다. */
    public String mmsiLow() { return text + "0".repeat(9 - text.length()); }

    /** MMSI 앞부분 범위의 위 끝(9자리로 9 채움, 포함). */
    public String mmsiHigh() { return text + "9".repeat(9 - text.length()); }

    /** 선명·호출부호 앞부분 범위 [text, textHigh) 의 위 끝: 마지막 글자 + 1(바이트 순서 — 허용 글자는 모두 ASCII 라 넘치지 않는다). */
    public String textHigh() { return text.substring(0, text.length() - 1) + (char) (text.charAt(text.length() - 1) + 1); }

    private boolean imoEquals(ShipStatic st) { return st != null && imo != null && Objects.equals(st.imo(), imo); }

    private boolean startsWith(String v) { return v != null && upper(v).startsWith(text); }

    private static String upper(String v) { return v == null ? null : v.toUpperCase(Locale.ROOT); }
}
