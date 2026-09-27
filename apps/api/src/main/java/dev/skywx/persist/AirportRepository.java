package dev.skywx.persist;

import dev.skywx.domain.Bbox;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/** 공항 + 최신 METAR 요약. collector 가 쓴 테이블을 읽기만 한다. */
@Repository
public class AirportRepository {
    private final JdbcClient db;

    public AirportRepository(JdbcClient db) { this.db = db; }

    public List<Map<String, Object>> withLatestMetar(Bbox b, boolean watchedOnly) {
        return db.sql("""
                SELECT a.icao, a.iata, a.name, a.country, a.elev_ft, a.watched, ST_X(a.geom) lon, ST_Y(a.geom) lat,
                       m.obs_time, m.flight_cat, m.flight_cat_source, m.wind_dir, m.wind_kt, m.vis_sm, m.ceiling_ft, m.temp_c, m.wx_string, m.fetched_at, m.provider
                FROM airport a
                LEFT JOIN LATERAL (SELECT * FROM metar_obs mo WHERE mo.icao = a.icao ORDER BY obs_time DESC LIMIT 1) m ON true
                WHERE (:watched = false OR a.watched)
                  AND a.geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                ORDER BY a.icao""")
                .param("watched", watchedOnly).param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax())
                .query().listOfRows().stream().map(AirportRepository::fix).toList();
    }

    public Map<String, Object> wx(String icao) {
        var airport = db.sql("SELECT icao, iata, name, country, elev_ft, ST_X(geom) lon, ST_Y(geom) lat FROM airport WHERE icao = :i")
                .param("i", icao).query().listOfRows().stream().findFirst().orElse(null);
        if (airport == null) return null;
        var latest = db.sql("""
                SELECT obs_time, raw, temp_c, dewp_c, wind_dir, wind_kt, vis_sm, vis_raw, ceiling_ft, flight_cat, flight_cat_source, wx_string, taf_raw, provider, fetched_at
                FROM metar_obs WHERE icao = :i ORDER BY obs_time DESC LIMIT 1""").param("i", icao).query().listOfRows().stream().findFirst().orElse(null);
        var history = db.sql("SELECT obs_time, flight_cat, wind_dir, wind_kt, vis_sm, ceiling_ft, temp_c FROM metar_obs WHERE icao = :i ORDER BY obs_time DESC LIMIT 24")
                .param("i", icao).query().listOfRows();
        var m = new java.util.LinkedHashMap<String, Object>();
        m.put("airport", airport);
        m.put("latest", latest == null ? null : fix(latest));
        m.put("history", history.stream().map(AirportRepository::fix).toList());
        if (latest != null) { m.put("fetched_at", TrackRepository.toInstant(latest.get("fetched_at"))); m.put("provider", latest.get("provider")); }
        return m;
    }

    private static Map<String, Object> fix(Map<String, Object> r) {
        var m = new java.util.LinkedHashMap<>(r);
        for (String k : List.of("obs_time", "fetched_at")) if (m.containsKey(k)) m.put(k, TrackRepository.toInstant(m.get(k)));
        return m;
    }
}
