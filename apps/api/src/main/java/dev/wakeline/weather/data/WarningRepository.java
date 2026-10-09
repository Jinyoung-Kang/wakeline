package dev.wakeline.weather.data;

import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.platform.data.Sql;
import dev.wakeline.weather.core.WarningRecord;
import dev.wakeline.weather.core.WeatherEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 기상특보 이력(V20 wx_warning — ADR-036 · 계약 v5 §G49). 목록 한 벌마다 순서 큐(OrderedWriter) 한 작업으로: 목록에 있는 특보는 자연키(구역 · 종류 · 수준 ·
 * 발표 시각)로 이어 쓰고(last_seen · 명령 · 해제예고 — 다시 나타나면 ended_at 을 비운다), 열린 행 중 이 목록에 없는 것은 이 목록의 수신 시각으로 끝낸다.
 * 스트림 순서대로 받고(백로그 포함 — SIGMET 세트와 같은 규칙), 이미 저장한 수신 시각 이하의 목록은 건너뛴다(재전달 · 부트스트랩).
 * 영수증은 저장이 끝나야 놓는다(그때 XACK).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Repository
public class WarningRepository {
    private static final Logger log = LoggerFactory.getLogger(WarningRepository.class);
    private final JdbcClient db;
    private final OrderedWriter writer;
    private volatile Instant lastSetAt = Instant.EPOCH;

    public WarningRepository(JdbcClient db, OrderedWriter writer) {
        this.db = db;
        this.writer = writer;
    }

    @EventListener
    public void onWarnings(WeatherEvents.WarningsReceived e) {
        if (e.fetchedAt() == null || !e.fetchedAt().isAfter(lastSetAt)) return;
        lastSetAt = e.fetchedAt();
        Instant at = e.fetchedAt();
        String provider = e.provider();
        List<WarningRecord> ws = e.warnings();
        writer.submit(OrderedWriter.task("wx_warning_set", () -> persist(at, provider, ws), e.receipt().hold()));
    }

    /** 목록 한 벌(순서 큐 스레드). @return 끝낸 행 수 */
    int persist(Instant at, String provider, List<WarningRecord> ws) {
        for (WarningRecord w : ws) {
            db.sql("""
                    INSERT INTO wx_warning (zone_code, zone_name, parent_code, parent_name, sea, kind, level, command, preliminary, issued_at, effective_at,
                                            effective_from, effective_to, effective_text, end_notice, raw, provider, first_seen, last_seen)
                    VALUES (:zc, :zn, :pc, :pn, :sea, :kind, :lvl, :cmd, :pre, :iss, :eff, :ef, :et, :etx, :end, :raw, :prov, :at, :at)
                    ON CONFLICT (zone_code, kind, level, issued_at) DO UPDATE SET
                      zone_name = EXCLUDED.zone_name, command = EXCLUDED.command, end_notice = EXCLUDED.end_notice, effective_at = EXCLUDED.effective_at,
                      effective_from = EXCLUDED.effective_from, effective_to = EXCLUDED.effective_to, effective_text = EXCLUDED.effective_text,
                      raw = EXCLUDED.raw, last_seen = greatest(wx_warning.last_seen, EXCLUDED.last_seen), ended_at = NULL""")
                    .param("zc", w.zoneCode()).param("zn", w.zoneName()).param("pc", w.parentCode()).param("pn", w.parentName()).param("sea", w.sea())
                    .param("kind", w.kind()).param("lvl", w.level()).param("cmd", w.command()).param("pre", w.preliminary()).param("iss", Sql.ts(w.issuedAt()))
                    .param("eff", Sql.ts(w.effectiveAt())).param("ef", Sql.ts(w.effectiveFrom())).param("et", Sql.ts(w.effectiveTo()))
                    .param("etx", w.effectiveText()).param("end", w.endNotice()).param("raw", w.raw()).param("prov", provider).param("at", Sql.ts(at))
                    .update();
        }
        int ended = db.sql("UPDATE wx_warning SET ended_at = :at WHERE ended_at IS NULL AND last_seen < :at").param("at", Sql.ts(at)).update();
        if (ended > 0) log.info("wx warnings {}: {} in force, {} ended", at, ws.size(), ended);
        return ended;
    }

    /**
     * 이력: [from, to] 와 겹치는 특보(발효 중이던 동안이 창과 겹침) — 처음 받은 시각 최신순, limit 개. zone 이 있으면 그 구역만.
     * 시각은 그대로 UTC(화면이 KST 로).
     */
    public List<Map<String, Object>> history(Instant from, Instant to, String zone, int limit) {
        var q = Sql.publicRead(db, "warnings.history", """
                SELECT zone_code, zone_name, parent_code, parent_name, sea, kind, level, command, preliminary, issued_at, effective_at, effective_from,
                       effective_to, effective_text, end_notice, raw, provider, first_seen, last_seen, ended_at
                FROM wx_warning WHERE first_seen <= :to AND coalesce(ended_at, last_seen) >= :from%s
                ORDER BY first_seen DESC, id DESC LIMIT :n""".formatted(zone == null ? "" : " AND zone_code = :zone"))
                .param("from", Sql.ts(from)).param("to", Sql.ts(to)).param("n", limit);
        if (zone != null) q = q.param("zone", zone);
        return q.query().listOfRows().stream().map(r -> {
            Map<String, Object> m = new LinkedHashMap<>(r);
            for (String k : List.of("issued_at", "effective_at", "effective_from", "effective_to", "first_seen", "last_seen", "ended_at"))
                m.put(k, Sql.toInstant(m.get(k)));
            return (Map<String, Object>) m;
        }).toList();
    }
}
