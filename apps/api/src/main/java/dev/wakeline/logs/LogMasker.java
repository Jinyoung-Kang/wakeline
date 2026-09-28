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
 *       그리고 v5 새 규칙 {@code [?&](key|apikey|access_key)=} 쿼리 파라미터. 모든 규칙이 글자 수에 비례하는 시간으로 끝난다 — 누구나 보낼 수
 *       있는 브라우저 오류(§C6)도 이 함수를 거친다.</li>
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
            new Rule(Pattern.compile("([\"']" + KEYS + "[\"'][" + SP + "]*:[" + SP + "]*[\"'])[^\"']*([\"'])", CI), "$1***$2"));
    // 그다음 maskUserinfo · maskJwt(마지막 두 규칙 — 글자 수에 비례하는 시간으로 쓴 것)
    /** 낱말 글자열 하나, 뒤에 '://호스트:비밀번호' 와 '@' 가 오면 그것까지. 그룹: 1 scheme · 2 ://호스트: · 3 '@'(없으면 가리지 않는다). */
    private static final Pattern USERINFO = Pattern.compile("([" + WD + "]+)(?:(://[^:/" + SP + "]+:)[^@" + SP + "]+(@)?)?");
    private static final String B64URL = "[A-Za-z0-9\\-_]";
    /** 'eyJ' 와 JWT 세 칸(그룹 1) — 아니면 'eyJ' 와 그 뒤 base64url 글자열 전부(건너뛸 구간). */
    private static final Pattern JWT = Pattern.compile("eyJ(?:(" + B64URL + "{10,}\\." + B64URL + "{10,}\\." + B64URL + "{10,})|" + B64URL + "*)");

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
        out = maskJwt(maskUserinfo(out));
        for (String secret : SECRETS) if (out.contains(secret)) out = out.replace(secret, "***");
        return cut(out, limit);
    }

    /**
     * scheme://user:pass@host → scheme://user:***@host. masking.py 의 {@code (?<!\w)(\w+://[^:/\s]+:)[^@\s]+(@)?} 와 글자 하나까지 같은
     * 결과다(예전 {@code (\w+://[^:/\s]+:)[^@\s]+(@)} 와도 같다 — LogMaskerTest 가 무작위 글 20,000개로 견준다).
     * 예전 식은 낱말 글자열 안의 시작점마다 글자열 끝까지 다시 훑어 글자 수의 제곱 시간이 들었다(낱말 글자열 100,000자 29 s). 여기서는
     * 낱말 글자열을 통째로 한 번 읽는다 — 낱말 안에서 시작하는 일치는 그 낱말 처음에서도 일치하므로 결과가 같다. 뒤에 '://…:' 가 없거나
     * '@' 없이 공백·끝에서 멈추면 그 구간을 그대로 두고 건너뛴다(구간 안의 다른 시작점도 같은 공백·끝에서 멈추므로 일치하지 않는다).
     * Python 처럼 뒤보기 {@code (?<!\w)} 로 쓰지 않는 까닭: Java 의 뒤보기는 보조 평면 글자(𝐀 같은 서로게이트 쌍)를 한 글자로 보지 못해
     * 그런 글자열에서 다시 제곱 시간이 된다(16,000자 0.33 s).
     */
    static String maskUserinfo(String s) {
        if (!s.contains("://")) return s;
        Matcher m = USERINFO.matcher(s);
        StringBuilder out = null;
        int last = 0;
        while (m.find()) {
            if (m.start(3) < 0) continue; // '@' 가 없다 — 그대로
            if (out == null) out = new StringBuilder(s.length());
            out.append(s, last, m.end(2)).append("***@");
            last = m.end();
        }
        return out == null ? s : out.append(s, last, s.length()).toString();
    }

    /**
     * JWT(eyJ….….…) → ***jwt***. 'eyJ' 에서 일치하지 않으면 그 base64url 글자열 끝까지 건너뛴다 — 같은 글자열 안의 뒤쪽 'eyJ' 는 같은 곳에서
     * 끊기고(첫 칸이 더 짧다) 뒤의 칸도 같아서 역시 일치하지 않는다. 예전 식(되짚기)은 'eyJ' 반복 8,100자에 0.25 s 가 들었다. masking.py 와 같은 규칙.
     */
    static String maskJwt(String s) {
        if (!s.contains("eyJ")) return s;
        Matcher m = JWT.matcher(s);
        StringBuilder out = null;
        int last = 0;
        while (m.find()) {
            if (m.start(1) < 0) continue; // JWT 가 아니다 — 그대로
            if (out == null) out = new StringBuilder(s.length());
            out.append(s, last, m.start()).append("***jwt***");
            last = m.end();
        }
        return out == null ? s : out.append(s, last, s.length()).toString();
    }

    /** 앞에서 n 코드 포인트(서로게이트 쌍을 가르지 않는다). */
    static String cut(String s, int n) {
        if (s.length() <= n) return s;
        if (s.codePointCount(0, s.length()) <= n) return s;
        return s.substring(0, s.offsetByCodePoints(0, n));
    }
}
