package dev.wakeline.logs;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * 로그 항목(schemas/log_event.v1.json, 계약 v5 §C1·§C2) 만들기 — 지문 · 필드 상한 · 직렬화 8 KiB 상한.
 * <ul>
 *   <li>지문 fp = SHA-256(서비스 + "\n" + 로거 + "\n" + 예외 종류 + "\n" + 메시지 틀)의 앞 16자리 16진. 메시지 틀: 따옴표 안 문자열 → '…',
 *       16진 8자 이상 → #, 숫자열 → # (이 순서 — 16진 안의 숫자를 먼저 지우면 id 마다 틀이 달라진다). 서비스 안에서만 비교한다.</li>
 *   <li>필드 상한은 스키마 그대로(코드 포인트). 메시지·예외 메시지·스택·context 값은 잘린 곳에 '…(잘림 N자)'(N = 잘라 낸 글자 수)를 붙이고
 *       그 표시까지 상한 안에 넣는다. 이름류(로거·스레드·예외 종류·instance)는 그냥 자른다.</li>
 *   <li>직렬화한 항목(UTF-8)이 {@value #MAX_BYTES} 바이트를 넘으면 stack → exception.message → message 순으로 더 자른다.
 *       그래도 넘치면(context 가 큰 경우뿐) context 키를 뒤에서부터 뺀다.</li>
 * </ul>
 * 가림(LogMasker)은 만드는 쪽이 먼저 한다({@link #fromLogback}) — 여기의 문자열은 이미 가린 값이다.
 */
public final class LogEvents {
    public static final int VERSION = 1;
    /** 항목 하나의 직렬화 크기 상한(계약 §C1). */
    public static final int MAX_BYTES = 8 * 1024;
    static final int MESSAGE_MAX = 4000;
    static final int EX_MESSAGE_MAX = 2000;
    static final int STACK_MAX = 12_000;
    static final int TYPE_MAX = 200;
    static final int LOGGER_MAX = 200;
    static final int THREAD_MAX = 100;
    static final int INSTANCE_MAX = 64;
    static final int CONTEXT_KEYS_MAX = 20;
    static final int CONTEXT_VALUE_MAX = 200;
    static final int CONTEXT_KEY_MAX = 64;
    /** 요청 id 형식(RequestIdFilter 와 같은 규칙) — 맞지 않으면 싣지 않는다. */
    public static final Pattern REQUEST_ID = Pattern.compile("[0-9A-Za-z-]{8,64}");
    public static final String MDC_REQUEST_ID = "request_id";

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Pattern QUOTED = Pattern.compile("\"[^\"\\r\\n]*\"|'[^'\\r\\n]*'");
    private static final Pattern HEX = Pattern.compile("[0-9a-fA-F]{8,}");
    private static final Pattern DIGITS = Pattern.compile("[0-9]+");

    private LogEvents() {}

    /** 예외: 종류(클래스 이름) · 메시지(없으면 null) · 스택(원인 체인 포함). 모두 가린 값. */
    public record Ex(String type, String message, String stack) {}

    /** 직렬화 전의 항목(가린 값). context 값은 문자열·수·불리언·null. */
    public record Draft(Instant ts, String service, String instance, String level, String logger, String thread, String message, Ex exception,
                        String requestId, Map<String, Object> context, boolean untrusted) {}

    // ---------------------------------------------------------------- 지문

    /** 메시지 틀: 따옴표 안 → '…', 16진 8자 이상 → #, 숫자열 → #. */
    public static String template(String message) {
        if (message == null) return "";
        String t = QUOTED.matcher(message).replaceAll("'…'");
        t = HEX.matcher(t).replaceAll("#");
        return DIGITS.matcher(t).replaceAll("#");
    }

    /** fp: SHA-256(서비스 \n 로거 \n 예외 종류(없으면 빈 문자열) \n 메시지 틀) 앞 16자리 16진(소문자). */
    public static String fingerprint(String service, String logger, String exceptionType, String message) {
        String s = service + "\n" + (logger == null ? "" : logger) + "\n" + (exceptionType == null ? "" : exceptionType) + "\n" + template(message);
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(d, 0, 8);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // 모든 JRE 에 있다
        }
    }

    // ---------------------------------------------------------------- logback → 항목

    /** logback 이벤트 → 가린 항목(서비스 api). 메시지는 여기서 가린다. */
    public static Draft fromLogback(ILoggingEvent e, String instance) {
        return fromLogback(e, instance, LogMasker.maskAll(e.getFormattedMessage()));
    }

    /**
     * @param maskedMessage 이미 가린 메시지(지문을 먼저 구하려고 싱크가 가린 것을 다시 쓴다)
     */
    public static Draft fromLogback(ILoggingEvent e, String instance, String maskedMessage) {
        String level = e.getLevel() != null && e.getLevel().isGreaterOrEqual(Level.ERROR) ? "ERROR" : "WARN";
        Map<String, String> mdc = e.getMDCPropertyMap();
        String rid = mdc == null ? null : mdc.get(MDC_REQUEST_ID);
        if (rid != null && !REQUEST_ID.matcher(rid).matches()) rid = null;
        Map<String, Object> ctx = new LinkedHashMap<>();
        if (mdc != null) {
            // 순서가 매번 같게 키 이름순. 값도 가린다(MDC 에 무엇이 들어올지 이 코드가 정하지 않는다)
            for (var m : new TreeMap<>(mdc).entrySet()) {
                if (MDC_REQUEST_ID.equals(m.getKey()) || m.getKey() == null) continue;
                ctx.put(m.getKey(), LogMasker.maskAll(m.getValue()));
            }
        }
        Instant ts = e.getInstant() != null ? e.getInstant() : Instant.ofEpochMilli(e.getTimeStamp());
        return new Draft(ts, "api", instance, level, e.getLoggerName(), e.getThreadName(), maskedMessage == null ? "" : maskedMessage,
                exception(e.getThrowableProxy()), rid, ctx, false);
    }

    /** 스택은 logback 이 찍는 모양 그대로(원인 체인 · Suppressed 포함) — 가린 뒤. */
    static Ex exception(IThrowableProxy tp) {
        if (tp == null) return null;
        String stack = ThrowableProxyUtil.asString(tp);
        return new Ex(tp.getClassName(), LogMasker.maskAll(tp.getMessage()), LogMasker.maskAll(stack));
    }

    // ---------------------------------------------------------------- 상한 · 직렬화

    /** 잘림 표시. N = 잘라 낸 글자 수(코드 포인트). */
    static String marker(int cut) { return "…(잘림 " + cut + "자)"; }

    static int cp(String s) { return s.codePointCount(0, s.length()); }

    /** 표시를 붙여 max 코드 포인트 안에 맞춘다(넘지 않으면 그대로). */
    public static String truncate(String s, int max) {
        if (s == null) return null;
        return new Cut(s, max).value();
    }

    /** 원문과 남길 글자 수 — 표시의 N 은 늘 원문 기준이다(여러 번 줄여도). */
    static final class Cut {
        final String orig;
        final int len;
        int kept;

        Cut(String s, int max) {
            orig = s;
            len = cp(s);
            kept = len <= max ? len : fit(len, max);
        }

        /** 표시까지 max 안에 드는 남길 글자 수. */
        private static int fit(int len, int max) {
            int k = max;
            for (int i = 0; i < 4; i++) {
                int m = marker(len - k).length(); // 표시는 모두 BMP 글자 — length = 코드 포인트 수
                if (k + m <= max) return k;
                k = Math.max(0, max - m);
            }
            return k;
        }

        String value() { return kept >= len ? orig : LogMasker.cut(orig, kept) + marker(len - kept); }

        /** 넘친 바이트 수만큼(적어도 1자) 줄인다 — 글자 하나는 JSON 에서 1바이트 이상이므로 넘친 만큼 이상 준다. */
        void shrinkBy(int overBytes) { kept = Math.max(0, kept - Math.max(1, overBytes)); }
    }

    /** 스키마 필드 상한만 적용한 항목(8 KiB 상한 전). */
    static Draft limitFields(Draft d) {
        Ex ex = d.exception() == null ? null : new Ex(LogMasker.cut(nz(d.exception().type()), TYPE_MAX),
                truncate(d.exception().message(), EX_MESSAGE_MAX), truncate(nz(d.exception().stack()), STACK_MAX));
        return new Draft(d.ts(), d.service(), LogMasker.cut(nz(d.instance()), INSTANCE_MAX), d.level(), LogMasker.cut(nz(d.logger()), LOGGER_MAX),
                d.thread() == null ? null : LogMasker.cut(d.thread(), THREAD_MAX), truncate(nz(d.message()), MESSAGE_MAX), ex,
                d.requestId(), limitContext(d.context()), d.untrusted());
    }

    static Map<String, Object> limitContext(Map<String, Object> ctx) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (ctx == null) return out;
        for (var e : ctx.entrySet()) {
            if (out.size() >= CONTEXT_KEYS_MAX) break;
            if (e.getKey() == null) continue;
            Object v = e.getValue();
            if (v instanceof String s) v = truncate(s, CONTEXT_VALUE_MAX);
            else if (v != null && !(v instanceof Number) && !(v instanceof Boolean)) v = truncate(String.valueOf(v), CONTEXT_VALUE_MAX);
            out.put(LogMasker.cut(e.getKey(), CONTEXT_KEY_MAX), v);
        }
        return out;
    }

    /** 항목 JSON(스트림 필드 'e'): 필드 상한 → {@value #MAX_BYTES} 바이트 상한(stack → exception.message → message → context). */
    public static String serialize(Draft d, String fp, int suppressed) {
        Draft base = limitFields(d);
        Cut msg = new Cut(nz(d.message()), MESSAGE_MAX);
        Cut exMsg = d.exception() == null || d.exception().message() == null ? null : new Cut(d.exception().message(), EX_MESSAGE_MAX);
        Cut stack = d.exception() == null ? null : new Cut(nz(d.exception().stack()), STACK_MAX);
        Map<String, Object> ctx = new LinkedHashMap<>(base.context());
        String json = toJson(with(base, msg, exMsg, stack, ctx), fp, suppressed);
        int bytes = utf8(json);
        for (Cut c : new Cut[]{stack, exMsg, msg}) {
            while (c != null && bytes > MAX_BYTES && c.kept > 0) {
                c.shrinkBy(bytes - MAX_BYTES);
                json = toJson(with(base, msg, exMsg, stack, ctx), fp, suppressed);
                bytes = utf8(json);
            }
        }
        List<String> keys = new ArrayList<>(ctx.keySet());
        while (bytes > MAX_BYTES && !keys.isEmpty()) {
            ctx.remove(keys.removeLast());
            json = toJson(with(base, msg, exMsg, stack, ctx), fp, suppressed);
            bytes = utf8(json);
        }
        return json;
    }

    private static Draft with(Draft b, Cut msg, Cut exMsg, Cut stack, Map<String, Object> ctx) {
        Ex ex = b.exception() == null ? null : new Ex(b.exception().type(), exMsg == null ? null : exMsg.value(), stack == null ? "" : stack.value());
        return new Draft(b.ts(), b.service(), b.instance(), b.level(), b.logger(), b.thread(), msg.value(), ex, b.requestId(), ctx, b.untrusted());
    }

    /** 그대로 JSON 으로(상한을 적용하지 않는다). 키 순서는 스키마 순서. */
    static String toJson(Draft d, String fp, int suppressed) {
        ObjectNode n = JSON.createObjectNode();
        n.put("v", VERSION);
        n.put("ts", TS.format(d.ts()));
        n.put("service", d.service());
        n.put("instance", d.instance());
        n.put("level", d.level());
        n.put("logger", d.logger());
        if (d.thread() == null) n.putNull("thread"); else n.put("thread", d.thread());
        n.put("message", d.message());
        if (d.exception() == null) n.putNull("exception");
        else {
            ObjectNode e = n.putObject("exception");
            e.put("type", d.exception().type());
            if (d.exception().message() == null) e.putNull("message"); else e.put("message", d.exception().message());
            e.put("stack", nz(d.exception().stack()));
        }
        n.put("fp", fp);
        if (d.requestId() == null) n.putNull("request_id"); else n.put("request_id", d.requestId());
        ObjectNode c = n.putObject("context");
        if (d.context() != null) {
            for (var e : d.context().entrySet()) {
                Object v = e.getValue();
                switch (v) {
                    case null -> c.putNull(e.getKey());
                    case Boolean b -> c.put(e.getKey(), b);
                    case Integer i -> c.put(e.getKey(), i);
                    case Long l -> c.put(e.getKey(), l);
                    case Number x -> c.put(e.getKey(), x.doubleValue());
                    default -> c.put(e.getKey(), String.valueOf(v));
                }
            }
        }
        n.put("suppressed", Math.max(0, suppressed));
        if (d.untrusted()) n.put("untrusted", true);
        return JSON.writeValueAsString(n);
    }

    static int utf8(String s) { return s.getBytes(StandardCharsets.UTF_8).length; }

    private static String nz(String s) { return s == null ? "" : s; }
}
