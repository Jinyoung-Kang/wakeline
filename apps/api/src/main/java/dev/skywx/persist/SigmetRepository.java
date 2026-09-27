package dev.skywx.persist;

import dev.skywx.domain.GeoJson;
import dev.skywx.domain.SigmetRecord;
import dev.skywx.ingest.IngestEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** SIGMET 자연키 upsert(영구, 재생용). 만료된 경보도 DB 에는 남긴다. */
@Repository
public class SigmetRepository {
    private static final Logger log = LoggerFactory.getLogger(SigmetRepository.class);
    private final JdbcClient db;
    private final ObjectMapper json;

    public SigmetRepository(JdbcClient db, ObjectMapper json) { this.db = db; this.json = json; }

    @EventListener
    public void onSigmets(IngestEvents.SigmetsUpdated e) {
        Thread.ofVirtual().start(() -> {
            try {
                for (SigmetRecord s : e.state().byId().values()) upsert(s);
            } catch (RuntimeException ex) {
                log.warn("sigmet persist failed: {}", ex.toString());
            }
        });
    }

    public void upsert(SigmetRecord s) {
        String geojson = s.geometry() == null ? null : json.writeValueAsString(Map.of("type", "MultiPolygon", "coordinates", GeoJson.coordinates(s.geometry())));
        db.sql("""
                INSERT INTO sigmet (id, fir_id, fir_name, issuer, series_id, hazard, qualifier, base_ft, top_ft, valid_from, valid_to, geom,
                                    excluded_reason, move_dir, move_spd, chng, raw_text, provider, fetched_at)
                VALUES (:id, :fir, :firName, :issuer, :series, :hazard, :qualifier, :base, :top, :vf, :vt,
                        CASE WHEN :geo::text IS NULL THEN NULL ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:geo), 4326)) END,
                        :excl, :dir, :spd, :chng, :raw, :provider, :fetched)
                ON CONFLICT (id) DO UPDATE SET valid_to = EXCLUDED.valid_to, top_ft = EXCLUDED.top_ft, base_ft = EXCLUDED.base_ft,
                        geom = EXCLUDED.geom, excluded_reason = EXCLUDED.excluded_reason, raw_text = EXCLUDED.raw_text, fetched_at = EXCLUDED.fetched_at""")
                .param("id", s.id()).param("fir", s.firId()).param("firName", s.firName()).param("issuer", s.issuer()).param("series", s.seriesId())
                .param("hazard", s.hazard()).param("qualifier", s.qualifier()).param("base", s.baseFt()).param("top", s.topFt())
                .param("vf", Sql.ts(s.validFrom())).param("vt", Sql.ts(s.validTo())).param("geo", geojson).param("excl", s.excludedReason())
                .param("dir", s.moveDir()).param("spd", s.moveSpd()).param("chng", s.chng()).param("raw", s.rawText())
                .param("provider", s.provider()).param("fetched", Sql.ts(s.fetchedAt())).update();
    }

    public List<Map<String, Object>> validAt(Instant at) {
        return db.sql("""
                SELECT id, fir_id, fir_name, hazard, qualifier, base_ft, top_ft, valid_from, valid_to, excluded_reason, raw_text, provider,
                       ST_AsGeoJSON(geom)::text geometry
                FROM sigmet WHERE valid_from <= :t AND valid_to > :t ORDER BY fir_id, series_id""")
                .param("t", Sql.ts(at)).query().listOfRows().stream().map(r -> {
                    var m = new java.util.LinkedHashMap<>(r);
                    Object g = m.get("geometry");
                    m.put("geometry", g == null ? null : json.readTree(g.toString()));
                    return (Map<String, Object>) m;
                }).toList();
    }
}
