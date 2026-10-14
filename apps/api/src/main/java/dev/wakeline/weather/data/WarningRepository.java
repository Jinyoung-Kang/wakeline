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

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 기상특보 이력(V20 wx_warning — ADR-036 · 계약 v5 §G49). 목록 한 벌마다 순서 큐(OrderedWriter) 한 작업으로: 목록에 있는 특보는 자연키(구역 · 종류 · 수준 ·
 * 발표 시각)로 이어 쓰고(last_seen · 명령 · 해제예고 — 다시 나타나면 ended_at 을 비운다), 열린 행 중 목록에서 빠진 것은 처음 빠진 목록의 수신 시각으로
 * 끝낸다(수집기가 줄을 버린 목록이 이어지면 1 h 넘게 빠져 있을 때 — {@link #MISSING_END_AFTER}).
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
        int dropped = e.dropped();
        writer.submit(OrderedWriter.task("wx_warning_set", () -> persist(at, provider, ws, dropped), e.receipt().hold()));
    }

    /**
     * 줄을 버린 목록(dropped &gt; 0)이 이어지는 동안 빠진 특보를 끝내기까지 기다리는 시간(QA-1203). 버린 줄이 그 특보 자신일 수 있다 — 해석에 실패한 줄이
     * 아직 발효 중인 그 특보라면, 끝내면 이력이 발효 중인 특보를 '끝남'으로 보인다(AWS 리뷰 B-4 가 막은 일). 그러나 끝내기를 무기한 미루면, 다른 특보의 줄이
     * 매 주기 버려지는 동안(예: 구역 이름이 계약 한도 80자를 넘는 특보가 며칠 발효 중) 해제된 특보가 하나도 끝나지 않는다(QA-1203). 상한 1 h 의 근거:
     * 목록은 5분마다 오므로 12번 이어서 빠진 것이다 — 한두 주기의 해석 실패(발표 갱신 중 깨진 응답 등)는 그 안에 풀리고, 그보다 오래 버려지는 줄은
     * 같은 까닭으로 계속 버려지는 줄이라 더 기다려도 알 수 있는 것이 없다. 잘못 끝냈더라도 그 특보가 다시 목록에 오면 같은 자연키 행을 다시 연다.
     * 끝낸 시각은 기다린 뒤가 아니라 처음 빠진 목록의 수신 시각이다(계약 v5 §G49 'ended_at = 목록에서 빠진 시각').
     */
    static final Duration MISSING_END_AFTER = Duration.ofHours(1);
    /**
     * 열린 특보(행 id) 중 이 목록에 없는 것 → 처음 빠진 목록의 수신 시각. 목록마다 '지금 빠져 있는 열린 행'으로 새로 만든다(다시 나타나거나 끝난 행은
     * 빠진다). 순서 큐 스레드만 바꾼다. 메모리에만 있다 — 재시작하면 비어, 그 뒤 처음 받은 목록의 시각부터 센다(정지 동안은 받은 목록이 없어 알 수 없다 — B-3).
     */
    private volatile Map<Long, Instant> missingSince = Map.of();

    /**
     * 목록 한 벌(순서 큐 스레드). 열린 행 중 이 목록에 없는 것은 처음 빠진 목록의 수신 시각으로 끝낸다 — 온전한 목록(dropped = 0)이면 곧바로, 수집기가
     * 줄을 버린 목록이면 {@link #MISSING_END_AFTER} 넘게 이어서 빠져 있을 때. @return 끝낸 행 수
     */
    int persist(Instant at, String provider, List<WarningRecord> ws, int dropped) {
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
        // 이 목록에 없는 열린 행 — 처음 빠진 시각을 이어 기억한다
        Map<Long, Instant> before = missingSince;
        Map<Long, Instant> missing = new LinkedHashMap<>();
        for (Long id : db.sql("SELECT id FROM wx_warning WHERE ended_at IS NULL AND last_seen < :at ORDER BY id").param("at", Sql.ts(at)).query(Long.class).list())
            missing.put(id, before.getOrDefault(id, at));
        // 줄을 버린 목록(수집기가 해석하지 못해 뺀 줄 — dropped)에서는 곧바로 끝내지 않는다: 빠진 특보가 해제된 것인지 줄만 버려진 것인지 모른다
        // (QA 2026-10-release §7-1 · AWS 리뷰 B-4 — 아직 발효 중인 특보가 그 시각에 끝난 것으로 이력에 남았다). 1 h 넘게 이어서 빠져 있으면 끝낸다(QA-1203)
        Instant cut = at.minus(MISSING_END_AFTER);
        int ended = 0, waiting = 0;
        for (var it = missing.entrySet().iterator(); it.hasNext(); ) {
            var m = it.next();
            if (dropped > 0 && m.getValue().isAfter(cut)) {
                waiting++;
                continue;
            }
            // 기억한 시각이 마지막으로 본 시각 이전이면(그 사이 다시 나타난 목록의 기록이 실패했다) 이 목록의 시각으로 — 본 뒤에 끝난 것만 남긴다
            ended += db.sql("""
                    UPDATE wx_warning SET ended_at = CASE WHEN :end > last_seen THEN :end ELSE :at END
                    WHERE id = :id AND ended_at IS NULL AND last_seen < :at""")
                    .param("end", Sql.ts(m.getValue())).param("id", m.getKey()).param("at", Sql.ts(at)).update();
            it.remove();
        }
        missingSince = Map.copyOf(missing);
        if (dropped > 0)
            log.info("wx warnings {}: {} in force, {} ended, {} missing kept open for up to {} min ({} line(s) dropped by the collector)", at, ws.size(), ended,
                    waiting, MISSING_END_AFTER.toMinutes(), dropped);
        else if (ended > 0) log.info("wx warnings {}: {} in force, {} ended", at, ws.size(), ended);
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
