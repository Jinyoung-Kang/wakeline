package dev.skywx.persist;

import dev.skywx.domain.Alert;
import dev.skywx.engine.AlertStateMachine;
import dev.skywx.engine.EngineEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** alert_event 저장(영구). ENTERED/PREDICTED 는 INSERT, LEFT/CLEARED 는 left_at 갱신. evidence NOT NULL. */
@Repository
public class AlertRepository {
    private static final Logger log = LoggerFactory.getLogger(AlertRepository.class);
    private final JdbcClient db;
    private final ObjectMapper json;
    private final SigmetRepository sigmets;
    private final dev.skywx.ingest.SigmetStore sigmetStore;

    public AlertRepository(JdbcClient db, ObjectMapper json, SigmetRepository sigmets, dev.skywx.ingest.SigmetStore sigmetStore) {
        this.db = db;
        this.json = json;
        this.sigmets = sigmets;
        this.sigmetStore = sigmetStore;
    }

    public record Page(List<Map<String, Object>> items, Long nextCursor) {}

    @EventListener
    public void onAlerts(EngineEvents.AlertsChanged e) {
        Thread.ofVirtual().start(() -> {
            for (AlertStateMachine.Event ev : e.events()) {
                try { persist(ev); } catch (RuntimeException ex) { log.warn("alert persist failed ({}): {}", ev.type(), ex.toString()); }
            }
        });
    }

    private void persist(AlertStateMachine.Event ev) {
        Alert a = ev.alert();
        switch (ev.type()) {
            case ENTERED, PREDICTED -> {
                // SIGMET 저장은 비동기라 첫 주기에는 아직 없을 수 있다 — 자연키 upsert 는 멱등이므로 먼저 보장한다(FK)
                var s = sigmetStore.get(a.sigmetId());
                if (s != null) sigmets.upsert(s);
                db.sql("""
                    INSERT INTO alert_event (id, hex, callsign, sigmet_id, kind, entered_at, eta_s, alt_ft_at_entry, evidence)
                    VALUES (:id, :hex, :cs, :sig, :kind, :at, :eta, :alt, :ev::jsonb)
                    ON CONFLICT (hex, sigmet_id, kind, entered_at) DO NOTHING""")
                    .param("id", a.id()).param("hex", a.hex()).param("cs", a.callsign()).param("sig", a.sigmetId()).param("kind", a.kind())
                    .param("at", Sql.ts(a.enteredAt())).param("eta", a.etaS()).param("alt", a.altFt()).param("ev", json.writeValueAsString(a.evidence())).update();
            }
            case PREDICTION_UPDATED -> db.sql("UPDATE alert_event SET eta_s = :eta, evidence = :ev::jsonb WHERE id = :id")
                    .param("eta", a.etaS()).param("ev", json.writeValueAsString(a.evidence())).param("id", a.id()).update();
            case LEFT, PREDICTION_CLEARED -> db.sql("UPDATE alert_event SET left_at = :left WHERE id = :id AND left_at IS NULL")
                    .param("left", Sql.ts(a.leftAt() == null ? Instant.now() : a.leftAt())).param("id", a.id()).update();
        }
    }

    public Page history(Instant from, Instant to, String hex, Long cursor, int limit) {
        var q = db.sql("""
                SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.eta_s, e.alt_ft_at_entry, e.evidence::text evidence
                FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
                WHERE e.entered_at BETWEEN :from AND :to AND (:hex::text IS NULL OR e.hex = :hex) AND (:cursor::bigint IS NULL OR e.id < :cursor)
                ORDER BY e.id DESC LIMIT :n""")
                .param("from", Sql.ts(from)).param("to", Sql.ts(to)).param("hex", hex).param("cursor", cursor).param("n", limit + 1);
        List<Map<String, Object>> rows = q.query().listOfRows().stream().map(r -> {
            var m = new java.util.LinkedHashMap<>(r);
            Object ev = m.get("evidence");
            m.put("evidence", ev == null ? null : json.readTree(ev.toString()));
            m.put("estimated", "PREDICTED".equals(m.get("kind")));
            return (Map<String, Object>) m;
        }).toList();
        Long next = rows.size() > limit ? ((Number) rows.get(limit - 1).get("id")).longValue() : null;
        return new Page(rows.size() > limit ? rows.subList(0, limit) : rows, next);
    }
}
