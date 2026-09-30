package dev.wakeline.persist;

import dev.wakeline.domain.Bbox;
import dev.wakeline.domain.GeoJson;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.ingest.IngestEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SIGMET 자연키 upsert(영구, 재생·통계용). 만료된 경보도 DB 에는 남긴다.
 * <ul>
 *   <li>바뀐 것만 쓴다(PERF-14): 마지막으로 쓴 내용(수신 시각 제외)과 같으면 건너뛰고, SQL 도 내용이 다를 때만 행을 갱신한다.</li>
 *   <li>알림 저장은 FK 를 위해 {@link #ensure} 만 부른다 — 이미 쓴 id 면 맵 조회 한 번(알림마다 폴리곤을 다시 쓰지 않는다).</li>
 *   <li>철회(COR-14): api 는 완전한 세트만 받는다(collector 보장). 세트에 들어 있는 공급자의 경보 중 valid_to 전인데 세트에서 사라진 것은
 *       withdrawn_at = 그 세트의 수신 시각. 세트에 한 건도 없는 공급자는 판단하지 않는다(그 피드가 빠진 세트일 수 있으므로 단정하지 않는다).
 *       다시 나타나면 withdrawn_at 을 지운다.</li>
 *   <li>세트는 <b>스트림 순서대로 모두</b> 저장한다(SigmetSetReceived, API-CONC-1): 실시간 저장소에 반영된 새 세트뿐 아니라, 재시작 뒤 밀린
 *       백로그 세트도. 이전에는 백로그 세트를 건너뛰어 api 가 멈춘 동안 발표·만료·철회된 경보가 재생·통계에서 사라졌고, 그 사이 철회된 경보는
 *       재시작 시각에 철회된 것으로 기록됐다. 수신 시각이 이미 저장한 세트보다 새 것이 아니면(재전달·중복) 건너뛴다.</li>
 *   <li>first_seen = 그 경보가 처음 들어 있던 세트의 수신 시각(피드 기준). 철회 판단은 first_seen 이 그 세트 시각 이전인 경보만 본다 —
 *       아직 피드에 나타나지 않았던 시각의 세트가 '빠졌다(철회)' 고 판단하지 않게(알림 FK 로 먼저 쓰인 새 경보를 보호).</li>
 *   <li>세트 이벤트는 알림 엔진보다 먼저 발행·수신되어 같은 순서 큐에 들어간다 — 이 세트의 SIGMET 행이 그 세트로 만든 알림보다 먼저 저장된다.</li>
 *   <li>영수증(API-CONC-8): 세트 저장이 커밋되면 그 스트림 메시지를 ACK 한다.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Repository
public class SigmetRepository {
    private static final Logger log = LoggerFactory.getLogger(SigmetRepository.class);
    /** 이 기간보다 오래전에 끝난 경보는 '마지막으로 쓴 내용' 캐시에서 뺀다. */
    static final long FORGET_AFTER_S = 24 * 3600;
    private final JdbcClient db;
    private final ObjectMapper json;
    private final OrderedWriter writer;
    /** 마지막으로 DB 에 쓴 내용(fetchedAt 은 EPOCH 로 지운 사본)과 알고 있는 first_seen 의 상한. 순서 큐 스레드에서만 쓰지만 조회는 여러 곳에서 한다. */
    record Persisted(SigmetRecord content, Instant firstSeen) {}
    private final Map<String, Persisted> persisted = new ConcurrentHashMap<>();
    /** 이력에 넣은 마지막 세트의 수신 시각(스트림 소비 스레드에서만) — 재전달·중복 세트를 건너뛴다. */
    private volatile Instant lastSetAt = Instant.EPOCH;

    public SigmetRepository(JdbcClient db, ObjectMapper json, OrderedWriter writer) {
        this.db = db;
        this.json = json;
        this.writer = writer;
    }

    @EventListener
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public void onSigmetSet(IngestEvents.SigmetSetReceived e) {
        if (e.fetchedAt() == null || !e.fetchedAt().isAfter(lastSetAt)) return; // 이미 저장한 세트(재전달·중복) — 영수증을 잡지 않는다(곧 ACK)
        lastSetAt = e.fetchedAt();
        Instant fetched = e.fetchedAt();
        Map<String, SigmetRecord> byId = e.byId();
        writer.submit(OrderedWriter.task("sigmet_set", () -> persistSet(fetched, byId), e.receipt().hold()));
    }

    /** 세트 하나: 바뀐 것만 upsert → 사라진 것 withdrawn 표시. 순서 큐 스레드에서 돈다. */
    void persistSet(Instant fetchedAt, Map<String, SigmetRecord> byId) {
        int written = 0;
        for (SigmetRecord s : byId.values()) {
            try {
                if (upsertIfChanged(s, fetchedAt)) written++;
            } catch (RuntimeException e) {
                if (OrderedWriter.isTransient(e)) throw e; // DB 장애: 세트 전체를 순서 큐가 다시 시도한다
                // 한 건의 잘못된 자료(제약 위반 등)가 세트의 나머지·철회 판단을 막지 않게 — 그 경보만 건너뛴다
                log.warn("sigmet {} not persisted: {}", s.id(), e.toString());
            }
        }
        List<String> withdrawn = markWithdrawn(fetchedAt, byId);
        forgetOld(fetchedAt);
        if (written > 0 || !withdrawn.isEmpty())
            log.info("sigmet set {} persisted: {} written, {} unchanged, {} withdrawn {}", fetchedAt, written, byId.size() - written, withdrawn.size(), withdrawn);
    }

    /** 알림 FK 용: 아직 쓴 적 없는 id 일 때만 쓴다. */
    public void ensure(SigmetRecord s) {
        if (s != null && !persisted.containsKey(s.id())) upsertIfChanged(s, s.fetchedAt());
    }

    /**
     * 내용이 바뀌었거나 first_seen 을 앞당길 수 있을 때만 SQL 을 보낸다.
     * @param seenAt 이 경보가 들어 있던 세트의 수신 시각(first_seen 후보)
     * @return 실제로 SQL 을 보냈으면 true
     */
    boolean upsertIfChanged(SigmetRecord s, Instant seenAt) {
        SigmetRecord key = contentOf(s);
        Persisted p = persisted.get(s.id());
        boolean earlier = p != null && seenAt != null && seenAt.isBefore(p.firstSeen());
        if (p != null && key.equals(p.content()) && !earlier) return false;
        upsert(s, seenAt);
        Instant fs = p == null || seenAt == null ? seenAt : (earlier ? seenAt : p.firstSeen());
        persisted.put(s.id(), new Persisted(key, fs == null ? Instant.EPOCH : fs));
        return true;
    }

    /** 내용 비교용 사본: 수신 시각만 지운다(매 수신마다 바뀌지만 경보 내용은 아니다). */
    static SigmetRecord contentOf(SigmetRecord s) {
        return new SigmetRecord(s.id(), s.firId(), s.firName(), s.issuer(), s.seriesId(), s.hazard(), s.qualifier(), s.baseFt(), s.topFt(),
                s.validFrom(), s.validTo(), s.geometry(), s.excludedReason(), s.moveDir(), s.moveSpd(), s.chng(), s.rawText(), s.provider(),
                Instant.EPOCH, s.baseSource(), s.topSource());
    }

    /**
     * DB 에 저장하는 하한 출처. 새 수집기는 항상 보낸다(json | assumed_surface). 출처 필드가 없던 이전 형식 메시지는:
     * base_ft > 0 이면 JSON 값뿐이다(이전 수집기의 대체값은 0 뿐) → json, 0 이면 JSON 0 인지 null 인지 알 수 없다 → unknown(DB 전용 값).
     */
    static String dbBaseSource(SigmetRecord s) {
        if (s.baseSource() != null) return s.baseSource();
        return s.baseFt() > 0 ? SigmetRecord.BASE_JSON : "unknown";
    }

    /** 상한 출처. 이전 형식에서 top_ft 가 있으면 JSON 값뿐이다(이전 수집기는 원문을 해석하지 않았다), 없으면 unknown(미발표). */
    static String dbTopSource(SigmetRecord s) {
        if (s.topSource() != null) return s.topSource();
        return s.topFt() == null ? SigmetRecord.TOP_UNKNOWN : SigmetRecord.TOP_JSON;
    }

    public void upsert(SigmetRecord s) { upsert(s, s.fetchedAt()); }

    /**
     * 자연키 upsert(같은 순서 큐 안에서 세트 순서대로 부른다 — 뒤의 세트가 이긴다). 세트에 들어 있으면 철회 표시를 지운다.
     * first_seen 은 더 이른 수신 시각으로만 앞당긴다.
     */
    void upsert(SigmetRecord s, Instant seenAt) {
        String geojson = s.geometry() == null ? null : json.writeValueAsString(Map.of("type", "MultiPolygon", "coordinates", GeoJson.coordinates(s.geometry())));
        db.sql("""
                INSERT INTO sigmet (id, fir_id, fir_name, issuer, series_id, hazard, qualifier, base_ft, top_ft, valid_from, valid_to, geom,
                                    excluded_reason, move_dir, move_spd, chng, raw_text, provider, fetched_at, base_source, top_source, first_seen)
                VALUES (:id, :fir, :firName, :issuer, :series, :hazard, :qualifier, :base, :top, :vf, :vt,
                        CASE WHEN :geo::text IS NULL THEN NULL ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:geo), 4326)) END,
                        :excl, :dir, :spd, :chng, :raw, :provider, :fetched, :baseSrc, :topSrc, coalesce(:seen::timestamptz, now()))
                ON CONFLICT (id) DO UPDATE SET valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
                        top_ft = EXCLUDED.top_ft, base_ft = EXCLUDED.base_ft, base_source = EXCLUDED.base_source, top_source = EXCLUDED.top_source,
                        geom = EXCLUDED.geom, excluded_reason = EXCLUDED.excluded_reason, move_dir = EXCLUDED.move_dir, move_spd = EXCLUDED.move_spd,
                        chng = EXCLUDED.chng, raw_text = EXCLUDED.raw_text, fetched_at = EXCLUDED.fetched_at, withdrawn_at = NULL,
                        first_seen = LEAST(sigmet.first_seen, EXCLUDED.first_seen)
                WHERE sigmet.first_seen > EXCLUDED.first_seen
                   OR sigmet.valid_from IS DISTINCT FROM EXCLUDED.valid_from OR sigmet.valid_to IS DISTINCT FROM EXCLUDED.valid_to
                   OR sigmet.top_ft IS DISTINCT FROM EXCLUDED.top_ft OR sigmet.base_ft IS DISTINCT FROM EXCLUDED.base_ft
                   OR sigmet.base_source IS DISTINCT FROM EXCLUDED.base_source OR sigmet.top_source IS DISTINCT FROM EXCLUDED.top_source
                   OR sigmet.excluded_reason IS DISTINCT FROM EXCLUDED.excluded_reason OR sigmet.raw_text IS DISTINCT FROM EXCLUDED.raw_text
                   OR sigmet.move_dir IS DISTINCT FROM EXCLUDED.move_dir OR sigmet.move_spd IS DISTINCT FROM EXCLUDED.move_spd
                   OR sigmet.chng IS DISTINCT FROM EXCLUDED.chng OR sigmet.withdrawn_at IS NOT NULL
                   OR ST_AsBinary(sigmet.geom) IS DISTINCT FROM ST_AsBinary(EXCLUDED.geom)""")
                .param("id", s.id()).param("fir", s.firId()).param("firName", s.firName()).param("issuer", s.issuer()).param("series", s.seriesId())
                .param("hazard", s.hazard()).param("qualifier", s.qualifier()).param("base", s.baseFt()).param("top", s.topFt())
                .param("vf", Sql.ts(s.validFrom())).param("vt", Sql.ts(s.validTo())).param("geo", geojson).param("excl", s.excludedReason())
                .param("dir", s.moveDir()).param("spd", s.moveSpd()).param("chng", s.chng()).param("raw", s.rawText())
                .param("provider", s.provider()).param("fetched", Sql.ts(s.fetchedAt()))
                .param("baseSrc", dbBaseSource(s)).param("topSrc", dbTopSource(s)).param("seen", Sql.ts(seenAt)).update();
    }

    /**
     * 완전한 세트에서 사라진(아직 valid_to 전) 경보에 withdrawn_at 을 남긴다. 판단 범위는 세트에 실제로 들어 있는 공급자뿐이고,
     * 그 세트 시각에 이미 피드에 나타났던 경보(first_seen ≤ 세트 시각)뿐이다.
     * @return 이번에 철회로 표시한 id
     */
    List<String> markWithdrawn(Instant fetchedAt, Map<String, SigmetRecord> byId) {
        Set<String> providers = new TreeSet<>();
        for (SigmetRecord s : byId.values()) if (s.provider() != null) providers.add(s.provider());
        if (providers.isEmpty() || fetchedAt == null || Instant.EPOCH.equals(fetchedAt)) return List.of();
        List<String> ids = db.sql("""
                UPDATE sigmet SET withdrawn_at = :fetched
                WHERE withdrawn_at IS NULL AND valid_to > :fetched AND first_seen <= :fetched
                  AND provider IN (SELECT jsonb_array_elements_text(:providers::jsonb))
                  AND id NOT IN (SELECT jsonb_array_elements_text(:ids::jsonb))
                RETURNING id""")
                .param("fetched", Sql.ts(fetchedAt))
                .param("providers", json.writeValueAsString(providers))
                .param("ids", json.writeValueAsString(byId.keySet()))
                .query(String.class).list();
        ids.forEach(persisted::remove); // 다시 나타나면 upsert 가 withdrawn_at 을 지우도록
        return ids;
    }

    private void forgetOld(Instant now) {
        if (now == null) return;
        Instant cutoff = now.minusSeconds(FORGET_AFTER_S);
        persisted.values().removeIf(p -> p.content().validTo().isBefore(cutoff));
    }

    /** 재생: 시각 t 에 유효했던(발효 후, 철회·만료 전) 경보 — 전세계. */
    public List<Map<String, Object>> validAt(Instant at) { return validAt(at, Bbox.world()); }

    /**
     * 재생: 시각 t 에 유효했던(발효 후, 철회·만료 전) 경보 중 bbox 와 겹치는 것(R-26, GIST sigmet_geom_gist). 도형이 없는 경보(좌표 없음)는
     * 위치를 모르므로 뺄 수 없어 남긴다. base/top 출처는 계약 값만 내보내고 DB 전용 'unknown' 하한은 null.
     */
    public List<Map<String, Object>> validAt(Instant at, Bbox b) {
        return Sql.publicRead(db, "replay.sigmet", """
                SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn_at,
                       excluded_reason, raw_text, provider, ST_AsGeoJSON(geom)::text geometry
                FROM sigmet WHERE valid_from <= :t AND coalesce(withdrawn_at, valid_to) > :t
                  AND (geom IS NULL OR geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326))
                ORDER BY fir_id, series_id""")
                .param("t", Sql.ts(at)).param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax())
                .query().listOfRows().stream().map(r -> {
                    var m = new LinkedHashMap<>(r);
                    Object g = m.get("geometry");
                    m.put("geometry", g == null ? null : json.readTree(g.toString()));
                    if (!Objects.equals(m.get("base_source"), SigmetRecord.BASE_JSON) && !Objects.equals(m.get("base_source"), SigmetRecord.BASE_ASSUMED_SURFACE))
                        m.put("base_source", null);
                    for (String k : List.of("valid_from", "valid_to", "withdrawn_at")) m.put(k, TrackRepository.toInstant(m.get(k)));
                    return (Map<String, Object>) m;
                }).toList();
    }
}
