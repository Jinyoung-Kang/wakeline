package dev.wakeline.persist;

import dev.wakeline.domain.Bbox;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * 공항 + 최신 METAR 요약. collector 가 쓴 테이블을 읽기만 한다.
 * 관측 나이(COR-20·계약 §2): obs_age_s = now − obs_time(METAR 가 없으면 null), stale = obs_age_s > 2 h(나이를 모르면 null).
 * 오래된 관측의 카테고리를 '현재' 처럼 보이지 않게 클라이언트가 이 값으로 구분한다.
 * ceiling_state(measured | none | unknown)는 collector 가 기록한다 — 없음(CLR)과 모름을 구분한다(GAP-16).
 */
@Repository
public class AirportRepository {
    /** METAR 가 이보다 오래되면 stale(계약 §2). */
    public static final long METAR_STALE_S = 7_200;
    private final JdbcClient db;

    public AirportRepository(JdbcClient db) { this.db = db; }

    public List<Map<String, Object>> withLatestMetar(Bbox b, boolean watchedOnly) {
        Instant now = Instant.now();
        return db.sql("""
                SELECT a.icao, a.iata, a.name, a.country, a.elev_ft, a.watched, ST_X(a.geom) lon, ST_Y(a.geom) lat,
                       m.obs_time, m.flight_cat, m.flight_cat_source, m.wind_dir, m.wind_kt, m.vis_sm, m.ceiling_ft, m.ceiling_state,
                       m.temp_c, m.wx_string, m.fetched_at, m.provider
                FROM airport a
                LEFT JOIN LATERAL (SELECT * FROM metar_obs mo WHERE mo.icao = a.icao ORDER BY obs_time DESC LIMIT 1) m ON true
                WHERE (:watched = false OR a.watched)
                  AND a.geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                ORDER BY a.icao""")
                .param("watched", watchedOnly).param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax())
                .query().listOfRows().stream().map(r -> withAge(fix(r), now)).toList();
    }

    public Map<String, Object> wx(String icao) {
        Instant now = Instant.now();
        var airport = db.sql("SELECT icao, iata, name, country, elev_ft, ST_X(geom) lon, ST_Y(geom) lat FROM airport WHERE icao = :i")
                .param("i", icao).query().listOfRows().stream().findFirst().orElse(null);
        if (airport == null) return null;
        var latest = db.sql("""
                SELECT obs_time, raw, temp_c, dewp_c, wind_dir, wind_kt, vis_sm, vis_raw, ceiling_ft, ceiling_state, flight_cat, flight_cat_source,
                       wx_string, taf_raw, provider, fetched_at
                FROM metar_obs WHERE icao = :i ORDER BY obs_time DESC LIMIT 1""").param("i", icao).query().listOfRows().stream().findFirst().orElse(null);
        var history = db.sql("""
                SELECT obs_time, flight_cat, flight_cat_source, wind_dir, wind_kt, vis_sm, ceiling_ft, ceiling_state, temp_c
                FROM metar_obs WHERE icao = :i ORDER BY obs_time DESC LIMIT 24""")
                .param("i", icao).query().listOfRows();
        var m = new java.util.LinkedHashMap<String, Object>();
        m.put("airport", airport);
        m.put("latest", latest == null ? null : withAge(fix(latest), now));
        m.put("history", history.stream().map(AirportRepository::fix).toList());
        if (latest != null) { m.put("fetched_at", TrackRepository.toInstant(latest.get("fetched_at"))); m.put("provider", latest.get("provider")); }
        return m;
    }

    /** obs_age_s·stale 을 붙인다. 관측 시각이 없으면 둘 다 null(모름). 시계 차로 음수가 되면 0. */
    static Map<String, Object> withAge(Map<String, Object> m, Instant now) {
        Object t = m.get("obs_time");
        Long age = t instanceof Instant i ? Math.max(0, now.getEpochSecond() - i.getEpochSecond()) : null;
        m.put("obs_age_s", age);
        m.put("stale", age == null ? null : age > METAR_STALE_S);
        return m;
    }

    private static Map<String, Object> fix(Map<String, Object> r) {
        var m = new java.util.LinkedHashMap<>(r);
        for (String k : List.of("obs_time", "fetched_at")) if (m.containsKey(k)) m.put(k, TrackRepository.toInstant(m.get(k)));
        return m;
    }
}
