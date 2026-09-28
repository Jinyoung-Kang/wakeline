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
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 시스템 로그 스트림 읽기(계약 v5 §C4 · §G2). 서버 로그 {@value LogSink#STREAM} 와 브라우저 오류 {@value LogSink#CLIENT_STREAM} 를 스트림 id 순으로
 * 합쳐(같은 id 는 server 가 앞 — {@link LogStream} 선언 순서) 최신 순으로 읽으며 필터를 적용한다. 스트림마다 XREVRANGE 를 {@value #CHUNK}건씩
 * 끊어 읽고, 한 요청이 훑는(합친 순서로 본) 항목은 {@value #SCAN_MAX}건 이하 — 두 스트림 MAXLEN 의 합(3,000 + 1,000)이라 보통은 두 스트림 전체이고,
 * 브라우저 오류 스트림이 가득이어도 서버 로그의 몫을 쓰지 못한다(§G2 의 목적 — 한 스트림 3,000건 상한이면 브라우저 오류 1,000건이 먼저 훑였다).
 * <ul>
 *   <li>항목은 {id, stream, ...항목} — stream = "server" | "client". 두 스트림은 id 를 따로 매기므로 id 만으로는 어느 스트림의 항목인지 모른다.</li>
 *   <li>항목마다 스키마 검증(log_event.v1) — 맞지 않거나 필드 e 가 없는 항목은 건너뛰고 invalid 로 센다.</li>
 *   <li>한 번 더 가림(방어적): 메시지 · 로거 · 스레드 · 예외 종류·메시지·스택 · context 문자열 값. 글자 검색은 가린 뒤의 글자로만 한다
 *       (비밀값으로 검색해 그 값이 로그에 있는지 알아내지 못하게).</li>
 *   <li>기간(since · until)은 항목의 ts 로 거른다. 항목의 ts 는 실린 시각(스트림 id)보다 늦을 수 없으므로(같은 호스트 시계) since 보다
 *       {@value #SKEW_MS} ms 앞의 id 에서 읽기를 멈춘다(여유는 시계 차이 대비).</li>
 *   <li>cursor = "{stream}:{id}" — 합친 순서에서 마지막으로 본 항목(그 항목은 빼고 이어 읽는다). 쪽이 차서 멈추면 마지막 항목, 훑기 상한에 걸려
 *       멈추면 마지막으로 훑은 항목(scan_truncated) — 같은 항목을 다시 훑지 않고 이어 간다. 더 없으면 null. 이어 읽기: server 항목 뒤면 server 는
 *       그 id 앞부터 · client 는 그 id 부터(같은 id 는 server 가 앞), client 항목 뒤면 두 스트림 모두 그 id 앞부터. 스트림 id 만 있는 cursor(§G2 전)는
 *       server 의 것으로 읽는다.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class LogReader {
    static final int CHUNK = 200;
    /** 한 요청이 훑는 항목 상한 = 두 스트림 MAXLEN 의 합(계약 v5 §C4 의 3,000 에 §G2 의 브라우저 오류 스트림 1,000 을 더한다). */
    public static final int SCAN_MAX = (int) (LogSink.MAXLEN + LogSink.CLIENT_MAXLEN);
    static final long SKEW_MS = 60_000;
    static final int SAMPLE_MAX = 500;
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Pattern STREAM_ID = Pattern.compile("\\d{1,20}-\\d{1,20}");

    /** 스트림 하나 접근(시험에서 메모리 스트림으로 바꾼다). */
    public interface Source {
        /** XREVRANGE: endInclusive(null = '+')부터 startInclusive(null = '-')까지 최신 순 최대 count 건. */
        List<Raw> reverse(String endInclusive, String startInclusive, int count);

        /** XRANGE id id — 없으면(트림됨) null. */
        Raw get(String id);
    }

    /** 스트림 항목 하나: id 와 필드 e(없으면 null). */
    public record Raw(String id, String e) {}

    /** 합친 순서의 한 자리: 어느 스트림의 어느 id. 문자열로는 "{stream}:{id}". */
    public record Cursor(LogStream stream, String id) {
        public String encode() { return stream.label() + ":" + id; }
    }

    /**
     * 필터. services · levels 가 비어 있으면 모두. q 는 대소문자 무시 부분 일치(메시지 · 로거 · 예외 종류·메시지·스택).
     * fp · rid 는 정확히 일치. since · until 은 ts 기준 양 끝 포함.
     */
    public record Filter(Set<String> services, Set<String> levels, String q, String fp, String rid, Instant since, Instant until) {}

    /** 목록 쪽: items 는 {id, stream, ...항목}. */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Page(List<JsonNode> items, String nextCursor, int scanned, boolean scanTruncated, int invalid) {}

    /**
     * fp 묶음: count = 항목 수, suppressed = 항목들의 suppressed 합, first_at · last_at 은 항목의 ts 그대로, 표본은 가장 최근 항목의 메시지.
     * last_id 는 가장 최근 항목의 스트림 id, last_stream 은 그 스트림("server" | "client" — §G2).
     */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Group(String fp, String service, String level, String logger, String exceptionType, String sampleMessage, long count,
                        long suppressed, String firstAt, String lastAt, String lastId, String lastStream) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Groups(List<Group> groups, int scanned, boolean scanTruncated, int invalid) {}

    private record Parsed(ObjectNode node, Instant ts) {}

    private final Source server;
    private final Source client;
    private final LogEventSchema schema = new LogEventSchema();

    @Autowired
    public LogReader(StringRedisTemplate redis) { this(redisSource(redis, LogStream.SERVER), redisSource(redis, LogStream.CLIENT)); }

    LogReader(Source server, Source client) {
        this.server = server;
        this.client = client;
    }

    private Source source(LogStream s) { return s == LogStream.SERVER ? server : client; }

    static Source redisSource(StringRedisTemplate redis, LogStream stream) {
        return new Source() {
            @Override
            public List<Raw> reverse(String endInclusive, String startInclusive, int count) {
                Range<String> range = Range.of(startInclusive == null ? Bound.unbounded() : Bound.inclusive(startInclusive),
                        endInclusive == null ? Bound.unbounded() : Bound.inclusive(endInclusive));
                List<MapRecord<String, Object, Object>> recs = redis.opsForStream().reverseRange(stream.key(), range, Limit.limit().count(count));
                List<Raw> out = new ArrayList<>(recs == null ? 0 : recs.size());
                if (recs != null) for (var r : recs) out.add(raw(r));
                return out;
            }

            @Override
            public Raw get(String id) {
                var recs = redis.opsForStream().range(stream.key(), Range.closed(id, id), Limit.limit().count(1));
                return recs == null || recs.isEmpty() ? null : raw(recs.getFirst());
            }
        };
    }

    private static Raw raw(MapRecord<String, Object, Object> r) {
        Object e = r.getValue().get("e");
        return new Raw(r.getId().getValue(), e == null ? null : String.valueOf(e));
    }

    // ---------------------------------------------------------------- 두 스트림 합치기

    /** 스트림 하나를 최신 순으로 끊어 읽는 자리. upper = 다음에 읽을 끝(포함, null = '+'). 읽었지만 아직 합치지 않은 항목은 buf 에. */
    private static final class Lane {
        final LogStream stream;
        final Source src;
        final String lower;
        final ArrayDeque<Raw> buf = new ArrayDeque<>();
        String upper;
        boolean done;

        Lane(LogStream stream, Source src, String upper, String lower, boolean empty) {
            this.stream = stream;
            this.src = src;
            this.upper = upper;
            this.lower = lower;
            this.done = empty;
        }

        /** 맨 앞 항목(없으면 null). 비었으면 한 조각(want 건 이하 — 훑기 상한까지 남은 수)을 더 읽는다. */
        Raw peek(int want) {
            if (buf.isEmpty() && !done) {
                int n = Math.max(1, Math.min(CHUNK, want));
                List<Raw> chunk = src.reverse(upper, lower, n);
                buf.addAll(chunk);
                if (chunk.size() < n) done = true;
                else if ((upper = previousId(chunk.getLast().id())) == null) done = true;
            }
            return buf.peekFirst();
        }

        /** 합친 순서에서 아직 보지 않은 항목이 (lower 안에) 더 있는가 — 읽어 둔 것이 없으면 한 건만 물어본다. */
        boolean hasMore() {
            return !buf.isEmpty() || (!done && !src.reverse(upper, lower, 1).isEmpty());
        }
    }

    /** 합친 순서의 한 항목. */
    private record Next(LogStream stream, Raw raw) {}

    /** cursor 뒤부터(없으면 처음부터) 읽는 두 자리 — 클래스 설명의 이어 읽기 규칙. */
    private Lane[] lanes(Cursor c, String lower) {
        if (c == null) return new Lane[]{new Lane(LogStream.SERVER, server, null, lower, false), new Lane(LogStream.CLIENT, client, null, lower, false)};
        String before = previousId(c.id()); // 0-0 이면 null — 그 앞에는 아무것도 없다
        String clientUpper = c.stream() == LogStream.SERVER ? c.id() : before;
        return new Lane[]{new Lane(LogStream.SERVER, server, before, lower, before == null),
                new Lane(LogStream.CLIENT, client, clientUpper, lower, clientUpper == null)};
    }

    /** 두 자리 중 합친 순서로 다음 항목(더 큰 id, 같으면 server)을 꺼낸다. 없으면 null. */
    private static Next next(Lane[] lanes, int want) {
        Lane pick = null;
        Raw head = null;
        for (Lane l : lanes) {
            Raw r = l.peek(want);
            if (r != null && (head == null || compareIds(r.id(), head.id()) > 0)) { pick = l; head = r; } // 같은 id 는 앞 자리(server)
        }
        return pick == null ? null : new Next(pick.stream, pick.buf.pollFirst());
    }

    private static boolean hasMore(Lane[] lanes) {
        for (Lane l : lanes) if (l.hasMore()) return true;
        return false;
    }

    // ---------------------------------------------------------------- 목록

    /** @param cursor 앞 쪽의 next_cursor({@link #parseCursor} 로 읽을 수 있어야 한다 — 컨트롤러가 먼저 거른다) */
    public Page list(Filter f, String cursor, int limit) {
        Cursor c = null;
        if (cursor != null && (c = parseCursor(cursor)) == null) throw new IllegalArgumentException("cursor: " + cursor);
        String lower = lowerBound(f.since());
        Lane[] lanes = lanes(c, lower);
        String q = f.q() == null ? null : f.q().toLowerCase(Locale.ROOT);
        List<JsonNode> items = new ArrayList<>();
        int scanned = 0, invalid = 0;
        Next last = null;
        boolean stopped = false;
        while (true) {
            if (scanned >= SCAN_MAX) { stopped = true; break; }
            Next n = next(lanes, SCAN_MAX - scanned);
            if (n == null) break;
            scanned++;
            last = n;
            Parsed p = parse(n.stream(), n.raw());
            if (p == null) invalid++;
            else if (matches(f, q, p)) items.add(p.node());
            if (items.size() >= limit) { stopped = true; break; }
        }
        boolean more = stopped && last != null && hasMore(lanes);
        return new Page(items, more ? new Cursor(last.stream(), last.raw().id()).encode() : null, scanned, more && items.size() < limit, invalid);
    }

    // ---------------------------------------------------------------- 묶음

    public Groups groups(Filter f) {
        Lane[] lanes = lanes(null, lowerBound(f.since()));
        String q = f.q() == null ? null : f.q().toLowerCase(Locale.ROOT);
        Map<String, Acc> acc = new LinkedHashMap<>(); // 처음 만난 순서 = 가장 최근 항목 순서
        int scanned = 0, invalid = 0;
        boolean stopped = false;
        while (true) {
            if (scanned >= SCAN_MAX) { stopped = true; break; }
            Next n = next(lanes, SCAN_MAX - scanned);
            if (n == null) break;
            scanned++;
            Parsed p = parse(n.stream(), n.raw());
            if (p == null) invalid++;
            else if (matches(f, q, p)) {
                ObjectNode e = p.node();
                String service = e.path("service").asString(), fp = e.path("fp").asString();
                acc.computeIfAbsent(service + "\n" + fp, k -> new Acc(e)).add(e);
            }
        }
        List<Group> groups = new ArrayList<>(acc.size());
        for (Acc a : acc.values()) groups.add(a.group());
        return new Groups(groups, scanned, stopped && hasMore(lanes), invalid);
    }

    /** 한 묶음의 누계. 첫 항목(가장 최근)이 대표값을 정한다. */
    private static final class Acc {
        final String fp, service, level, logger, exceptionType, sample, lastAt, lastId, lastStream;
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
            lastStream = e.path("stream").asString();
        }

        void add(ObjectNode e) {
            count++;
            suppressed += Math.max(0, e.path("suppressed").asLong(0));
            firstAt = e.path("ts").asString(); // 거꾸로 읽으므로 마지막에 더한 것이 가장 오래된 것
        }

        Group group() { return new Group(fp, service, level, logger, exceptionType, sample, count, suppressed, firstAt, lastAt, lastId, lastStream); }
    }

    // ---------------------------------------------------------------- 하나

    /** 항목 하나({id, stream, ...항목}) — server → client 순으로 찾는다(§G2). 둘 다 없거나(트림) 스키마에 맞지 않으면 null. */
    public JsonNode get(String id) {
        for (LogStream s : LogStream.values()) {
            JsonNode n = get(id, s);
            if (n != null) return n;
        }
        return null;
    }

    /** 그 스트림의 항목 하나. 없거나 스키마에 맞지 않으면 null. */
    public JsonNode get(String id, LogStream stream) {
        Raw r = source(stream).get(id);
        if (r == null) return null;
        Parsed p = parse(stream, r);
        return p == null ? null : p.node();
    }

    // ---------------------------------------------------------------- 공통

    private static String lowerBound(Instant since) {
        return since == null ? null : Math.max(0, since.toEpochMilli() - SKEW_MS) + "-0";
    }

    /** 검증 → 파싱 → 다시 가림 → {id, stream, ...항목}. 맞지 않으면 null. */
    private Parsed parse(LogStream stream, Raw r) {
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
        out.put("stream", stream.label());
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

    /**
     * cursor("{stream}:{id}", 또는 §G2 전의 "{id}" = server) → {@link Cursor}. 스트림 이름이 틀리거나 id 가 스트림 id 모양이 아니거나
     * 부호 없는 64비트를 넘으면 null.
     */
    public static Cursor parseCursor(String s) {
        if (s == null) return null;
        LogStream stream = LogStream.SERVER;
        String id = s;
        int colon = s.indexOf(':');
        if (colon >= 0) {
            stream = LogStream.ofLabel(s.substring(0, colon));
            id = s.substring(colon + 1);
            if (stream == null) return null;
        }
        return STREAM_ID.matcher(id).matches() && parseId(id) != null ? new Cursor(stream, id) : null;
    }

    /** 스트림 id 비교(ms, 그다음 순번 — 부호 없는 64비트). 둘 다 {@link #parseId} 로 읽을 수 있어야 한다. */
    static int compareIds(String a, String b) {
        long[] x = parseId(a), y = parseId(b);
        int c = Long.compareUnsigned(x[0], y[0]);
        return c != 0 ? c : Long.compareUnsigned(x[1], y[1]);
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
