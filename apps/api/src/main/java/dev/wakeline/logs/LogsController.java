package dev.wakeline.logs;

import dev.wakeline.config.Problem;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 시스템 로그 조회(계약 v5 §C4) — 운영 전용: /api/v1/ops/** 규칙(운영 세션 필요, 익명은 404 로 존재를 숨긴다, GET 은 CSRF 헤더 없이).
 * 공개 OpenAPI 문서에는 나오지 않는다(springdoc paths-to-exclude). 로그에는 내부 경로·구성이 담긴다(ADR-018).
 * 서버 로그(wakeline:logs)와 브라우저 오류(wakeline:logs:client)를 합쳐 보인다 — 항목마다 stream = "server" | "client"(계약 v5 §G2, {@link LogReader}).
 * <ul>
 *   <li>GET /api/v1/ops/logs — 최신 순 목록. service(여러 개: 쉼표 또는 되풀이) · level(ERROR | WARN, 여러 개) · q(글자, 200자 이하) · fp · rid ·
 *       since · until(ISO 시각, ts 기준) · cursor(이전 쪽의 next_cursor — "server:{id}" | "client:{id}", §G2 전의 "{id}" 는 server) ·
 *       limit(1–200, 기본 100 — 범위 밖은 끝값).</li>
 *   <li>GET /api/v1/ops/logs/groups — fp 묶음(since · service · level), 두 스트림 모두.</li>
 *   <li>GET /api/v1/ops/logs/{id} — 항목 하나: server → client 순으로 찾는다. stream=server|client 면 그 스트림에서만(두 스트림은 id 를 따로
 *       매기므로 같은 id 가 둘 다에 있을 수 있다). 트림돼 없거나 스키마에 맞지 않으면 404.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/ops/logs")
public class LogsController {
    static final Set<String> SERVICES = Set.of("api", "collector", "ais", "web-client");
    static final Set<String> LEVELS = Set.of("ERROR", "WARN");
    static final int LIMIT_MAX = 200;
    static final int Q_MAX = 200;
    static final Pattern FP = LogEvents.FP;

    private final LogReader reader;

    public LogsController(LogReader reader) {
        this.reader = reader;
    }

    @GetMapping
    public LogReader.Page list(@RequestParam(required = false) List<String> service, @RequestParam(required = false) List<String> level,
                               @RequestParam(required = false) String q, @RequestParam(required = false) String fp,
                               @RequestParam(required = false) String rid, @RequestParam(required = false) Instant since,
                               @RequestParam(required = false) Instant until, @RequestParam(required = false) String cursor,
                               @RequestParam(defaultValue = "100") int limit) {
        if (cursor != null && !cursor.isBlank() && LogReader.parseCursor(cursor) == null)
            throw Problem.badRequest("BAD_CURSOR", "cursor must be the next_cursor of the previous page (server:<stream id> or client:<stream id>)");
        var f = filter(service, level, q, fp, rid, since, until);
        return reader.list(f, cursor == null || cursor.isBlank() ? null : cursor, Math.max(1, Math.min(limit, LIMIT_MAX)));
    }

    @GetMapping("/groups")
    public LogReader.Groups groups(@RequestParam(required = false) Instant since, @RequestParam(required = false) List<String> service,
                                   @RequestParam(required = false) List<String> level) {
        return reader.groups(filter(service, level, null, null, null, since, null));
    }

    @GetMapping("/{id:\\d{1,20}-\\d{1,20}}")
    public JsonNode one(@PathVariable String id, @RequestParam(required = false) String stream) {
        LogStream only = null;
        if (stream != null && !stream.isBlank() && (only = LogStream.ofLabel(stream.trim())) == null)
            throw Problem.badRequest("BAD_STREAM", "stream must be server or client");
        JsonNode n = LogReader.parseId(id) == null ? null // 64비트를 넘는 id 는 스트림에 있을 수 없다
                : only == null ? reader.get(id) : reader.get(id, only);
        if (n == null) throw Problem.notFound("no such log entry (trimmed from the stream, or it failed schema validation)");
        return n;
    }

    static LogReader.Filter filter(List<String> service, List<String> level, String q, String fp, String rid, Instant since, Instant until) {
        Set<String> services = values(service, false);
        if (!SERVICES.containsAll(services)) throw Problem.badRequest("BAD_SERVICE", "service must be one or more of api, collector, ais, web-client");
        Set<String> levels = values(level, true);
        if (!LEVELS.containsAll(levels)) throw Problem.badRequest("BAD_LEVEL", "level must be ERROR and/or WARN");
        String text = q == null || q.isBlank() ? null : q.trim();
        if (text != null && text.length() > Q_MAX) throw Problem.badRequest("BAD_QUERY", "q must be at most " + Q_MAX + " characters");
        String f = fp == null || fp.isBlank() ? null : fp.trim();
        if (f != null && !FP.matcher(f).matches()) throw Problem.badRequest("BAD_FP", "fp must be 16 lowercase hex digits");
        String r = rid == null || rid.isBlank() ? null : rid.trim();
        if (r != null && !LogEvents.REQUEST_ID.matcher(r).matches()) throw Problem.badRequest("BAD_RID", "rid must be 8-64 characters of [0-9A-Za-z-]");
        if (since != null && until != null && since.isAfter(until)) throw Problem.badRequest("BAD_RANGE", "since must not be after until");
        return new LogReader.Filter(services, levels, text, f, r, since, until);
    }

    /** 쉼표·되풀이 모두 받는다. 빈 값은 버린다. */
    private static Set<String> values(List<String> raw, boolean upper) {
        Set<String> out = new LinkedHashSet<>();
        if (raw == null) return out;
        for (String s : raw) {
            if (s == null) continue;
            for (String v : s.split(",")) {
                String t = v.trim();
                if (!t.isEmpty()) out.add(upper ? t.toUpperCase(Locale.ROOT) : t);
            }
        }
        return out;
    }
}
