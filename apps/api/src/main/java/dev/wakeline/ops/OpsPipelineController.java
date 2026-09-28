package dev.wakeline.ops;

import com.fasterxml.jackson.annotation.JsonInclude;
import dev.wakeline.ingest.StreamConsumer;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Map;
import java.util.function.Supplier;

/**
 * 데이터 손실 신호(R-18 · ADR-017 §4): 운영자가 드롭·트림·저장 실패를 한곳에서 본다. 인증·인가는 다른 운영 GET 과 같다(/api/v1/ops/**:
 * 운영 세션 필요, 익명은 404, GET 은 CSRF 헤더 없이).
 * <ul>
 *   <li>collector: 수집기 heartbeat 해시(wakeline:collector)의 publish_dropped·db_dropped·db_pending(수집기 프로세스 기동 뒤 누계·현재 대기 수)
 *       ·stream_budget_trims(R-14: 바이트 예산 때문에 항공기 스트림을 보존 창보다 일찍 자른 XADD 수, 기동 뒤 누계).
 *       heartbeat_age_s = 해시의 가장 최근 *_at 의 나이. heartbeat 가 {@value #COLLECTOR_MAX_AGE_S} s 보다 오래됐으면 값은 null(수집기가 멈춰
 *       마지막 값이 지금 값이 아니다) — 나이는 그대로 싣는다.</li>
 *   <li>ais: ais 상태 해시(wakeline:ais:status)의 dropped_total·quarantined_total·stream_budget_trims(선박 스트림, R-14).
 *       updated_at 이 {@value #AIS_MAX_AGE_S} s 보다 오래됐으면 null.</li>
 *   <li>api: 이 api 프로세스 기동 뒤 누계 — 메모리 큐 넘침으로 버린 항적·선박 행, 강제로 놓은 영수증, DLQ 로 보낸 메시지, 스트림 보존 창 손실
 *       (R-14) 수와 마지막 손실 구간(없으면 null). 영구 손실도 같이: DB 가 거절해(영구 오류) 재시도하지 않고 버린 항적·선박 행, 처리 중 예외로
 *       건너뛴 스트림 메시지, 이벤트 리스너 오류(알림 저장·팬아웃 등).</li>
 *   <li>시스템 로그 싱크(계약 v5 §C2): 세 프로세스 모두 log_sent(wakeline:logs 에 실은 항목 — api 는 wakeline:logs:client 에 실은 브라우저 오류 포함, §G2) ·
 *       log_dropped(대기열 상한·종료로 버린 항목 · 억제 중에 지문 표에서 잊히거나 항목을 만들지 못한 발생 — §G9),
 *       기동 뒤 누계. collector·ais 는 위 해시의 같은 이름 필드(같은 신선도 규칙), api 는 wakeline_log_events_total{result} 에 log_suppressed
 *       (같은 지문 10 s 억제로 따로 싣지 않고 다른 항목의 suppressed 에 실은 수 — 손실이 아니라 묶음 요약. 다음 항목이 오지 않으면 창이 닫힐 때
 *       마지막 억제 발생이 항목이 된다 — §G9)까지.</li>
 * </ul>
 * null = 모름(해시·필드가 없거나 형식이 틀림 · heartbeat 가 오래됨 · Redis 를 읽지 못함). 0 으로 채우지 않는다. 해시는 읽기만 한다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/ops")
public class OpsPipelineController {
    /** 수집기 heartbeat 신선도(공개 /status 의 adsb_fi_rps_1m 과 같은 기준). */
    static final long COLLECTOR_MAX_AGE_S = 120;
    /** ais 는 5 s 마다 쓴다(AisStatus 와 같은 기준). */
    static final long AIS_MAX_AGE_S = 30;
    /** 미래로 이보다 틀어진 시각은 믿지 않는다. */
    static final long MAX_FUTURE_S = 60;

    private final StringRedisTemplate redis;
    private final MeterRegistry meters;
    private final ObjectProvider<StreamConsumer> consumer;
    private final Supplier<Instant> clock;

    @org.springframework.beans.factory.annotation.Autowired
    public OpsPipelineController(StringRedisTemplate redis, MeterRegistry meters, ObjectProvider<StreamConsumer> consumer) {
        this(redis, meters, consumer, Instant::now);
    }

    OpsPipelineController(StringRedisTemplate redis, MeterRegistry meters, ObjectProvider<StreamConsumer> consumer, Supplier<Instant> clock) {
        this.redis = redis;
        this.meters = meters;
        this.consumer = consumer;
        this.clock = clock;
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Pipeline(CollectorSignals collector, AisSignals ais, ApiSignals api, Instant generatedAt) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record CollectorSignals(Long publishDropped, Long dbDropped, Long dbPending, Long streamBudgetTrims, Double heartbeatAgeS,
                                   Long logSent, Long logDropped) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record AisSignals(Long droppedTotal, Long quarantinedTotal, Long streamBudgetTrims, Long logSent, Long logDropped) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record ApiSignals(long trackQueueDropped, long shipQueueDropped, long receiptsForceReleased, long dlq, long streamTrimLossEvents,
                             TrimLossWindow lastStreamTrimLoss, long trackRowsFailed, long shipRowsFailed, long streamApplyErrors,
                             long listenerErrors, long logSent, long logDropped, long logSuppressed) {}

    /** 마지막 보존 창 손실: stream, from(모르면 null), to. */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record TrimLossWindow(String stream, Instant from, Instant to) {}

    @GetMapping("/pipeline")
    public Pipeline pipeline() {
        Instant now = clock.get();
        return new Pipeline(collector(now), ais(now), api(), now);
    }

    CollectorSignals collector(Instant now) {
        Map<Object, Object> h = hash("wakeline:collector");
        Double age = null;
        Instant newest = null;
        for (var e : h.entrySet()) {
            if (!String.valueOf(e.getKey()).endsWith("_at")) continue;
            Instant t = time(e.getValue());
            if (t != null && (newest == null || t.isAfter(newest))) newest = t;
        }
        if (newest != null) {
            double s = (now.toEpochMilli() - newest.toEpochMilli()) / 1000.0;
            if (s >= -MAX_FUTURE_S) age = Math.round(Math.max(0, s) * 10) / 10.0;
        }
        if (age == null || age > COLLECTOR_MAX_AGE_S) return new CollectorSignals(null, null, null, null, age, null, null);
        return new CollectorSignals(count(h.get("publish_dropped")), count(h.get("db_dropped")), count(h.get("db_pending")),
                count(h.get("stream_budget_trims")), age, count(h.get("log_sent")), count(h.get("log_dropped")));
    }

    AisSignals ais(Instant now) {
        Map<Object, Object> h = hash("wakeline:ais:status");
        Instant hb = time(h.get("updated_at"));
        long ageS = hb == null ? Long.MAX_VALUE : (now.toEpochMilli() - hb.toEpochMilli()) / 1000;
        if (hb == null || ageS > AIS_MAX_AGE_S || ageS < -MAX_FUTURE_S) return new AisSignals(null, null, null, null, null);
        return new AisSignals(count(h.get("dropped_total")), count(h.get("quarantined_total")), count(h.get("stream_budget_trims")),
                count(h.get("log_sent")), count(h.get("log_dropped")));
    }

    ApiSignals api() {
        StreamConsumer c = consumer.getIfAvailable();
        long events = c == null ? 0 : c.trimLossEvents();
        StreamConsumer.TrimLoss last = c == null ? null : c.lastTrimLoss();
        return new ApiSignals(
                counter("wakeline_track_rows_total", "result", "dropped"),
                counter("wakeline_ship_rows_total", "result", "dropped"),
                counter("wakeline_track_receipts_forced_total") + counter("wakeline_ship_receipts_forced_total"),
                counter("wakeline_stream_messages_total", "result", "rejected"),
                events,
                last == null ? null : new TrimLossWindow(last.stream(), last.from(), last.to()),
                counter("wakeline_track_rows_total", "result", "failed"),
                counter("wakeline_ship_rows_total", "result", "failed"),
                counter("wakeline_stream_messages_total", "result", "apply_error"),
                counter("wakeline_event_listener_errors_total"),
                counter("wakeline_log_events_total", "result", "sent"),
                counter("wakeline_log_events_total", "result", "dropped"),
                counter("wakeline_log_events_total", "result", "suppressed"));
    }

    private long counter(String name, String... tags) {
        var search = meters.find(name);
        if (tags.length > 0) search = search.tags(tags);
        double sum = 0;
        for (Counter c : search.counters()) sum += c.count();
        return (long) sum;
    }

    private Map<Object, Object> hash(String key) {
        try {
            Map<Object, Object> h = redis.opsForHash().entries(key);
            return h == null ? Map.of() : h;
        } catch (RuntimeException e) {
            return Map.of(); // Redis 를 읽지 못하면 모두 모름
        }
    }

    /** 0 이상의 정수 문자열만. 아니면 null(모름). */
    static Long count(Object v) {
        if (v == null) return null;
        String s = String.valueOf(v).trim();
        if (!s.matches("^\\d{1,18}$")) return null;
        return Long.parseLong(s);
    }

    /** 시간대가 있는 ISO 시각만. 아니면 null. */
    static Instant time(Object v) {
        if (v == null) return null;
        try {
            return java.time.OffsetDateTime.parse(String.valueOf(v).trim()).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
