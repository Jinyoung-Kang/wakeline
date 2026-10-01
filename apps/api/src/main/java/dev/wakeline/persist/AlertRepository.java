package dev.wakeline.persist;

import dev.wakeline.domain.Alert;
import dev.wakeline.engine.AlertStateMachine;
import dev.wakeline.engine.EngineEvents;
import dev.wakeline.ingest.SigmetStore;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.platform.data.Sql;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * alert_event 저장(영구). 모든 쓰기는 {@link OrderedWriter} 한 줄로 받은 순서대로(COR-15·REL-21).
 * <ul>
 *   <li>기동 시 맨 먼저: 이전 실행이 열어 둔 행을 닫는다(left_at = now(), close_reason = 'restart', 계약 §3, REL-4·COR-10).
 *       이 프로세스가 만든 id(≥ 기동 시각 ms × 1000)는 건드리지 않는다 — DB 가 늦게 살아나 나중에 실행돼도 안전하다.</li>
 *   <li>ENTERED/PREDICTED: SIGMET 행 존재만 보장(FK) 후 INSERT. PREDICTION_UPDATED: eta·진입 고도·근거 갱신.
 *       LEFT/LOST/SIGMET_ENDED/PREDICTION_CLEARED: left_at·close_reason·닫힘 근거 기록.</li>
 *   <li>id 로 찾는 UPDATE 는 자연키(hex, sigmet_id, kind)도 함께 맞춘다 — id 가 다른 행을 가리키면(이전 형식 id 충돌) 건드리지 않는다.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Repository
public class AlertRepository {
    private static final Logger log = LoggerFactory.getLogger(AlertRepository.class);
    private final JdbcClient db;
    private final ObjectMapper json;
    private final SigmetRepository sigmets;
    private final SigmetStore sigmetStore;
    private final OrderedWriter writer;
    private final MeterRegistry meters;
    /** 이 프로세스가 만드는 알림 id 의 하한(AlertIds: epochMillis × 1000 + n). 이보다 작은 열린 행은 이전 실행의 것이다. */
    private final long idFloor;

    public AlertRepository(JdbcClient db, ObjectMapper json, SigmetRepository sigmets, SigmetStore sigmetStore, OrderedWriter writer, MeterRegistry meters) {
        this.db = db;
        this.json = json;
        this.sigmets = sigmets;
        this.sigmetStore = sigmetStore;
        this.writer = writer;
        this.meters = meters;
        this.idFloor = System.currentTimeMillis() * 1000;
        // 순서 큐의 첫 작업 — 이 프로세스의 어떤 알림 INSERT 보다 먼저 실행된다
        writer.submit(OrderedWriter.task("alert_reconcile", this::closeOpenFromPreviousRun));
    }

    public record Page(List<Map<String, Object>> items, Long nextCursor) {}

    @EventListener
    public void onAlerts(EngineEvents.AlertsChanged e) {
        for (AlertStateMachine.Event ev : e.events()) writer.submit(OrderedWriter.task("alert", () -> persist(ev)));
    }

    /** 이전 실행이 열어 둔 알림을 닫는다. 재시작으로 추적이 끊긴 것이지 실제 이탈이 아니므로 close_reason = 'restart'(체류 통계에서 뺀다). */
    int closeOpenFromPreviousRun() {
        int n = db.sql("UPDATE alert_event SET left_at = now(), close_reason = :reason WHERE left_at IS NULL AND id < :floor")
                .param("reason", Alert.CLOSE_RESTART).param("floor", idFloor).update();
        log.info("startup: closed {} alerts left open by the previous run (close_reason=restart)", n);
        return n;
    }

    long idFloor() { return idFloor; }

