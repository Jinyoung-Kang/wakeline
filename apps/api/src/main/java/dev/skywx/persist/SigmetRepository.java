package dev.skywx.persist;

import dev.skywx.domain.GeoJson;
import dev.skywx.domain.SigmetRecord;
import dev.skywx.ingest.IngestEvents;
import dev.skywx.ingest.SigmetStore;
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
 *   <li>SigmetsUpdated 는 알림 엔진보다 먼저 받아(HIGHEST_PRECEDENCE) 같은 순서 큐에 넣는다 — 이 세트의 SIGMET 행이 그 세트로 만든 알림보다 먼저 저장된다.</li>
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
    /** id → 마지막으로 DB 에 쓴 내용(fetchedAt 은 EPOCH 로 지운 사본). 순서 큐 스레드에서만 쓰지만 조회는 여러 곳에서 한다. */
    private final Map<String, SigmetRecord> persisted = new ConcurrentHashMap<>();

    public SigmetRepository(JdbcClient db, ObjectMapper json, OrderedWriter writer) {
        this.db = db;
        this.json = json;
        this.writer = writer;
    }

    @EventListener
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public void onSigmets(IngestEvents.SigmetsUpdated e) {
        SigmetStore.State st = e.state();
        writer.submit(OrderedWriter.task("sigmet_set", () -> persistSet(st)));
    }

    /** 세트 하나: 바뀐 것만 upsert → 사라진 것 withdrawn 표시. 순서 큐 스레드에서 돈다. */
    void persistSet(SigmetStore.State st) {
        int written = 0;
        for (SigmetRecord s : st.byId().values()) {
            try {
                if (upsertIfChanged(s)) written++;
            } catch (RuntimeException e) {
                if (OrderedWriter.isTransient(e)) throw e; // DB 장애: 세트 전체를 순서 큐가 다시 시도한다
                // 한 건의 잘못된 자료(제약 위반 등)가 세트의 나머지·철회 판단을 막지 않게 — 그 경보만 건너뛴다
                log.warn("sigmet {} not persisted: {}", s.id(), e.toString());
            }
        }
        List<String> withdrawn = markWithdrawn(st);
        forgetOld(st.fetchedAt());
        if (written > 0 || !withdrawn.isEmpty())
            log.info("sigmet set persisted: {} written, {} unchanged, {} withdrawn {}", written, st.byId().size() - written, withdrawn.size(), withdrawn);
    }

    /** 알림 FK 용: 아직 쓴 적 없는 id 일 때만 쓴다. */
    public void ensure(SigmetRecord s) {
        if (s != null && !persisted.containsKey(s.id())) upsertIfChanged(s);
    }

    /** @return 실제로 SQL 을 보냈으면 true */
    boolean upsertIfChanged(SigmetRecord s) {
        SigmetRecord key = contentOf(s);
        if (key.equals(persisted.get(s.id()))) return false;
        upsert(s);
        persisted.put(s.id(), key);
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

    public void upsert(SigmetRecord s) {
        String geojson = s.geometry() == null ? null : json.writeValueAsString(Map.of("type", "MultiPolygon", "coordinates", GeoJson.coordinates(s.geometry())));
        db.sql("""
                INSERT INTO sigmet (id, fir_id, fir_name, issuer, series_id, hazard, qualifier, base_ft, top_ft, valid_from, valid_to, geom,
                                    excluded_reason, move_dir, move_spd, chng, raw_text, provider, fetched_at, base_source, top_source)
                VALUES (:id, :fir, :firName, :issuer, :series, :hazard, :qualifier, :base, :top, :vf, :vt,
                        CASE WHEN :geo::text IS NULL THEN NULL ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:geo), 4326)) END,
                        :excl, :dir, :spd, :chng, :raw, :provider, :fetched, :baseSrc, :topSrc)
                ON CONFLICT (id) DO UPDATE SET valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
                        top_ft = EXCLUDED.top_ft, base_ft = EXCLUDED.base_ft, base_source = EXCLUDED.base_source, top_source = EXCLUDED.top_source,
                        geom = EXCLUDED.geom, excluded_reason = EXCLUDED.excluded_reason, move_dir = EXCLUDED.move_dir, move_spd = EXCLUDED.move_spd,
                        chng = EXCLUDED.chng, raw_text = EXCLUDED.raw_text, fetched_at = EXCLUDED.fetched_at, withdrawn_at = NULL
                WHERE sigmet.valid_from IS DISTINCT FROM EXCLUDED.valid_from OR sigmet.valid_to IS DISTINCT FROM EXCLUDED.valid_to
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
                .param("baseSrc", dbBaseSource(s)).param("topSrc", dbTopSource(s)).update();
    }

    /**
     * 완전한 세트에서 사라진(아직 valid_to 전) 경보에 withdrawn_at 을 남긴다. 판단 범위는 세트에 실제로 들어 있는 공급자뿐.
     * @return 이번에 철회로 표시한 id
     */
    List<String> markWithdrawn(SigmetStore.State st) {
        Set<String> providers = new TreeSet<>();
        for (SigmetRecord s : st.byId().values()) if (s.provider() != null) providers.add(s.provider());
        if (providers.isEmpty() || st.fetchedAt() == null || Instant.EPOCH.equals(st.fetchedAt())) return List.of();
        List<String> ids = db.sql("""
                UPDATE sigmet SET withdrawn_at = :fetched
                WHERE withdrawn_at IS NULL AND valid_to > :fetched
                  AND provider IN (SELECT jsonb_array_elements_text(:providers::jsonb))
                  AND id NOT IN (SELECT jsonb_array_elements_text(:ids::jsonb))
                RETURNING id""")
                .param("fetched", Sql.ts(st.fetchedAt()))
                .param("providers", json.writeValueAsString(providers))
                .param("ids", json.writeValueAsString(st.byId().keySet()))
                .query(String.class).list();
        ids.forEach(persisted::remove); // 다시 나타나면 upsert 가 withdrawn_at 을 지우도록
        return ids;
    }

    private void forgetOld(Instant now) {
        if (now == null) return;
        Instant cutoff = now.minusSeconds(FORGET_AFTER_S);
        persisted.values().removeIf(s -> s.validTo().isBefore(cutoff));
    }

    /** 재생: 시각 t 에 유효했던(발효 후, 철회·만료 전) 경보. base/top 출처는 계약 값만 내보내고 DB 전용 'unknown' 하한은 null. */
    public List<Map<String, Object>> validAt(Instant at) {
        return db.sql("""
                SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, base_source, top_source, valid_from, valid_to, withdrawn_at,
                       excluded_reason, raw_text, provider, ST_AsGeoJSON(geom)::text geometry
                FROM sigmet WHERE valid_from <= :t AND coalesce(withdrawn_at, valid_to) > :t ORDER BY fir_id, series_id""")
                .param("t", Sql.ts(at)).query().listOfRows().stream().map(r -> {
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
