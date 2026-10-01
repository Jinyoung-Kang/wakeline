package dev.wakeline.logs;

import com.fasterxml.jackson.annotation.JsonInclude;
import dev.wakeline.platform.support.LogMasker;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Range;
import org.springframework.data.domain.Range.Bound;
import org.springframework.data.redis.connection.Limit;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.core.RedisCallback;
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
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * 시스템 로그 스트림 읽기(계약 v5 §C4 · §G2). 서버 로그 {@value LogSink#STREAM} 와 브라우저 오류 {@value LogSink#CLIENT_STREAM} 를 스트림 id 순으로
 * 합쳐(같은 id 는 server 가 앞 — {@link LogStream} 선언 순서) 최신 순으로 읽으며 필터를 적용한다. 스트림마다 XREVRANGE 를 {@value #CHUNK}건씩
 * 끊어 읽고, 한 요청이 훑는(합친 순서로 본) 항목은 {@value #SCAN_MAX}건 이하 — 스트림마다 MAXLEN 에 Redis 내부 노드 하나(100)를 더한 합
 * ((3,000 + 100) + (1,000 + 100))이라 근사 트림(MAXLEN ~ — 노드 통째로만 잘라 MAXLEN + 99 건까지 남는다)이 남기는 두 스트림 전체를 한 번에 본다.
 * 브라우저 오류 스트림(api 만 싣는다 — 1,099건 이하)이 가득이어도 서버 로그의 몫을 쓰지 못한다(§G2 의 목적 — 한 스트림 3,000건 상한이면
 * 브라우저 오류 1,000건이 먼저 훑였고, 4,000건 상한이면 두 스트림이 근사 트림 끝일 때 가장 오래된 서버 항목이 빠졌다).
 * <ul>
 *   <li>항목은 {id, stream, ...항목} — stream = "server" | "client". 두 스트림은 id 를 따로 매기므로 id 만으로는 어느 스트림의 항목인지 모른다.</li>
 *   <li>항목마다 스키마 검증(log_event.v1) — 맞지 않거나 필드 e 가 없는 항목은 건너뛰고 invalid 로 센다.</li>
 *   <li>한 번 더 가림(방어적): 메시지 · 로거 · 스레드 · 예외 종류·메시지·스택 · context 문자열 값. 글자 검색은 가린 뒤의 글자로만 한다
 *       (비밀값으로 검색해 그 값이 로그에 있는지 알아내지 못하게).</li>
 *   <li>기간(since · until)은 항목의 ts 로 거른다. 항목의 ts 는 실린 시각(스트림 id)보다 늦을 수 없으므로(같은 호스트 시계) since 보다
 *       {@value #SKEW_MS} ms 앞의 id 에서 읽기를 멈춘다(여유는 시계 차이 대비).</li>
 *   <li>첫 쪽(cursor 없음)과 묶음은 두 스트림의 한 시점 모습 — Redis TIME 앞 밀리초까지만 읽는다({@link #snapshotLanes}). 그 뒤에 실린 항목은
 *       모두 첫 쪽 맨 위보다 새 것이라 웹의 "새 항목"이 찾는다. 첫 쪽 · 새 항목 · cursor 로 이어 읽기를 합치면 빠지거나 겹치는 항목이 없다
 *       (스트림 id 가 Redis 시계보다 {@value #SKEW_MS} ms 넘게 앞서는 때는 빼고 — 그때는 자르지 않는다).</li>
 *   <li>해결 표시(계약 v5 §G14): {@link Resolver} 가 fp 의 유효 해결(upto)을 주면 upto ≥ ts 인 항목이 해결됨이다. 목록 · 묶음은 해결된 항목을
 *       가리거나(hide — 가린 수 hidden_resolved, 쪽 크기는 쓰지 않는다) 보이고(show), 항목마다 resolved = {id, upto, resolved_by} | null 을 싣는다.
 *       upto 뒤의 발생(재발)은 해결되지 않은 항목이다. 스트림은 건드리지 않는다(지우지 않는다).</li>
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
    /**
     * 한 요청이 훑는 항목 상한 = 두 스트림 {@link LogStream#keepMax()} 의 합 (3,000 + 100) + (1,000 + 100) = 4,200 — 근사 트림(MAXLEN ~)이 남기는
     * 두 스트림 전체(각 MAXLEN + 99 까지)를 한 번에 본다(계약 v5 §C4 의 3,000 → §G2 · §G6).
     */
    public static final int SCAN_MAX = (int) (LogStream.SERVER.keepMax() + LogStream.CLIENT.keepMax());
    static final long SKEW_MS = 60_000;
    static final int SAMPLE_MAX = 500;
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(LogReader.class);
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

    /**
     * 목록 쪽: items 는 {id, stream, ...항목, resolved}. hidden_resolved = 이 쪽을 훑으며 가린 해결된 항목 수(필터에 맞은 것만),
     * resolution_state = 해결 기록의 상태({@link Resolver#state()} — ok | stale | unavailable, 해결을 모르는 호출은 null).
     */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Page(List<JsonNode> items, String nextCursor, int scanned, boolean scanTruncated, int invalid, int hiddenResolved,
                       String resolutionState) {}

    /** 항목 · 묶음에 싣는 해결 {id, upto, resolved_by}. */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Resolved(long id, Instant upto, String resolvedBy) {}

    /** fp → 유효 해결(없으면 null). 조회 한 번 동안 같은 값을 준다(한 시점 모습). */
    public interface Resolver {
        Resolved of(String fp);

        /** 해결 기록의 상태(응답 resolution_state) — 모르면 null. */
        default String state() { return null; }

        /** 해결을 모른다: 아무것도 가리지 않는다. */
        Resolver NONE = fp -> null;
    }

    /**
     * fp 묶음: count = 항목 수, suppressed = 항목들의 suppressed 합, first_at · last_at 은 항목의 ts 그대로, 표본은 가장 최근 항목의 메시지.
     * last_id 는 가장 최근 항목의 스트림 id, last_stream 은 그 스트림("server" | "client" — §G2). 셈은 보이는 항목만(hide 면 해결된 항목은 빠진다).
     * resolved(§G14) = 묶음의 모든 항목이 해결됐을 때 그 해결, 하나라도 해결되지 않았으면 null(hide 면 늘 null — 남은 항목은 모두 해결되지 않은 것).
     */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Group(String fp, String service, String level, String logger, String exceptionType, String sampleMessage, long count,
                        long suppressed, String firstAt, String lastAt, String lastId, String lastStream, Resolved resolved) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Groups(List<Group> groups, int scanned, boolean scanTruncated, int invalid, int hiddenResolved, String resolutionState) {}

    private record Parsed(ObjectNode node, Instant ts) {}

    private final Source server;
    private final Source client;
    private final LongSupplier redisNowMs;
    private final LogEventSchema schema = new LogEventSchema();

    @Autowired
    public LogReader(StringRedisTemplate redis) {
        this(redisSource(redis, LogStream.SERVER), redisSource(redis, LogStream.CLIENT), redisClock(redis));
    }

    /** 시험용: 시계 없음 — 모든 항목이 이미 실린 것으로 본다(첫 쪽을 자르지 않는다). */
    LogReader(Source server, Source client) {
        this(server, client, () -> Long.MAX_VALUE);
    }

    /** @param redisNowMs Redis 서버 시각(epoch ms — TIME). 첫 쪽 · 묶음의 윗끝을 정한다({@link #snapshotLanes}). */
    LogReader(Source server, Source client, LongSupplier redisNowMs) {
        this.server = server;
        this.client = client;
        this.redisNowMs = redisNowMs;
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

    /** Redis TIME(ms). 스트림 id 를 매기는 시계와 같은 시계다 — api 호스트의 시계가 아니다. */
    static LongSupplier redisClock(StringRedisTemplate redis) {
        return () -> {
            Long ms = redis.execute((RedisCallback<Long>) c -> c.serverCommands().time(TimeUnit.MILLISECONDS));
            if (ms == null) throw new IllegalStateException("redis TIME returned no value");
            return ms;
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

        /** 윗끝(포함, null = 아무것도 보이지 않음)을 건다: 읽어 둔 것 중 그보다 새 것은 버리고, 다음 조각은 그 아래에서 읽는다. */
        void cap(String top) {
            if (top == null) { buf.clear(); done = true; return; }
            while (!buf.isEmpty() && compareIds(buf.peekFirst().id(), top) > 0) buf.pollFirst();
            if (!done && (upper == null || compareIds(upper, top) > 0)) upper = top;
        }

        /** 합친 순서에서 아직 보지 않은 항목이 (lower 안에) 더 있는가 — 읽어 둔 것이 없으면 한 건만 물어본다. */
        boolean hasMore() {
            return !buf.isEmpty() || (!done && !src.reverse(upper, lower, 1).isEmpty());
        }
    }

    /** 합친 순서의 한 항목. */
    private record Next(LogStream stream, Raw raw) {}

    /**
     * 첫 쪽(cursor 없음) · 묶음은 두 스트림의 한 시점 모습으로 읽는다: Redis TIME(T)을 먼저 읽고, 두 스트림 모두 T 앞 밀리초의 마지막 id
     * ({@code (T-1)-18446744073709551615})까지만 보인다.
     * <p>까닭: 두 스트림은 XREVRANGE 를 따로 부르므로 끝을 '+' 로만 두면 그 사이에 실린 항목이 한쪽에만 보인다 — 서버 스트림을 읽은 뒤 서버 항목 S 와
     * 그보다 새 브라우저 오류 C 가 실리면(api 싱크가 한 묶음을 차례로 XADD) 첫 쪽에는 C 만 있고, S 는 C 보다 오래돼 웹의 "새 항목"
     * (맨 위보다 새 것 — lib/logs.ts pendingEntries)에도 cursor 아래에도 없다. Redis 는 XADD 마다 그 명령의 시각 이상 · 그 스트림 마지막 id 초과의
     * id 를 매기므로(streamNextID) TIME 뒤에 실린 항목의 ms 는 T 이상이다 — T 앞 밀리초까지는 두 스트림 모두 더 늘지 않고, 그 뒤에 실린 것은 모두
     * 첫 쪽 맨 위보다 새 것이다. 밀리초를 통째로 빼는 까닭: 두 스트림은 순번을 따로 매겨 같은 밀리초 안에서는 나중에 실린 항목의 id 가 다른 스트림에
     * 먼저 실린 항목보다 작을 수 있다. T 의 밀리초에 이미 실린 항목은 다음 새로 고침에 "새 항목"으로 보인다.</p>
     * <p>전제는 스트림 id 가 Redis 시계를 따른다는 것이다. 한 스트림의 맨 위 id 가 T 보다 {@value #SKEW_MS} ms 넘게 앞서면(Redis 호스트 시계가 뒤로 감 —
     * 그동안 Redis 는 마지막 id 의 ms 를 이어 쓴다 · id 를 지정한 XADD) 자르지 않고 두 스트림을 끝까지 보인다 — 자르면 새 오류를 시계가 따라잡을
     * 때까지 숨긴다. 그때는 위의 경합을 막지 못한다(새로 읽으면 보인다). 여유 안이면 잘라서 잠깐(그만큼) 늦게 보인다.</p>
     */
    private Lane[] snapshotLanes(String lower) {
        long now = redisNowMs.getAsLong();
        Lane[] ls = {new Lane(LogStream.SERVER, server, null, lower, false), new Lane(LogStream.CLIENT, client, null, lower, false)};
        for (Lane l : ls) {
            Raw head = l.peek(CHUNK);
            if (head != null && Long.compareUnsigned(parseId(head.id())[0], now + SKEW_MS) > 0) {
                log.warn("log stream {} has id {} ahead of the redis clock {} by more than {} ms (clock stepped back, or an XADD with an explicit id)"
                        + " — the first page is not cut at the redis time", l.stream.key(), head.id(), now, SKEW_MS);
                return ls;
            }
        }
        String top = previousId(Long.toUnsignedString(now) + "-0"); // T = 0 이면 null — 그 앞에는 아무것도 없다
        for (Lane l : ls) l.cap(top);
        return ls;
    }

    /** cursor 뒤부터(없으면 처음부터 — {@link #snapshotLanes}) 읽는 두 자리 — 클래스 설명의 이어 읽기 규칙. */
    private Lane[] lanes(Cursor c, String lower) {
        if (c == null) return snapshotLanes(lower);
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

    /** 해결을 모르는 목록(아무것도 가리지 않는다 — 항목의 resolved 는 null). */
    public Page list(Filter f, String cursor, int limit) { return list(f, cursor, limit, Resolver.NONE, false); }

    /**
     * @param cursor 앞 쪽의 next_cursor({@link #parseCursor} 로 읽을 수 있어야 한다 — 컨트롤러가 먼저 거른다)
     * @param hideResolved true 면 해결된 항목을 빼고 hidden_resolved 로 센다(쪽 크기에 들지 않는다 — 훑은 수에는 든다)
     */
    public Page list(Filter f, String cursor, int limit, Resolver resolver, boolean hideResolved) {
        Cursor c = null;
        if (cursor != null && (c = parseCursor(cursor)) == null) throw new IllegalArgumentException("cursor: " + cursor);
        String lower = lowerBound(f.since());
        Lane[] lanes = lanes(c, lower);
        String q = f.q() == null ? null : f.q().toLowerCase(Locale.ROOT);
        List<JsonNode> items = new ArrayList<>();
        int scanned = 0, invalid = 0, hidden = 0;
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
            else if (matches(f, q, p)) {
                Resolved r = covering(resolver, p);
                if (r != null && hideResolved) hidden++;
                else items.add(annotate(p.node(), r));
            }
            if (items.size() >= limit) { stopped = true; break; }
        }
        boolean more = stopped && last != null && hasMore(lanes);
        return new Page(items, more ? new Cursor(last.stream(), last.raw().id()).encode() : null, scanned, more && items.size() < limit, invalid,
                hidden, resolver.state());
    }

    // ---------------------------------------------------------------- 묶음

    /** 해결을 모르는 묶음(아무것도 가리지 않는다). */
    public Groups groups(Filter f) { return groups(f, Resolver.NONE, false); }

    /** @param hideResolved true 면 해결된 항목을 셈에서 빼고(모두 해결된 묶음은 없다) hidden_resolved 로 센다 */
    public Groups groups(Filter f, Resolver resolver, boolean hideResolved) {
        Lane[] lanes = lanes(null, lowerBound(f.since()));
        String q = f.q() == null ? null : f.q().toLowerCase(Locale.ROOT);
        Map<String, Acc> acc = new LinkedHashMap<>(); // 처음 만난 순서 = 가장 최근 항목 순서
        int scanned = 0, invalid = 0, hidden = 0;
        boolean stopped = false;
        while (true) {
            if (scanned >= SCAN_MAX) { stopped = true; break; }
            Next n = next(lanes, SCAN_MAX - scanned);
            if (n == null) break;
            scanned++;
            Parsed p = parse(n.stream(), n.raw());
            if (p == null) invalid++;
            else if (matches(f, q, p)) {
                Resolved r = covering(resolver, p);
                if (r != null && hideResolved) { hidden++; continue; }
                ObjectNode e = p.node();
                String service = e.path("service").asString(), fp = e.path("fp").asString();
                acc.computeIfAbsent(service + "\n" + fp, k -> new Acc(e, r)).add(e, r);
            }
        }
        List<Group> groups = new ArrayList<>(acc.size());
        for (Acc a : acc.values()) groups.add(a.group());
        return new Groups(groups, scanned, stopped && hasMore(lanes), invalid, hidden, resolver.state());
    }

    /** 한 묶음의 누계. 첫 항목(가장 최근)이 대표값을 정한다. */
    private static final class Acc {
        final String fp, service, level, logger, exceptionType, sample, lastAt, lastId, lastStream;
        long count, suppressed;
        String firstAt;
        /** 지금까지 더한 항목이 모두 해결됐으면 그 해결(같은 fp — 유효 해결은 하나), 하나라도 아니면 null. */
        Resolved resolved;

        Acc(ObjectNode e, Resolved first) {
            resolved = first;
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

        void add(ObjectNode e, Resolved r) {
            if (r == null) resolved = null; // 뒤늦게 실린 항목은 ts 가 스트림 순서와 다를 수 있다 — 맨 위 하나로 판단하지 않는다
            count++;
            suppressed += Math.max(0, e.path("suppressed").asLong(0));
            firstAt = e.path("ts").asString(); // 거꾸로 읽으므로 마지막에 더한 것이 가장 오래된 것
        }

        Group group() {
            return new Group(fp, service, level, logger, exceptionType, sample, count, suppressed, firstAt, lastAt, lastId, lastStream, resolved);
        }
    }

    // ---------------------------------------------------------------- 하나

    /** 항목 하나({id, stream, ...항목, resolved}) — server → client 순으로 찾는다(§G2). 둘 다 없거나(트림) 스키마에 맞지 않으면 null. */
    public JsonNode get(String id) { return get(id, null, Resolver.NONE); }

    /** 그 스트림의 항목 하나. 없거나 스키마에 맞지 않으면 null. */
    public JsonNode get(String id, LogStream stream) { return get(id, stream, Resolver.NONE); }

    /**
     * 항목 하나 + resolved(§G14 — 해결됐는지와 무관하게 늘 돌려준다: 가리지 않는다). only 가 null 이면 server → client 순, 아니면 그 스트림만.
     * 없거나 스키마에 맞지 않으면 null.
     */
    public JsonNode get(String id, LogStream only, Resolver resolver) {
        for (LogStream s : only == null ? LogStream.values() : new LogStream[]{only}) {
            Raw r = source(s).get(id);
            if (r == null) continue;
            Parsed p = parse(s, r);
            if (p != null) return annotate(p.node(), covering(resolver, p));
        }
        return null;
    }

    // ---------------------------------------------------------------- 공통

    /** 이 항목을 덮는 해결(fp 의 유효 해결이 있고 upto ≥ ts) — 없으면 null. */
    private static Resolved covering(Resolver resolver, Parsed p) {
        Resolved r = resolver.of(p.node().path("fp").asString(null));
        return r != null && !p.ts().isAfter(r.upto()) ? r : null;
    }

    /** 항목에 resolved 를 싣는다(없으면 명시적 null — 키를 빼지 않는다). */
    private static ObjectNode annotate(ObjectNode node, Resolved r) {
        if (r == null) node.putNull("resolved");
        else {
            ObjectNode o = node.putObject("resolved");
            o.put("id", r.id());
            o.put("upto", r.upto().toString());
            o.put("resolved_by", r.resolvedBy());
        }
        return node;
    }

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
     * stack ≤ 12000 · 이름 칸과 context 값 ≤ 200(코드 포인트). 그래서 누구나 보낼 수 있는 web-client 항목으로도 한 번 훑기(두 스트림 합 {@value #SCAN_MAX}건)의 가림
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