    void persist(AlertStateMachine.Event ev) {
        Alert a = ev.alert();
        int n;
        switch (ev.type()) {
            case ENTERED, PREDICTED -> {
                // SIGMET 행은 세트 수신 때 같은 큐에서 먼저 저장된다. 그래도 없으면(첫 수신 직후 경합 등) 이 경보만 한 번 쓴다.
                sigmets.ensure(sigmetStore.get(a.sigmetId()));
                n = db.sql("""
                        INSERT INTO alert_event (id, hex, callsign, sigmet_id, kind, entered_at, eta_s, alt_ft_at_entry, evidence)
                        VALUES (:id, :hex, :cs, :sig, :kind, :at, :eta, :alt, :ev::jsonb)
                        ON CONFLICT (hex, sigmet_id, kind, entered_at) DO NOTHING""")
                        .param("id", a.id()).param("hex", a.hex()).param("cs", a.callsign()).param("sig", a.sigmetId()).param("kind", a.kind())
                        .param("at", Sql.ts(a.enteredAt())).param("eta", a.etaS()).param("alt", a.altFt()).param("ev", json.writeValueAsString(a.evidence())).update();
            }
            // 예측 갱신은 한 예측의 값(eta·진입 고도·근거)을 함께 바꾼다 — 열 하나만 옛 예측으로 남지 않게(API-CONC-5)
            case PREDICTION_UPDATED -> n = db.sql("""
                    UPDATE alert_event SET eta_s = :eta, alt_ft_at_entry = :alt, evidence = :ev::jsonb
                    WHERE id = :id AND hex = :hex AND sigmet_id = :sig AND kind = :kind AND left_at IS NULL""")
                    .param("eta", a.etaS()).param("alt", a.altFt()).param("ev", json.writeValueAsString(a.evidence()))
                    .param("id", a.id()).param("hex", a.hex()).param("sig", a.sigmetId()).param("kind", a.kind()).update();
            case LEFT, LOST, SIGMET_ENDED, PREDICTION_CLEARED -> n = db.sql("""
                    UPDATE alert_event SET left_at = :left, close_reason = :reason, evidence = :ev::jsonb
                    WHERE id = :id AND hex = :hex AND sigmet_id = :sig AND kind = :kind AND left_at IS NULL""")
                    .param("left", Sql.ts(a.leftAt() == null ? Instant.now() : a.leftAt())).param("reason", closeReason(ev))
                    .param("ev", json.writeValueAsString(a.evidence()))
                    .param("id", a.id()).param("hex", a.hex()).param("sig", a.sigmetId()).param("kind", a.kind()).update();
            default -> n = 1;
        }
        if (n == 0) {
            // INSERT 충돌(같은 자연키·진입 시각) 또는 짝이 되는 INSERT 가 없음(버려짐·이전 실행) — 조용히 넘기지 않고 센다
            meters.counter("wakeline_alert_persist_unmatched_total", "event", ev.type().name()).increment();
            log.debug("alert {} {} matched no row (id={})", ev.type(), a.hex(), a.id());
        }
    }

    /** 닫힘 이유: 엔진이 정한 값, 없으면 이벤트 종류로(LEFT→left, LOST→signal_lost, SIGMET_ENDED→sigmet_ended, CLEARED→prediction_cleared). */
    static String closeReason(AlertStateMachine.Event ev) {
        if (ev.alert().closeReason() != null) return ev.alert().closeReason();
        return switch (ev.type()) {
            case LOST -> Alert.CLOSE_SIGNAL_LOST;
            case SIGMET_ENDED -> Alert.CLOSE_SIGMET_ENDED;
            case PREDICTION_CLEARED -> Alert.CLOSE_PREDICTION_CLEARED;
            default -> Alert.CLOSE_LEFT;
        };
    }

    /**
     * 이력(커서 페이지). close_reason 포함(계약 §2). eta_at 은 새 형식 PREDICTED(근거에 entry·judged_at 이 있는 행)만
     * judged_at + eta_s 로 계산한다 — 이전 엔진은 eta 를 관측 시각에서 쟀으므로 그 행에는 만들지 않는다.
     * hex 가 있으면 hex 조건을 문장에 직접 둔다(R-15): 한 문장이 (hex IS NULL OR e.hex = hex) 로 두 경우를 모두 받으면, 몇 번 실행된 뒤
     * 쓰이는 일반 계획이 hex 인덱스를 쓰지 못해 기간 안의 행을 모두 훑는다. hex 비교는 char(6) 끼리(인덱스 alert_event_hex_id (hex, id DESC)).
     */
    public Page history(Instant from, Instant to, String hex, Long cursor, int limit) {
        var q = Sql.publicRead(db, "alerts.history", """
                SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s,
                       CASE WHEN e.kind = 'PREDICTED' AND e.eta_s IS NOT NULL AND e.evidence->>'entry' IS NOT NULL AND e.evidence->>'judged_at' IS NOT NULL
                            THEN (e.evidence->>'judged_at')::timestamptz + make_interval(secs => e.eta_s) END eta_at,
                       e.alt_ft_at_entry, e.evidence::text evidence
                FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
                WHERE e.entered_at BETWEEN :from AND :to%s AND (:cursor::bigint IS NULL OR e.id < :cursor)
                ORDER BY e.id DESC LIMIT :n""".formatted(hex == null ? "" : " AND e.hex = :hex::bpchar"))
                .param("from", Sql.ts(from)).param("to", Sql.ts(to)).param("cursor", cursor).param("n", limit + 1);
        if (hex != null) q = q.param("hex", hex);
        List<Map<String, Object>> rows = q.query().listOfRows().stream().map(r -> {
            var m = new java.util.LinkedHashMap<>(r);
            Object ev = m.get("evidence");
            m.put("evidence", ev == null ? null : json.readTree(ev.toString()));
            for (String k : List.of("entered_at", "left_at", "eta_at")) m.put(k, TrackRepository.toInstant(m.get(k)));
            m.put("estimated", "PREDICTED".equals(m.get("kind")));
            return (Map<String, Object>) m;
        }).toList();
        Long next = rows.size() > limit ? ((Number) rows.get(limit - 1).get("id")).longValue() : null;
        return new Page(rows.size() > limit ? rows.subList(0, limit) : rows, next);
    }
}
