package dev.wakeline.ops;

import com.fasterxml.jackson.annotation.JsonInclude;
import dev.wakeline.ingest.StreamConsumer;
import dev.wakeline.ingest.StreamMetrics;
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
 *       ·stream_budget_trims(R-14: 바이트 예산 때문에 항공기 스트림을 보존 창보다 일찍 자른 XADD 수, 기동 뒤 누계 — 창을 줄일 뿐 손실이 아니다.
 *       손실은 api 의 stream_trim_loss_events)·stream_retention_s(항공기 스트림 시간 트림 목표, 초 — 수집기 설정)·stream_budget_bytes(항공기
 *       스트림 바이트 예산 — 수집기 설정). heartbeat_age_s = 해시의 가장 최근 *_at 의 나이. heartbeat 가 {@value #COLLECTOR_MAX_AGE_S} s 보다
 *       오래됐으면 값은 null(수집기가 멈춰 마지막 값이 지금 값이 아니다) — 나이는 그대로 싣는다.</li>
 *   <li>ais: ais 상태 해시(wakeline:ais:status)의 dropped_total·quarantined_total·stream_budget_trims·stream_retention_s·stream_budget_bytes
 *       (선박 스트림, R-14). 수신 진단(ADR-014 부록 C — keepalive 1011 원인 가리기): 최근 diag_window_s 초의 최댓값 loop_lag_max_s(이벤트 루프
 *       지연)·queue_wait_max_s(원문 대기열에 머문 시간 — 지금 기다리는 맨 앞 원문 포함)·queue_depth_max(원문 대기열 깊이)·ws_queue_max(websockets
 *       수신 버퍼에 남은 프레임)·ping_rtt_max_s(keepalive 왕복), 누적 loop_stalls_total·reconnects_quick_total(끊겨 열린 공백이 회복 창 안에 닫힌
 *       끊김 — 수집기는 INFO 로만 남긴다). 수집기가 고른 설정(잰 값 아님 — 웹이 숫자를 들고 있지 않게 해시 그대로): ws_queue_limit·queue_limit·
 *       ping_timeout_s·diag_window_s·reconnect_quick_window_s·reconnect_warn_count·reconnect_warn_window_s·loop_tick_s·loop_stall_s·loop_warn_s·
 *       loop_warn_every_s. updated_at 이 {@value #AIS_MAX_AGE_S} s 보다 오래됐으면 null.</li>
 *   <li>api: 이 api 프로세스 기동 뒤 누계 — 메모리 큐 넘침으로 버린 항적·선박 행, 강제로 놓은 영수증, DLQ 로 보낸 메시지, 스트림 보존 창 손실
 *       (R-14) 수와 마지막 손실 구간(없으면 null). 영구 손실도 같이: DB 가 거절해(영구 오류) 재시도하지 않고 버린 항적·선박 행, 처리 중 예외로
 *       건너뛴 스트림 메시지, 이벤트 리스너 오류(알림 저장·팬아웃 등). stream_window_s = 항공기·선박 스트림 보존 창(초): 요청 시각 − 첫 엔트리
 *       id 의 시각(30 s 스트림 지표의 XINFO STREAM first-entry — 요청마다 Redis 를 더 부르지 않는다). 스트림이 없거나 비었거나 모르면 null.</li>
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
    private final ObjectProvider<StreamMetrics> streams;
    private final Supplier<Instant> clock;

    @org.springframework.beans.factory.annotation.Autowired
    public OpsPipelineController(StringRedisTemplate redis, MeterRegistry meters, ObjectProvider<StreamConsumer> consumer,
                                 ObjectProvider<StreamMetrics> streams) {
        this(redis, meters, consumer, streams, Instant::now);
    }

    OpsPipelineController(StringRedisTemplate redis, MeterRegistry meters, ObjectProvider<StreamConsumer> consumer,
                          ObjectProvider<StreamMetrics> streams, Supplier<Instant> clock) {
        this.redis = redis;
        this.meters = meters;
        this.consumer = consumer;
        this.streams = streams;
        this.clock = clock;
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record Pipeline(CollectorSignals collector, AisSignals ais, ApiSignals api, Instant generatedAt) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record CollectorSignals(Long publishDropped, Long dbDropped, Long dbPending, Long streamBudgetTrims, Long streamRetentionS,
                                   Long streamBudgetBytes, Double heartbeatAgeS, Long logSent, Long logDropped) {}

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record AisSignals(Long droppedTotal, Long quarantinedTotal, Long streamBudgetTrims, Long streamRetentionS, Long streamBudgetBytes,
                             Long logSent, Long logDropped, Long reconnectsQuickTotal, Double loopLagMaxS, Long loopStallsTotal,
                             Double queueWaitMaxS, Long wsQueueMax, Long wsQueueLimit, Double pingRttMaxS, Double pingTimeoutS, Long diagWindowS,
                             Long queueDepthMax, Long queueLimit, Double reconnectQuickWindowS, Long reconnectWarnCount, Double reconnectWarnWindowS,
                             Double loopTickS, Double loopStallS, Double loopWarnS, Double loopWarnEveryS) {
        static final AisSignals UNKNOWN = new AisSignals(null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null);
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record ApiSignals(long trackQueueDropped, long shipQueueDropped, long receiptsForceReleased, long dlq, long streamTrimLossEvents,
                             TrimLossWindow lastStreamTrimLoss, long trackRowsFailed, long shipRowsFailed, long streamApplyErrors,
                             long listenerErrors, long logSent, long logDropped, long logSuppressed, StreamWindow streamWindowS) {}

    /** 스트림 보존 창(초): 요청 시각 − 첫 엔트리 id 의 시각. null = 모름(스트림 없음·비었음·측정 없음·오래됨). */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record StreamWindow(Double aircraft, Double ships) {}

    /** 마지막 보존 창 손실: stream, from(모르면 null), to. */
    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record TrimLossWindow(String stream, Instant from, Instant to) {}

    @GetMapping("/pipeline")
    public Pipeline pipeline() {
        Instant now = clock.get();
        return new Pipeline(collector(now), ais(now), api(now), now);
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
        if (age == null || age > COLLECTOR_MAX_AGE_S) return new CollectorSignals(null, null, null, null, null, null, age, null, null);
        return new CollectorSignals(count(h.get("publish_dropped")), count(h.get("db_dropped")), count(h.get("db_pending")),
                count(h.get("stream_budget_trims")), count(h.get("stream_retention_s")), count(h.get("stream_budget_bytes")), age,
                count(h.get("log_sent")), count(h.get("log_dropped")));
    }

    AisSignals ais(Instant now) {
        Map<Object, Object> h = hash("wakeline:ais:status");
        Instant hb = time(h.get("updated_at"));
        long ageS = hb == null ? Long.MAX_VALUE : (now.toEpochMilli() - hb.toEpochMilli()) / 1000;
        if (hb == null || ageS > AIS_MAX_AGE_S || ageS < -MAX_FUTURE_S) return AisSignals.UNKNOWN;
        return new AisSignals(count(h.get("dropped_total")), count(h.get("quarantined_total")), count(h.get("stream_budget_trims")),
                count(h.get("stream_retention_s")), count(h.get("stream_budget_bytes")), count(h.get("log_sent")), count(h.get("log_dropped")),
                count(h.get("reconnects_quick_total")), seconds(h.get("loop_lag_max_s")), count(h.get("loop_stalls_total")),
                seconds(h.get("queue_wait_max_s")), count(h.get("ws_queue_max")), count(h.get("ws_queue_limit")),
                seconds(h.get("ping_rtt_max_s")), seconds(h.get("ping_timeout_s")), count(h.get("diag_window_s")),
                count(h.get("queue_depth_max")), count(h.get("queue_limit")), seconds(h.get("reconnect_quick_window_s")),
                count(h.get("reconnect_warn_count")), seconds(h.get("reconnect_warn_window_s")), seconds(h.get("loop_tick_s")),
                seconds(h.get("loop_stall_s")), seconds(h.get("loop_warn_s")), seconds(h.get("loop_warn_every_s")));
    }

    ApiSignals api(Instant now) {
        StreamConsumer c = consumer.getIfAvailable();
        StreamMetrics m = streams.getIfAvailable();
        long nowMs = now.toEpochMilli();
        StreamWindow window = m == null ? new StreamWindow(null, null)
                : new StreamWindow(m.windowSeconds(StreamConsumer.S_AIRCRAFT, nowMs), m.windowSeconds(StreamConsumer.S_SHIPS, nowMs));
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
                counter("wakeline_log_events_total", "result", "suppressed"),
                window);
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

    /** 0 이상의 십진 초("0.31" · "20")만. 아니면 null(모름 — 빈 값 · 음수 · NaN · 지수 표기). */
    static Double seconds(Object v) {
        if (v == null) return null;
        String s = String.valueOf(v).trim();
        if (!s.matches("^\\d{1,9}(\\.\\d{1,6})?$")) return null;
        return Double.parseDouble(s);
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
