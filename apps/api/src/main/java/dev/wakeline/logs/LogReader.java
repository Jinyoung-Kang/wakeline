package dev.wakeline.logs;

import com.fasterxml.jackson.annotation.JsonInclude;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Range;
import org.springframework.data.domain.Range.Bound;
import org.springframework.data.redis.connection.Limit;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 시스템 로그 스트림 읽기(계약 v5 §C4). XREVRANGE 를 {@value #CHUNK}건씩 끊어 최신 순으로 읽으며 필터를 적용한다 —
 * 한 요청이 훑는 항목은 {@value #SCAN_MAX}건 이하(스트림 MAXLEN ~ 3000 과 같은 크기 — 보통은 스트림 전체).
 * <ul>
 *   <li>항목마다 스키마 검증(log_event.v1) — 맞지 않거나 필드 e 가 없는 항목은 건너뛰고 invalid 로 센다.</li>
 *   <li>한 번 더 가림(방어적): 메시지 · 로거 · 스레드 · 예외 종류·메시지·스택 · context 문자열 값. 글자 검색은 가린 뒤의 글자로만 한다
 *       (비밀값으로 검색해 그 값이 로그에 있는지 알아내지 못하게).</li>
 *   <li>기간(since · until)은 항목의 ts 로 거른다. 항목의 ts 는 실린 시각(스트림 id)보다 늦을 수 없으므로(같은 호스트 시계) since 보다
 *       {@value #SKEW_MS} ms 앞의 id 에서 읽기를 멈춘다(여유는 시계 차이 대비).</li>
 *   <li>cursor = 마지막으로 본 항목의 스트림 id(그 id 는 빼고 이어 읽는다). 쪽이 차서 멈추면 마지막 항목의 id, 훑기 상한에 걸려 멈추면
 *       마지막으로 훑은 항목의 id(scan_truncated) — 같은 3,000건을 다시 훑지 않고 이어 간다. 더 없으면 null.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class LogReader {
    static final int CHUNK = 200;
    public static final int SCAN_MAX = 3_000;
    static final long SKEW_MS = 60_000;
    static final int SAMPLE_MAX = 500;
    private static final JsonMapper JSON = JsonMapper.builder().build();

    /** 스트림 접근(시험에서 메모리 스트림으로 바꾼다). */
    public interface Source {
        /** XREVRANGE: endInclusive(null = '+')부터 startInclusive(null = '-')까지 최신 순 최대 count 건. */
        List<Raw> reverse(String endInclusive, String startInclusive, int count);

        /** XRANGE id id — 없으면(트림됨) null. */
        Raw get(String id);
    }

    /** 스트림 항목 하나: id 와 필드 e(없으면 null). */
    public record Raw(String id, String e) {}

    /**
     * 필터. services · levels 가 비어 있으면 모두. q 는 대소문자 무시 부분 일치(메시지 · 로거 · 예외 종류·메시지·스택).
     * fp · rid 는 정확히 일치. since · until 은 ts 기준 양 끝 포함.
     */
    public record Filter(Set<String> services, Set<String> levels, String q, String fp, String rid, Instant since, Instant until) {}

    /** 목록 쪽: items 는 {id, ...항목}. */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Page(List<JsonNode> items, String nextCursor, int scanned, boolean scanTruncated, int invalid) {}

    /** fp 묶음: count = 항목 수, suppressed = 항목들의 suppressed 합, first_at · last_at 은 항목의 ts 그대로, 표본은 가장 최근 항목의 메시지. */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Group(String fp, String service, String level, String logger, String exceptionType, String sampleMessage, long count,
                        long suppressed, String firstAt, String lastAt, String lastId) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Groups(List<Group> groups, int scanned, boolean scanTruncated, int invalid) {}

    private record Parsed(ObjectNode node, Instant ts) {}

    private final Source source;
    private final LogEventSchema schema = new LogEventSchema();

    @Autowired
    public LogReader(StringRedisTemplate redis) { this(redisSource(redis)); }

    LogReader(Source source) { this.source = source; }

    static Source redisSource(StringRedisTemplate redis) {
        return new Source() {
            @Override
            public List<Raw> reverse(String endInclusive, String startInclusive, int count) {
                Range<String> range = Range.of(startInclusive == null ? Bound.unbounded() : Bound.inclusive(startInclusive),
                        endInclusive == null ? Bound.unbounded() : Bound.inclusive(endInclusive));
                List<MapRecord<String, Object, Object>> recs = redis.opsForStream().reverseRange(LogSink.STREAM, range, Limit.limit().count(count));
                List<Raw> out = new ArrayList<>(recs == null ? 0 : recs.size());
                if (recs != null) for (var r : recs) out.add(raw(r));
                return out;
            }

            @Override
            public Raw get(String id) {
                var recs = redis.opsForStream().range(LogSink.STREAM, Range.closed(id, id), Limit.limit().count(1));
                return recs == null || recs.isEmpty() ? null : raw(recs.getFirst());
            }
        };
    }

    private static Raw raw(MapRecord<String, Object, Object> r) {
        Object e = r.getValue().get("e");
        return new Raw(r.getId().getValue(), e == null ? null : String.valueOf(e));
    }

    // ---------------------------------------------------------------- 목록

    public Page list(Filter f, String cursor, int limit) {
        String upper = null;
        if (cursor != null) {
            upper = previousId(cursor);
            if (upper == null) return new Page(List.of(), null, 0, false, 0); // 0-0 앞에는 아무것도 없다
        }
        String lower = lowerBound(f.since());
        String q = f.q() == null ? null : f.q().toLowerCase(Locale.ROOT);
        List<JsonNode> items = new ArrayList<>();
        int scanned = 0, invalid = 0;
        String last = null;
        boolean stopped = false;
        outer:
        while (true) {
            if (scanned >= SCAN_MAX) { stopped = true; break; }
            int n = Math.min(CHUNK, SCAN_MAX - scanned);
            List<Raw> chunk = source.reverse(upper, lower, n);
            for (Raw r : chunk) {
                scanned++;
                last = r.id();
                Parsed p = parse(r);
                if (p == null) invalid++;
                else if (matches(f, q, p)) items.add(p.node());
                if (items.size() >= limit || scanned >= SCAN_MAX) { stopped = true; break outer; }
            }
            if (chunk.size() < n || last == null) break;
            upper = previousId(last);
            if (upper == null) break;
        }
        boolean more = stopped && hasMore(last, lower);
        return new Page(items, more ? last : null, scanned, more && items.size() < limit, invalid);
    }

    /** last 보다 오래된 항목이 (lower 안에) 더 있는가. */
    private boolean hasMore(String last, String lower) {
        if (last == null) return false;
        String before = previousId(last);
        return before != null && !source.reverse(before, lower, 1).isEmpty();
    }

    // ---------------------------------------------------------------- 묶음

    public Groups groups(Filter f) {
        String lower = lowerBound(f.since());
        String q = f.q() == null ? null : f.q().toLowerCase(Locale.ROOT);
        Map<String, Acc> acc = new LinkedHashMap<>(); // 처음 만난 순서 = 가장 최근 항목 순서
        int scanned = 0, invalid = 0;
        String upper = null, last = null;
        boolean stopped = false;
        outer:
        while (true) {
            int n = Math.min(CHUNK, SCAN_MAX - scanned);
            List<Raw> chunk = source.reverse(upper, lower, n);
            for (Raw r : chunk) {
                scanned++;
                last = r.id();
                Parsed p = parse(r);
                if (p == null) invalid++;
                else if (matches(f, q, p)) {
                    ObjectNode e = p.node();
                    String service = e.path("service").asString(), fp = e.path("fp").asString();
                    acc.computeIfAbsent(service + "\n" + fp, k -> new Acc(e)).add(e);
                }
                if (scanned >= SCAN_MAX) { stopped = true; break outer; }
            }
            if (chunk.size() < n || last == null) break;
            upper = previousId(last);
            if (upper == null) break;
        }
        List<Group> groups = new ArrayList<>(acc.size());
        for (Acc a : acc.values()) groups.add(a.group());
        return new Groups(groups, scanned, stopped && hasMore(last, lower), invalid);
    }

    /** 한 묶음의 누계. 첫 항목(가장 최근)이 대표값을 정한다. */
    private static final class Acc {
        final String fp, service, level, logger, exceptionType, sample, lastAt, lastId;
        long count, suppressed;
        String firstAt;

        Acc(ObjectNode e) {
            fp = e.path("fp").asString();
            service = e.path("service").asString();
            level = e.path("level").asString();
            logger = e.path("logger").asString();
            JsonNode ex = e.get("exception");
            exceptionType = ex != null && ex.isObject() ? ex.path("type").asString() : null;
            sample = LogEvents.truncate(e.path("message").asString(), SAMPLE_MAX);
            lastAt = e.path("ts").asString();
            lastId = e.path("id").asString();
        }

        void add(ObjectNode e) {
            count++;
            suppressed += Math.max(0, e.path("suppressed").asLong(0));
            firstAt = e.path("ts").asString(); // 거꾸로 읽으므로 마지막에 더한 것이 가장 오래된 것
        }

        Group group() { return new Group(fp, service, level, logger, exceptionType, sample, count, suppressed, firstAt, lastAt, lastId); }
    }

    // ---------------------------------------------------------------- 하나

    /** 항목 하나({id, ...항목}). 없거나(트림) 스키마에 맞지 않으면 null. */
    public JsonNode get(String id) {
        Raw r = source.get(id);
        if (r == null) return null;
        Parsed p = parse(r);
        return p == null ? null : p.node();
    }

    // ---------------------------------------------------------------- 공통

    private static String lowerBound(Instant since) {
        return since == null ? null : Math.max(0, since.toEpochMilli() - SKEW_MS) + "-0";
    }

    /** 검증 → 파싱 → 다시 가림 → {id, ...항목}. 맞지 않으면 null. */
    private Parsed parse(Raw r) {
        if (r.e() == null || schema.validate(r.e()) != null) return null;
        JsonNode n;
        Instant ts;
        try {
            n = JSON.readTree(r.e());
            ts = OffsetDateTime.parse(n.path("ts").asString()).toInstant();
        } catch (RuntimeException e) { // DateTimeParseException 포함
            return null;
        }
        if (!(n instanceof ObjectNode o)) return null;
        remask(o);
        ObjectNode out = JSON.createObjectNode();
        out.put("id", r.id());
        for (var e : o.properties()) out.set(e.getKey(), e.getValue());
        return new Parsed(out, ts);
    }

    /**
     * 가림은 글자 수에 비례하는 시간이고(LogMasker), 칸 길이는 앞의 스키마 검증이 이미 묶는다 — message ≤ 4000 · 예외 메시지 ≤ 2000 ·
     * stack ≤ 12000 · 이름 칸과 context 값 ≤ 200(코드 포인트). 그래서 누구나 보낼 수 있는 web-client 항목으로도 한 번 훑기(3,000건)의 가림
     * 비용이 커지지 않는다(LogReaderTest).
     */
    static void remask(ObjectNode o) {
        maskField(o, "message");
        maskField(o, "logger"); // web-client 는 브라우저가 보낸 component
        maskField(o, "thread");
        if (o.get("exception") instanceof ObjectNode ex) {
            maskField(ex, "type");
            maskField(ex, "message");
            maskField(ex, "stack");
        }
        if (o.get("context") instanceof ObjectNode ctx) for (String k : new ArrayList<>(ctx.propertyNames())) maskField(ctx, k);
    }

    private static void maskField(ObjectNode o, String key) {
        JsonNode v = o.get(key);
        if (v != null && v.isString()) o.put(key, LogMasker.maskAll(v.asString()));
    }

    private static boolean matches(Filter f, String q, Parsed p) {
        ObjectNode e = p.node();
        if (!f.services().isEmpty() && !f.services().contains(e.path("service").asString())) return false;
        if (!f.levels().isEmpty() && !f.levels().contains(e.path("level").asString())) return false;
        if (f.fp() != null && !f.fp().equals(e.path("fp").asString())) return false;
        if (f.rid() != null && !f.rid().equals(e.path("request_id").asString(null))) return false;
        if (f.since() != null && p.ts().isBefore(f.since())) return false;
        if (f.until() != null && p.ts().isAfter(f.until())) return false;
        if (q == null) return true;
        JsonNode ex = e.path("exception");
        for (String s : new String[]{e.path("message").asString(null), e.path("logger").asString(null), ex.path("type").asString(null),
                ex.path("message").asString(null), ex.path("stack").asString(null)})
            if (s != null && s.toLowerCase(Locale.ROOT).contains(q)) return true;
        return false;
    }

    /** 스트림 id(ms-seq — Redis 는 두 칸 모두 부호 없는 64비트) → {ms, seq}. 형식이 틀리거나 64비트를 넘으면 null. */
    public static long[] parseId(String id) {
        int dash = id == null ? -1 : id.indexOf('-');
        if (dash <= 0) return null;
        try {
            return new long[]{Long.parseUnsignedLong(id.substring(0, dash)), Long.parseUnsignedLong(id.substring(dash + 1))};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** 바로 앞의 스트림 id. 0-0 이면 null. 형식이 틀리면 IllegalArgumentException(컨트롤러가 {@link #parseId} 로 먼저 거른다). */
    static String previousId(String id) {
        long[] p = parseId(id);
        if (p == null) throw new IllegalArgumentException("stream id: " + id);
        if (p[1] != 0) return Long.toUnsignedString(p[0]) + "-" + Long.toUnsignedString(p[1] - 1);
        if (p[0] == 0) return null;
        return Long.toUnsignedString(p[0] - 1) + "-" + Long.toUnsignedString(-1L);
    }
}
