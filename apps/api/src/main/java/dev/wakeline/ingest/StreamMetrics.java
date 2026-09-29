package dev.wakeline.ingest;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.connection.stream.StreamInfo;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 스트림 소비 지표(REL-20) — 30 s 마다 XINFO GROUPS·XINFO STREAM 을 읽어 게이지로 낸다(기본 Redis 연결 — 스트림 전용 연결의 BLOCK 에 막히지 않게).
 * <ul>
 *   <li>wakeline_stream_lag{stream}: 그룹 api 에 아직 전달되지 않은 엔트리 수(Redis 7+ XINFO GROUPS lag). Redis 가 셀 수 없으면 NaN.</li>
 *   <li>wakeline_stream_pending{stream}: 전달됐지만 ACK 되지 않은 엔트리 수(PEL) — durable 해지기를 기다리는 메시지 포함.</li>
 *   <li>wakeline_stream_trimmed_entries{stream}: MAXLEN 으로 지워진 엔트리 누계(entries-added − length). 스트림 보존 한도 판단용.</li>
 *   <li>wakeline_stream_unread_trimmed{stream}: 그룹이 읽기 전에 지워진 엔트리 수(entries-added − entries-read − length, 0 미만은 0) —
 *       0 보다 크면 api 가 수집을 따라가지 못해 메시지를 잃은 것이다. 셀 수 없으면 NaN.</li>
 *   <li>wakeline_stream_window_seconds{stream}: 스트림 보존 창 = 지금 − 첫 엔트리 id 의 ms(XINFO STREAM first-entry). 첫 엔트리 시각만 30 s
 *       측정에서 기억하고 창은 읽는 시각(스크레이프 · ops/pipeline 요청)에 계산한다 — 요청마다 Redis 를 더 부르지 않는다. 수집기의 시간 트림
 *       (MINID ~ now − 보존 목표)이 이 창을 목표 근처로 유지하고, 바이트 예산 트림(MAXLEN ~)은 창을 줄일 뿐 손실이 아니다(손실은 읽기 전에
 *       지워진 경우 — 위 unread_trimmed · StreamConsumer 의 보존 창 손실). 스트림이 없거나 비었거나 조회에 실패했거나 측정이
 *       {@value #WINDOW_SAMPLE_MAX_AGE_MS} ms 보다 오래됐으면 NaN(ops/pipeline 은 null).</li>
 * </ul>
 * 조회 실패(Redis 장애)는 게이지를 NaN 으로 둔다 — 마지막 값을 '현재' 처럼 보이게 두지 않는다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class StreamMetrics {
    private static final Logger log = LoggerFactory.getLogger(StreamMetrics.class);
    static final List<String> STREAMS = List.of(StreamConsumer.S_AIRCRAFT, StreamConsumer.S_SIGMET, StreamConsumer.S_RADAR, StreamConsumer.S_SHIPS);
    /** 이보다 오래된 측정의 첫 엔트리로는 창을 계산하지 않는다 — 측정이 멈춘 동안(스케줄러 막힘) 앞이 잘렸을 수 있다. 30 s 주기의 4배. */
    public static final long WINDOW_SAMPLE_MAX_AGE_MS = 120_000;
    /** 첫 엔트리 시각이 지금보다 이만큼 넘게 미래면(시계 틀어짐) 믿지 않는다 — 그 안쪽은 0 으로. */
    static final long MAX_FUTURE_MS = 60_000;
    /** 스트림 엔트리 id: &lt;ms&gt;-&lt;seq&gt;. */
    private static final Pattern ENTRY_ID = Pattern.compile("^(\\d{1,15})-\\d{1,20}$");

    /** 한 스트림의 최근 측정값(NaN = 모름). firstEntryMs = 첫 엔트리 id 의 ms(Redis 서버 시계). */
    public record Sample(double lag, double pending, double trimmedEntries, double unreadTrimmed, double firstEntryMs) {
        static final Sample UNKNOWN = new Sample(Double.NaN, Double.NaN, Double.NaN, Double.NaN, Double.NaN);

        /** 첫 엔트리를 모르는 측정. */
        public Sample(double lag, double pending, double trimmedEntries, double unreadTrimmed) {
            this(lag, pending, trimmedEntries, unreadTrimmed, Double.NaN);
        }
    }

    /** 측정값과 그 측정 시각(이 프로세스의 벽시계 ms). */
    private record Measured(Sample sample, long atMs) {}

    private final StringRedisTemplate redis;
    private final LongSupplier clockMs;
    private final Map<String, Measured> latest = new ConcurrentHashMap<>();

    @org.springframework.beans.factory.annotation.Autowired
    public StreamMetrics(StringRedisTemplate redis, MeterRegistry meters) {
        this(redis, meters, System::currentTimeMillis);
    }

    StreamMetrics(StringRedisTemplate redis, MeterRegistry meters, LongSupplier clockMs) {
        this.redis = redis;
        this.clockMs = clockMs;
        for (String s : STREAMS) {
            latest.put(s, new Measured(Sample.UNKNOWN, -1));
            Gauge.builder("wakeline_stream_lag", this, m -> m.sample(s).lag()).tag("stream", s)
                    .description("그룹 api 에 아직 전달되지 않은 엔트리 수").register(meters);
            Gauge.builder("wakeline_stream_pending", this, m -> m.sample(s).pending()).tag("stream", s)
                    .description("전달됐지만 ACK 되지 않은 엔트리 수(PEL)").register(meters);
            Gauge.builder("wakeline_stream_trimmed_entries", this, m -> m.sample(s).trimmedEntries()).tag("stream", s)
                    .description("MAXLEN 으로 지워진 엔트리 누계").register(meters);
            Gauge.builder("wakeline_stream_unread_trimmed", this, m -> m.sample(s).unreadTrimmed()).tag("stream", s)
                    .description("그룹이 읽기 전에 지워진 엔트리 수").register(meters);
            Gauge.builder("wakeline_stream_window_seconds", this, m -> {
                Double w = m.windowSeconds(s, m.clockMs.getAsLong());
                return w == null ? Double.NaN : w;
            }).tag("stream", s).description("스트림 보존 창: 지금 − 첫 엔트리 id 시각(XINFO STREAM first-entry)").register(meters);
        }
    }

    public Sample sample(String stream) {
        Measured m = latest.get(stream);
        return m == null ? Sample.UNKNOWN : m.sample();
    }

    /**
     * 스트림 보존 창(초, 0.1 s 반올림) = nowMs − 최근 측정의 첫 엔트리 시각. 모름(스트림 없음·비었음·조회 실패·측정 전·측정이 오래됨) = null.
     * 창은 부르는 시각에 계산한다 — 측정 사이(최대 30 s)에 앞이 잘렸으면 그만큼 크게 보일 수 있다.
     */
    public Double windowSeconds(String stream, long nowMs) {
        Measured m = latest.get(stream);
        return m == null ? null : window(m.sample().firstEntryMs(), m.atMs(), nowMs);
    }

    /** 첫 엔트리 시각(ms)·측정 시각(ms, 없으면 음수)·지금(ms) → 창(초) 또는 null. */
    static Double window(double firstEntryMs, long sampledAtMs, long nowMs) {
        if (Double.isNaN(firstEntryMs) || sampledAtMs < 0 || nowMs - sampledAtMs > WINDOW_SAMPLE_MAX_AGE_MS) return null;
        double ms = nowMs - firstEntryMs;
        if (ms < -MAX_FUTURE_MS) return null;
        return Math.round(Math.max(0, ms) / 100.0) / 10.0;
    }

    @Scheduled(initialDelay = 15_000, fixedDelay = 30_000)
    public void refresh() {
        for (String s : STREAMS) {
            try {
                StreamInfo.XInfoStream info = redis.opsForStream().info(s);
                StreamInfo.XInfoGroups groups = redis.opsForStream().groups(s);
                Map<String, Object> group = null;
                if (groups != null) for (StreamInfo.XInfoGroup g : groups) if (StreamConsumer.GROUP.equals(g.groupName())) group = g.getRaw();
                latest.put(s, new Measured(compute(info == null ? null : info.getRaw(), group), clockMs.getAsLong()));
            } catch (RuntimeException e) {
                latest.put(s, new Measured(Sample.UNKNOWN, clockMs.getAsLong())); // 없는 스트림(ERR no such key)도 여기 — 모름
                log.debug("stream metrics for {} unavailable: {}", s, e.toString());
            }
        }
    }

    /** XINFO STREAM / XINFO GROUPS(그룹 api 항목)의 원시 값에서 측정값을 만든다. 없는 값은 NaN. */
    static Sample compute(Map<String, Object> stream, Map<String, Object> group) {
        double length = num(stream, "length");
        double added = num(stream, "entries-added");
        double lag = num(group, "lag");
        double pending = num(group, "pending");
        double read = num(group, "entries-read");
        double trimmed = Double.isNaN(added) || Double.isNaN(length) ? Double.NaN : Math.max(0, added - length);
        double unread = Double.isNaN(added) || Double.isNaN(length) || Double.isNaN(read) ? Double.NaN : Math.max(0, added - read - length);
        return new Sample(lag, pending, trimmed, unread, firstEntryMs(stream));
    }

    /**
     * XINFO STREAM 의 first-entry → 그 id 의 ms. Spring 은 [id, [field, value, …]] 를 {id: {field: value}} 로 바꿔 준다(원시 목록 모양도 받는다).
     * 빈 스트림(nil)·형식이 틀린 id 는 NaN.
     */
    static double firstEntryMs(Map<String, Object> stream) {
        if (stream == null) return Double.NaN;
        Object v = stream.get("first-entry");
        Object id = null;
        if (v instanceof Map<?, ?> m && !m.isEmpty()) id = m.keySet().iterator().next();
        else if (v instanceof List<?> l && !l.isEmpty()) id = l.get(0);
        String str = id instanceof byte[] b ? new String(b, StandardCharsets.UTF_8) : id instanceof String x ? x : null;
        if (str == null) return Double.NaN;
        Matcher mt = ENTRY_ID.matcher(str.trim());
        return mt.matches() ? Double.parseDouble(mt.group(1)) : Double.NaN;
    }

    /** 숫자(Long·Integer)·문자열·바이트 배열을 double 로. 없거나(nil) 해석할 수 없으면 NaN. */
    static double num(Map<String, Object> m, String key) {
        if (m == null) return Double.NaN;
        Object v = m.get(key);
        if (v instanceof Number n) return n.doubleValue();
        String str = v instanceof byte[] b ? new String(b, StandardCharsets.UTF_8) : v instanceof String x ? x : null;
        if (str == null) return Double.NaN;
        try { return Double.parseDouble(str.trim()); } catch (NumberFormatException e) { return Double.NaN; }
    }
}
