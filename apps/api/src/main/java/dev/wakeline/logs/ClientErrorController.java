package dev.wakeline.logs;

import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.support.LogMasker;
import dev.wakeline.platform.web.ClientIp;
import dev.wakeline.platform.web.Problem;
import dev.wakeline.platform.web.RateLimiter;
import dev.wakeline.platform.web.RequestIdFilter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

/**
 * 브라우저 오류 공개 수집(계약 v5 §C6): 웹 화면의 오류(window.onerror · unhandledrejection · 오류 경계)를 받아 로그 스트림에 싣는다.
 * <ul>
 *   <li>본문 {message ≤ 2000, stack ≤ 8000 | null, path ≤ 300(경로만 — '?' · '#' 뒤는 버린다), component ≤ 200 | null, ts ISO} — 글자 수는 코드 포인트.
 *       본문 8 KiB 초과 413, 형식 오류 400 BAD_CLIENT_ERROR, 성공 204(같은 오류가 10 s 안에 되풀이되어 억제돼도 204).
 *       JSON 이 아닌 Content-Type(없는 것 포함)은 415 UNSUPPORTED_MEDIA_TYPE + Accept(계약 v5 §G3 — 로그인의 @RequestBody 와 같은 관례):
 *       consumes 로 Spring MVC 가 처리기 앞에서 거절한다 — 요청 제한 수를 쓰지 않고 본문도 읽지 않는다.</li>
 *   <li>요청 제한: IP당 분당 {@value #PER_IP_PER_MIN} · 전체 분당 {@value #GLOBAL_PER_MIN}(Redis 제한기, 키 rl:cerr:{ip}|all:{분}) — 429 + Retry-After.
 *       IP 가 막힌 요청은 전체 한도를 쓰지 않는다. 제한기가 Redis 에 닿지 않으면 받지 않는다(503) — Redis 장애 중에는 대기열이 서버 오류를
 *       붙잡아 두는 자리라서, 누구나 보낼 수 있는 브라우저 오류로 그 자리를 밀어내지 못하게 한다. /api/** 공통 제한(IP당 분당 120)도 그대로 적용된다.</li>
 *   <li>스트림: wakeline:logs:client(MAXLEN ~ 1000, 계약 v5 §G2) — 서버 로그 wakeline:logs 와 따로 자른다(익명 입력이 서버 오류를 밀어내지 못하게).</li>
 *   <li>항목: service "web-client" · level ERROR · untrusted true(브라우저가 보낸 내용 — 사실로 믿지 말 것). ts 는 api 가 받은 시각이고
 *       브라우저가 보낸 시각은 context.client_ts. logger = component(가린 뒤, 없으면 "browser"), 스택이 있으면 exception {type:""(모름 — 브라우저는 오류
 *       종류를 따로 보내지 않는다, 출처는 service · untrusted 가 말한다), message:null, stack}. request_id 는 null(이 수집 요청은 오류의 원인이 아니다 — 받은 요청의 id 는
 *       context.receive_request_id). User-Agent 앞 200자는 context.user_agent. 클라이언트 IP 는 싣지 않는다.</li>
 *   <li>메시지·스택·경로·component·User-Agent 는 가림(LogMasker)을 거친다. 쿠키 인증이 없으므로 CSRF 대상이 아니다(SecurityConfig: 공개 경로).</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1")
public class ClientErrorController {
    static final int MAX_BODY_BYTES = 8 * 1024;
    static final int MESSAGE_MAX = 2000;
    static final int STACK_MAX = 8000;
    static final int PATH_MAX = 300;
    static final int COMPONENT_MAX = 200;
    static final int USER_AGENT_MAX = 200;
    static final int PER_IP_PER_MIN = 10;
    static final int GLOBAL_PER_MIN = 120;
    static final String BUCKET = "cerr";
    static final String SERVICE = "web-client";
    /** 예외 종류를 모른다(스키마: 빈 글 허용). 출처 이름("web-client")을 종류 자리에 넣지 않는다 — 운영 화면이 '예외 종류' 로 보인다. */
    static final String UNKNOWN_TYPE = "";
    private static final JsonMapper JSON = JsonMapper.builder().build();
    /**
     * context.client_ts 형식(ms 까지). 연도는 'u'(역년 — 0 · 음수 그대로, 네 자리를 넘으면 + 부호 — ISO 8601 확장 연도). 'y'(기원 안 연도)는 기원을 찍지
     * 않아 연도 0 · 기원전이 다른 기원후 연도로 바뀌었다(QA-209: -999999999 → +1000000000, 0000 → 0001 — 받은 시각과 다른 값을 저장했다).
     */
    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /** 공개 문서(OpenAPI)용 본문 모양 — 실제 검증은 {@link #report} 가 한다. */
    @Schema(name = "ClientErrorReport", description = "브라우저 오류 한 건(계약 v5 §C6). 본문 전체 8 KiB 이하.")
    public record ClientErrorReport(
            @Schema(requiredMode = Schema.RequiredMode.REQUIRED, minLength = 1, maxLength = MESSAGE_MAX) String message,
            @Schema(nullable = true, maxLength = STACK_MAX) String stack,
            @Schema(requiredMode = Schema.RequiredMode.REQUIRED, maxLength = PATH_MAX, description = "경로만('/' 로 시작). '?' · '#' 뒤는 버린다") String path,
            @Schema(nullable = true, maxLength = COMPONENT_MAX) String component,
            @Schema(requiredMode = Schema.RequiredMode.REQUIRED, format = "date-time", description = "브라우저 시각(ISO 8601)") String ts) {}

    private final LogSink sink;
    private final RateLimiter limiter;
    private final AppProperties props;
    private final Supplier<Instant> clock;

    @Autowired
    public ClientErrorController(LogSink sink, RateLimiter limiter, AppProperties props) {
        this(sink, limiter, props, Instant::now);
    }

    ClientErrorController(LogSink sink, RateLimiter limiter, AppProperties props, Supplier<Instant> clock) {
        this.sink = sink;
        this.limiter = limiter;
        this.props = props;
        this.clock = clock;
    }

    @PostMapping(path = "/client-errors", consumes = MediaType.APPLICATION_JSON_VALUE)
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @io.swagger.v3.oas.annotations.parameters.RequestBody(required = true,
            content = @Content(mediaType = MediaType.APPLICATION_JSON_VALUE, schema = @Schema(implementation = ClientErrorReport.class)))
    public void report(HttpServletRequest req) throws IOException {
        if (!sink.enabled())
            throw new Problem(HttpStatus.SERVICE_UNAVAILABLE, "LOG_SINK_DISABLED", "service unavailable", "log collection is turned off on this server");
        rateLimit(ClientIp.resolve(req, props.trustedProxy()));
        JsonNode root = parse(readBody(req)); // Content-Type 은 consumes 가 이미 걸렀다(JSON 이 아니면 415 — §G3)

        String message = text(root, "message", MESSAGE_MAX, true);
        if (message.isEmpty()) throw bad("message must not be empty");
        String stack = text(root, "stack", STACK_MAX, false);
        String path = text(root, "path", PATH_MAX, true);
        if (!path.startsWith("/")) throw bad("path must be a path starting with '/' (no scheme or host)");
        String component = text(root, "component", COMPONENT_MAX, false);
        Instant clientTs = time(text(root, "ts", 64, true));

        String cleanPath = path;
        int cut = indexOfAny(cleanPath, '?', '#');
        if (cut >= 0) cleanPath = cleanPath.substring(0, cut);
        String logger = component == null || component.isBlank() ? "browser" : LogMasker.maskAll(component);
        String maskedMessage = LogMasker.maskAll(message);
        LogEvents.Ex ex = stack == null || stack.isEmpty() ? null : new LogEvents.Ex(UNKNOWN_TYPE, null, LogMasker.maskAll(stack));

        Map<String, Object> ctx = new LinkedHashMap<>();
        ctx.put("path", LogMasker.maskAll(cleanPath));
        ctx.put("client_ts", TS.format(clientTs));
        String ua = req.getHeader("User-Agent");
        if (ua != null && !ua.isBlank()) ctx.put("user_agent", LogMasker.cut(LogMasker.maskAll(ua), USER_AGENT_MAX));
        String rid = RequestIdFilter.current(req);
        if (LogEvents.REQUEST_ID.matcher(rid).matches()) ctx.put("receive_request_id", rid);

        var draft = new LogEvents.Draft(clock.get(), SERVICE, sink.instance(), "ERROR", logger, null, maskedMessage, ex, null, ctx, true);
        // §G2: 따로 자르는 브라우저 오류 스트림(wakeline:logs:client MAXLEN ~ 1000)으로 — 서버 오류(wakeline:logs)를 밀어내지 못하게
        LogSink.Offer offer = sink.submit(LogStream.CLIENT, SERVICE, logger, ex == null ? null : ex.type(), maskedMessage,
                (fp, n) -> LogEvents.serialize(draft, fp, n));
        if (offer == LogSink.Offer.DISABLED)
            throw new Problem(HttpStatus.SERVICE_UNAVAILABLE, "LOG_SINK_DISABLED", "service unavailable", "log collection is turned off on this server");
    }

    /** IP 먼저, 통과한 요청만 전체 한도를 쓴다. Redis 가 안 되면 받지 않는다(503 — 클래스 설명). */
    private void rateLimit(String ip) {
        long[] perIp, all;
        try {
            perIp = limiter.hitStrict(BUCKET, ip, 60);
            if (perIp[0] > PER_IP_PER_MIN) throw Problem.tooManyRequests(PER_IP_PER_MIN + " client error reports per minute per IP", perIp[1]);
            all = limiter.hitStrict(BUCKET, "all", 60);
        } catch (Problem p) {
            throw p;
        } catch (RuntimeException e) {
            throw Problem.unavailable("rate limiter unavailable; client error report not accepted");
        }
        if (all[0] > GLOBAL_PER_MIN) throw Problem.tooManyRequests(GLOBAL_PER_MIN + " client error reports per minute in total", all[1]);
    }

    /** 선언된 길이로 먼저, 그다음 실제로 읽은 바이트로(chunked) 8 KiB 를 넘는지 본다 — 상한 + 1바이트까지만 읽는다. */
    private static byte[] readBody(HttpServletRequest req) throws IOException {
        if (req.getContentLengthLong() > MAX_BODY_BYTES) throw tooLarge();
        byte[] b;
        try (InputStream in = req.getInputStream()) {
            b = in.readNBytes(MAX_BODY_BYTES + 1);
        }
        if (b.length > MAX_BODY_BYTES) throw tooLarge();
        return b;
    }

    private static JsonNode parse(byte[] body) {
        JsonNode root;
        try {
            root = JSON.readTree(body);
        } catch (RuntimeException e) {
            throw bad("body must be a JSON object");
        }
        if (root == null || !root.isObject()) throw bad("body must be a JSON object");
        return root;
    }

    /** 문자열 필드(코드 포인트 max 이하). 없거나 null 이면 required 일 때 400, 아니면 null. */
    private static String text(JsonNode root, String field, int max, boolean required) {
        JsonNode v = root.get(field);
        if (v == null || v.isNull()) {
            if (required) throw bad(field + " is required");
            return null;
        }
        if (!v.isString()) throw bad(field + " must be a string");
        String s = v.asString();
        if (s.codePointCount(0, s.length()) > max) throw bad(field + " must be at most " + max + " characters");
        return s;
    }

    private static Instant time(String s) {
        try {
            return OffsetDateTime.parse(s).toInstant();
        } catch (RuntimeException e) {
            throw bad("ts must be an ISO 8601 date-time with an offset (e.g. 2026-09-29T03:04:05.678Z)");
        }
    }

    private static int indexOfAny(String s, char a, char b) {
        int i = s.indexOf(a), j = s.indexOf(b);
        if (i < 0) return j;
        if (j < 0) return i;
        return Math.min(i, j);
    }

    private static Problem bad(String detail) { return Problem.badRequest("BAD_CLIENT_ERROR", detail); }

    private static Problem tooLarge() {
        return new Problem(HttpStatus.CONTENT_TOO_LARGE, "TOO_LARGE", "content too large", "body must be at most " + MAX_BODY_BYTES + " bytes");
    }
}
