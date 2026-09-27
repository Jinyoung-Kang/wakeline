package dev.skywx.persist;

import dev.skywx.domain.Bbox;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** 항적·재생 질의(8.4절). 파티션 프루닝 + PK 역순, bbox 는 && 연산. */
@Repository
public class TrackRepository {
    private final JdbcClient db;

    public TrackRepository(JdbcClient db) { this.db = db; }

    public List<Map<String, Object>> track(String hex, Instant from, Instant to, int stepS) {
        String sql = stepS > 0 ? """
                SELECT DISTINCT ON (bucket) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, provider,
                       to_timestamp(floor(extract(epoch FROM ts) / :step) * :step) bucket
                FROM track_point WHERE hex = :hex AND ts BETWEEN :from AND :to ORDER BY bucket, ts"""
                : """
                SELECT hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, provider
                FROM track_point WHERE hex = :hex AND ts BETWEEN :from AND :to ORDER BY ts""";
        var q = db.sql(sql).param("hex", hex).param("from", Sql.ts(from)).param("to", Sql.ts(to));
        if (stepS > 0) q = q.param("step", stepS);
        return q.query().listOfRows().stream().map(r -> {
            var m = new java.util.LinkedHashMap<>(r);
            m.remove("bucket");
            m.put("ts", toInstant(m.get("ts")));
            return (Map<String, Object>) m;
        }).toList();
    }

    public List<Map<String, Object>> replay(Instant at, Bbox b) {
        List<Map<String, Object>> rows = db.sql("""
                SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider
                FROM track_point
                WHERE ts BETWEEN :t - interval '3 minutes' AND :t
                  AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                ORDER BY hex, ts DESC""")
                .param("t", Sql.ts(at)).param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax())
                .query().listOfRows();
        if (rows.isEmpty()) {
            rows = db.sql("""
                    SELECT DISTINCT ON (hex) hex, ts_minute ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, NULL::real track_deg, false on_ground, '1m_summary' provider
                    FROM track_point_1m
                    WHERE ts_minute BETWEEN :t - interval '3 minutes' AND :t
                      AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                    ORDER BY hex, ts_minute DESC""")
                    .param("t", Sql.ts(at)).param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax())
                    .query().listOfRows();
        }
        return rows.stream().map(r -> { var m = new java.util.LinkedHashMap<>(r); m.put("ts", toInstant(m.get("ts"))); return (Map<String, Object>) m; }).toList();
    }

    public static Instant toInstant(Object v) {
        if (v instanceof java.sql.Timestamp t) return t.toInstant();
        if (v instanceof java.time.OffsetDateTime o) return o.toInstant();
        if (v instanceof Instant i) return i;
        return null;
    }
}
