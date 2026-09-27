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

/**
 * 스트림 소비 지표(REL-20) — 30 s 마다 XINFO GROUPS·XINFO STREAM 을 읽어 게이지로 낸다(기본 Redis 연결 — 스트림 전용 연결의 BLOCK 에 막히지 않게).
 * <ul>
 *   <li>wakeline_stream_lag{stream}: 그룹 api 에 아직 전달되지 않은 엔트리 수(Redis 7+ XINFO GROUPS lag). Redis 가 셀 수 없으면 NaN.</li>
 *   <li>wakeline_stream_pending{stream}: 전달됐지만 ACK 되지 않은 엔트리 수(PEL) — durable 해지기를 기다리는 메시지 포함.</li>
 *   <li>wakeline_stream_trimmed_entries{stream}: MAXLEN 으로 지워진 엔트리 누계(entries-added − length). 스트림 보존 한도 판단용.</li>
 *   <li>wakeline_stream_unread_trimmed{stream}: 그룹이 읽기 전에 지워진 엔트리 수(entries-added − entries-read − length, 0 미만은 0) —
 *       0 보다 크면 api 가 수집을 따라가지 못해 메시지를 잃은 것이다. 셀 수 없으면 NaN.</li>
 * </ul>
 * 조회 실패(Redis 장애)는 게이지를 NaN 으로 둔다 — 마지막 값을 '현재' 처럼 보이게 두지 않는다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class StreamMetrics {
    private static final Logger log = LoggerFactory.getLogger(StreamMetrics.class);
    static final List<String> STREAMS = List.of(StreamConsumer.S_AIRCRAFT, StreamConsumer.S_SIGMET, StreamConsumer.S_RADAR, StreamConsumer.S_SHIPS);

    /** 한 스트림의 최근 측정값(NaN = 모름). */
    public record Sample(double lag, double pending, double trimmedEntries, double unreadTrimmed) {
        static final Sample UNKNOWN = new Sample(Double.NaN, Double.NaN, Double.NaN, Double.NaN);
    }

    private final StringRedisTemplate redis;
    private final Map<String, Sample> latest = new ConcurrentHashMap<>();

    public StreamMetrics(StringRedisTemplate redis, MeterRegistry meters) {
        this.redis = redis;
        for (String s : STREAMS) {
            latest.put(s, Sample.UNKNOWN);
            Gauge.builder("wakeline_stream_lag", this, m -> m.sample(s).lag()).tag("stream", s)
                    .description("그룹 api 에 아직 전달되지 않은 엔트리 수").register(meters);
            Gauge.builder("wakeline_stream_pending", this, m -> m.sample(s).pending()).tag("stream", s)
                    .description("전달됐지만 ACK 되지 않은 엔트리 수(PEL)").register(meters);
            Gauge.builder("wakeline_stream_trimmed_entries", this, m -> m.sample(s).trimmedEntries()).tag("stream", s)
                    .description("MAXLEN 으로 지워진 엔트리 누계").register(meters);
            Gauge.builder("wakeline_stream_unread_trimmed", this, m -> m.sample(s).unreadTrimmed()).tag("stream", s)
                    .description("그룹이 읽기 전에 지워진 엔트리 수").register(meters);
        }
    }

    public Sample sample(String stream) { return latest.getOrDefault(stream, Sample.UNKNOWN); }

    @Scheduled(initialDelay = 15_000, fixedDelay = 30_000)
    public void refresh() {
        for (String s : STREAMS) {
            try {
                StreamInfo.XInfoStream info = redis.opsForStream().info(s);
                StreamInfo.XInfoGroups groups = redis.opsForStream().groups(s);
                Map<String, Object> group = null;
                if (groups != null) for (StreamInfo.XInfoGroup g : groups) if (StreamConsumer.GROUP.equals(g.groupName())) group = g.getRaw();
                latest.put(s, compute(info == null ? null : info.getRaw(), group));
            } catch (RuntimeException e) {
                latest.put(s, Sample.UNKNOWN);
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
        return new Sample(lag, pending, trimmed, unread);
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
