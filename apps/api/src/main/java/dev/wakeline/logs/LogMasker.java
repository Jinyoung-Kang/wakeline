package dev.wakeline.logs;

import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 로그 글자에서 비밀값을 가리는 규칙(계약 v5 §C5). collector {@code wakeline_collector/masking.py} 와 같은 규칙·같은 순서다 —
 * 언어 간 시험 벡터 {@code schemas/vectors/masking-cases.v1.json} 의 결과가 두 언어에서 글자 하나까지 같아야 한다(LogMaskerTest · pytest).
 * <ul>
 *   <li>모양으로 가리기: key=value · JSON({@code "authKey": "…"}) · Bearer · Authorization 헤더 · URL userinfo · JWT,
 *       그리고 v5 새 규칙 {@code [?&](key|apikey|access_key)=} 쿼리 파라미터.</li>
 *   <li>값으로 가리기: 기동 때 {@link #registerSecrets} 로 넘긴 설정 비밀값(DB · Redis 비밀번호) 자체를 어디에 나오든 가린다(6자 이상만).</li>
 * </ul>
 * Python 의 {@code re}(str 패턴)와 같은 글자 집합을 쓴다 — Java 의 {@code \s} · {@code \w}(UNICODE_CHARACTER_CLASS)는 Python 과 다르다
 * (Java \s 에는 U+001C–U+001F 가 없고, Java \w 에는 결합 부호가 있고 '²' 같은 숫자(No)가 없다). 그래서 {@link #SP} · {@link #WD} 를 적어 두고,
 * (?i) 는 CASE_INSENSITIVE · UNICODE_CASE(ſ · K(켈빈) · İ 도 s · k · i 와 같다 — Python 과 같다). 세 가지 모두 모든 코드 포인트를 Python 3.13 과
 * 견줘 같다(\w 는 Python 의 유니코드 15.1 에 아직 없는 글자만 다르다 — JDK 25 는 유니코드 16.0).
 * 길이 한계는 코드 포인트로 센다(Python 문자열 자르기와 같다).
 */
public final class LogMasker {
    /** 메시지 한 줄 기본 한계(Python mask 의 기본값과 같다). */
    public static final int DEFAULT_LIMIT = 4000;
    /** 로그 한 건(스택 포함) 가림 상한 — 넘는 부분은 잘린다(Python LOG_LIMIT 과 같다). */
    public static final int LOG_LIMIT = 100_000;
    /** 이보다 짧은 값은 값으로 가리지 않는다(흔한 글자열을 모두 가려 로그를 망치지 않게). */
    public static final int MIN_SECRET_LEN = 6;

    private static final int CI = Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE;
    /** Python \s(str.isspace): 탭·줄바꿈류 · U+001C–U+001F · 공백 · U+0085 · U+00A0 · U+1680 · U+2000–U+200A · U+2028 · U+2029 · U+202F · U+205F · U+3000. */
    static final String SP = "\\t\\n\\x0B\\f\\r\\x1C-\\x1F \\x85\\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
    /** Python \w(str.isalnum() 또는 '_'): 글자(L*) · 숫자(N*) · '_'. */
    static final String WD = "\\p{L}\\p{N}_";
    private static final String KEYS = "(?:client_secret|client_id|serviceKey|authKey|api[_-]?key|password|access_token|refresh_token|token|secret)";

    private record Rule(Pattern pattern, String replacement) {}

    /** 순서가 결과를 정한다 — masking.py 의 _PATTERNS 와 같은 순서(새 쿼리 키 규칙은 api_key= 다음). */
    private static final List<Rule> RULES = List.of(
            new Rule(Pattern.compile("(client_secret=)[^&" + SP + "]+", CI), "$1***"),
            new Rule(Pattern.compile("(client_id=)[^&" + SP + "]+", CI), "$1***"),
            new Rule(Pattern.compile("(bearer[" + SP + "]+)[A-Za-z0-9\\-._~+/]+=*", CI), "$1***"),
            new Rule(Pattern.compile("(authorization:[" + SP + "]*)[^\\r\\n]+", CI), "$1***"),
            new Rule(Pattern.compile("(serviceKey=)[^&" + SP + "]+", CI), "$1***"),
            new Rule(Pattern.compile("(authKey=)[^&" + SP + "]+", CI), "$1***"),
            new Rule(Pattern.compile("(api[_-]?key=)[^&" + SP + "]+", CI), "$1***"),
            // v5: ?key= · &apikey= · &access_key= (예: 선박 정보 공급자 URL). 앞이 '?'·'&' 일 때만 — 문장 속 "primary key=…" 는 그대로
            new Rule(Pattern.compile("([?&](?:key|apikey|access_key)=)[^&" + SP + "]+", CI), "$1***"),
            new Rule(Pattern.compile("(password=)[^&" + SP + "]+", CI), "$1***"),
            new Rule(Pattern.compile("(token=)[^&" + SP + "]+", CI), "$1***"),
            new Rule(Pattern.compile("(secret=)[^&" + SP + "]+", CI), "$1***"),
            // JSON·파이썬 repr 형태: "authKey": "…" / 'access_token': '…' ('=' 가 없어 위 규칙이 못 잡는다)
            new Rule(Pattern.compile("([\"']" + KEYS + "[\"'][" + SP + "]*:[" + SP + "]*[\"'])[^\"']*([\"'])", CI), "$1***$2"),
            new Rule(Pattern.compile("([" + WD + "]+://[^:/" + SP + "]+:)[^@" + SP + "]+(@)"), "$1***$2"), // scheme://user:pass@host
            new Rule(Pattern.compile("eyJ[A-Za-z0-9\\-_]{10,}\\.[A-Za-z0-9\\-_]{10,}\\.[A-Za-z0-9\\-_]{10,}"), "***jwt***"));

    /** 긴 값부터(다른 값을 품은 값이 먼저 가려지게). 쓰기는 기동 때 몇 번뿐이다. */
    private static final CopyOnWriteArrayList<String> SECRETS = new CopyOnWriteArrayList<>();

    private LogMasker() {}

    /** 설정 비밀값을 값 치환 목록에 더한다. null·빈 값·{@value #MIN_SECRET_LEN}자보다 짧은 값은 무시한다. */
    public static synchronized void registerSecrets(String... values) {
        for (String v : values) {
            if (v == null || v.length() < MIN_SECRET_LEN || SECRETS.contains(v)) continue;
            SECRETS.add(v);
        }
        List<String> sorted = SECRETS.stream().sorted(Comparator.comparingInt(String::length).reversed()).toList();
        SECRETS.clear();
        SECRETS.addAll(sorted);
    }

    /** 등록된 값의 수(값 자체는 내보내지 않는다). */
    public static int secretCount() { return SECRETS.size(); }

    /** 시험용: 등록한 값을 모두 지운다. */
    static synchronized void clearSecrets() { SECRETS.clear(); }

    /** {@link #DEFAULT_LIMIT} 코드 포인트까지. */
    public static String mask(String text) { return mask(text, DEFAULT_LIMIT); }

    /** 모양 규칙 → 등록 값 치환 → 앞에서 limit 코드 포인트. null → null. */
    public static String mask(String text, int limit) {
        if (text == null) return null;
        String out = text;
        for (Rule r : RULES) {
            Matcher m = r.pattern().matcher(out);
            if (m.find()) out = m.replaceAll(r.replacement());
        }
        for (String secret : SECRETS) if (out.contains(secret)) out = out.replace(secret, "***");
        return cut(out, limit);
    }

    /** 앞에서 n 코드 포인트(서로게이트 쌍을 가르지 않는다). */
    static String cut(String s, int n) {
        if (s.length() <= n) return s;
        if (s.codePointCount(0, s.length()) <= n) return s;
        return s.substring(0, s.offsetByCodePoints(0, n));
    }
}
