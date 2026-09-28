package dev.wakeline.persist;

import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.AisScope;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 선박 표(V5: ship · ship_position · ingest_gap) 쓰기·읽기. 쓰기는 ShipWriter(가상 스레드 하나)와 순서 큐만 부른다 — 요청·소비 스레드는 부르지 않는다.
 * 모든 쓰기는 멱등이다(재시도·재처리·재시작): 위치 (mmsi, ts) PK + 60 s 창 가드, 정적 정보 updated_at 단조, 공백 (source, coalesce(scope, ''), started_at)(V8 — 구역이 다르면 같은 시각이어도 다른 공백).
 */
@Repository
public class ShipRepository {
    /** 공백 기록의 source 값(ingest_gap 은 수집 공백 일반 표 — 지금은 AIS 만). */
    public static final String GAP_SOURCE = "ais";
    /** 위치를 줄이는 창(계약 v2 §B3: MMSI 별 60 s 에 첫 보고 하나). ShipWriter 의 메모리 필터와 같은 값. */
    public static final long WINDOW_S = 60;

    /**
     * 위치 한 점. 60 s 창(에포크 정렬) 안에 이미 저장된 점이 있으면 쓰지 않는다 — 메모리 필터(ShipWriter)가 재시작으로 비었거나 재처리가 늦게 와도
     * '창마다 첫 보고 하나' 가 DB 에서 지켜진다(쓰는 스레드는 하나뿐이라 경합이 없다). 같은 (mmsi, ts) 는 PK 충돌로 무시.
     */
    private static final String POSITION_SQL = """
            INSERT INTO ship_position (mmsi, ts, geom, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider)
            SELECT ?::char(9), ?::timestamptz, ST_SetSRID(ST_MakePoint(?, ?), 4326), ?::real, ?::real, ?::smallint, ?::smallint, ?::text, ?::text
            WHERE NOT EXISTS (SELECT 1 FROM ship_position p WHERE p.mmsi = ?::char(9) AND p.ts >= ?::timestamptz AND p.ts < ?::timestamptz)
            ON CONFLICT (mmsi, ts) DO NOTHING""";

    /** 위치로 MMSI 행을 만들거나 first_seen/last_seen 만 넓힌다(정적 정보 열은 건드리지 않는다). */
    private static final String TOUCH_SQL = """
            INSERT INTO ship AS s (mmsi, first_seen, last_seen, provider) VALUES (?, ?, ?, ?)
            ON CONFLICT (mmsi) DO UPDATE SET first_seen = LEAST(s.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(s.last_seen, EXCLUDED.last_seen)
            WHERE EXCLUDED.last_seen > s.last_seen OR EXCLUDED.first_seen < s.first_seen""";

    /** 정적 정보 upsert: 더 오래된 내용(updated_at)이 최신을 덮지 않는다. */
    private static final String STATIC_SQL = """
            INSERT INTO ship AS s (mmsi, name, call_sign, imo, ship_type, dim_a, dim_b, dim_c, dim_d, draught_m, destination,
                                   eta_month, eta_day, eta_hour, eta_minute, first_seen, last_seen, updated_at, provider)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (mmsi) DO UPDATE SET
              name = EXCLUDED.name, call_sign = EXCLUDED.call_sign, imo = EXCLUDED.imo, ship_type = EXCLUDED.ship_type,
              dim_a = EXCLUDED.dim_a, dim_b = EXCLUDED.dim_b, dim_c = EXCLUDED.dim_c, dim_d = EXCLUDED.dim_d, draught_m = EXCLUDED.draught_m,
              destination = EXCLUDED.destination, eta_month = EXCLUDED.eta_month, eta_day = EXCLUDED.eta_day, eta_hour = EXCLUDED.eta_hour,
              eta_minute = EXCLUDED.eta_minute, updated_at = EXCLUDED.updated_at, provider = EXCLUDED.provider,
              first_seen = LEAST(s.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(s.last_seen, EXCLUDED.last_seen)
            WHERE s.updated_at IS NULL OR EXCLUDED.updated_at >= s.updated_at""";

    private final JdbcTemplate jdbc;
    private final JdbcClient db;

    public ShipRepository(JdbcTemplate jdbc, JdbcClient db) {
        this.jdbc = jdbc;
        this.db = db;
    }

    /** 위치 배치(60 s 창 가드 포함). */
    public void writePositions(List<ShipState> rows) {
        if (rows.isEmpty()) return;
        jdbc.batchUpdate(POSITION_SQL, rows, rows.size(), (ps, s) -> {
            long t = s.seenAt().getEpochSecond();
            long w0 = Math.floorDiv(t, WINDOW_S) * WINDOW_S;
            ps.setString(1, s.mmsi());
            ps.setObject(2, Sql.ts(s.seenAt()));
            ps.setDouble(3, s.lon());
            ps.setDouble(4, s.lat());
            setReal(ps, 5, s.sogKn());
            setReal(ps, 6, s.cogDeg());
            setShort(ps, 7, s.headingDeg());
            setShort(ps, 8, s.navStatus());
            ps.setString(9, s.positionSource());
            ps.setString(10, s.provider());
            ps.setString(11, s.mmsi());
            ps.setObject(12, Sql.ts(Instant.ofEpochSecond(w0)));
            ps.setObject(13, Sql.ts(Instant.ofEpochSecond(w0 + WINDOW_S)));
        });
    }

    /** MMSI 별 [첫, 마지막] 보고 시각으로 ship 행을 만들거나 넓힌다. */
    public void touch(Collection<ShipState> rows) {
        if (rows.isEmpty()) return;
        Map<String, Instant[]> span = new LinkedHashMap<>();
        Map<String, String> provider = new LinkedHashMap<>();
        for (ShipState s : rows) {
            Instant[] v = span.computeIfAbsent(s.mmsi(), k -> new Instant[]{s.seenAt(), s.seenAt()});
            if (s.seenAt().isBefore(v[0])) v[0] = s.seenAt();
            if (s.seenAt().isAfter(v[1])) v[1] = s.seenAt();
            provider.putIfAbsent(s.mmsi(), s.provider());
        }
        List<Map.Entry<String, Instant[]>> list = new ArrayList<>(span.entrySet());
        jdbc.batchUpdate(TOUCH_SQL, list, list.size(), (ps, e) -> {
            ps.setString(1, e.getKey());
            ps.setObject(2, Sql.ts(e.getValue()[0]));
            ps.setObject(3, Sql.ts(e.getValue()[1]));
            ps.setString(4, provider.get(e.getKey()));
        });
    }

    /** 정적 정보 한 건과 그것을 받은 시각(first/last_seen 후보). */
    public record StaticRow(ShipStatic stat, Instant receivedAt) {}

    /** MMSI 하나로 합친 정적 정보: 가장 새 내용 + 받은 시각 범위. */
    private record MergedStatic(ShipStatic stat, Instant firstSeen, Instant lastSeen) {}

    /**
     * 정적 정보 배치. 같은 MMSI 는 먼저 한 행으로 합친다(updated_at 이 가장 새 내용 — 같으면 뒤의 것, first_seen = 받은 시각의 최솟값,
     * last_seen = 최댓값): reWriteBatchedInserts 가 배치를 다중 VALUES INSERT 로 묶으면 한 문장 안의 같은 키는
     * "ON CONFLICT DO UPDATE command cannot affect row a second time"(SQLState 21000)으로 배치 전체를 실패시킨다(리뷰 2026-09-28b #9).
     */
    public void upsertStatics(List<StaticRow> rows) {
        if (rows.isEmpty()) return;
        Map<String, MergedStatic> byMmsi = new LinkedHashMap<>();
        for (StaticRow r : rows) {
            byMmsi.merge(r.stat().mmsi(), new MergedStatic(r.stat(), r.receivedAt(), r.receivedAt()), (a, b) -> new MergedStatic(
                    b.stat().updatedAt().isBefore(a.stat().updatedAt()) ? a.stat() : b.stat(),
                    b.firstSeen().isBefore(a.firstSeen()) ? b.firstSeen() : a.firstSeen(),
                    b.lastSeen().isAfter(a.lastSeen()) ? b.lastSeen() : a.lastSeen()));
        }
        List<MergedStatic> merged = new ArrayList<>(byMmsi.values());
        jdbc.batchUpdate(STATIC_SQL, merged, merged.size(), (ps, r) -> {
            ShipStatic s = r.stat();
            ps.setString(1, s.mmsi());
            ps.setString(2, s.name());
            ps.setString(3, s.callSign());
            setInt(ps, 4, s.imo());
            setShort(ps, 5, s.shipType());
            setShort(ps, 6, s.dimA());
            setShort(ps, 7, s.dimB());
            setShort(ps, 8, s.dimC());
            setShort(ps, 9, s.dimD());
            setReal(ps, 10, s.draughtM());
            ps.setString(11, s.destination());
            setShort(ps, 12, s.etaMonth());
            setShort(ps, 13, s.etaDay());
            setShort(ps, 14, s.etaHour());
            setShort(ps, 15, s.etaMinute());
            ps.setObject(16, Sql.ts(r.firstSeen()));
            ps.setObject(17, Sql.ts(r.lastSeen()));
            ps.setObject(18, Sql.ts(s.updatedAt()));
            ps.setString(19, s.provider());
        });
    }

    /**
     * 끝난 공백 하나(영구). 같은 (source, 구역, started_at) 는 무시(수집기 재발행·스트림 재처리 — V8 식 인덱스, 구역 없음은 '' 로 본다).
     * @return 새로 넣었으면 true
     */
    public boolean insertGap(AisGap g) {
        return db.sql("""
                INSERT INTO ingest_gap (source, started_at, ended_at, reason, provider, scope) VALUES (:src, :s, :e, :r, :p, :scope)
                ON CONFLICT (source, (coalesce(scope, '')), started_at) DO NOTHING""")
                .param("src", GAP_SOURCE).param("s", Sql.ts(g.startedAt())).param("e", Sql.ts(g.endedAt()))
                .param("r", g.reason()).param("p", g.provider() == null ? "unknown" : g.provider())
                .param("scope", g.scopeText(), Types.VARCHAR).update() > 0;
    }

    /**
     * [from, to] 와 겹치는 끝난 공백 중 <b>최신</b> limit 건(오래된 것부터 정렬). 잘렸는지는 호출자가 limit + 1 로 물어 판단한다
     * (계약 v3 §D — 예전에는 오래된 것부터 잘라 최근 공백이 빠졌다).
     */
    public List<AisGap> gaps(Instant from, Instant to, int limit) {
        return Sql.publicRead(db, """
                SELECT started_at, ended_at, reason, provider, scope FROM (
                  SELECT started_at, ended_at, reason, provider, scope FROM ingest_gap
                  WHERE source = :src AND started_at < :to AND ended_at > :from
                  ORDER BY started_at DESC LIMIT :lim) g
                ORDER BY started_at""")
                .param("src", GAP_SOURCE).param("from", Sql.ts(from)).param("to", Sql.ts(to)).param("lim", limit)
                .query(ShipRepository::gapRow).list();
    }

    /**
     * 선 끊기용: [from, to] 와 겹치고 길이가 minS 초 이상인 끝난 공백(오래된 것부터, 최대 limit 건). 응답용 목록({@link #gaps})과 따로 물어
     * 짧은 공백이 많아 그 목록이 잘려도 끊기 판정은 영향을 받지 않는다(계약 v3 §D).
     */
    public List<AisGap> gapsAtLeast(Instant from, Instant to, long minS, int limit) {
        return Sql.publicRead(db, """
                SELECT started_at, ended_at, reason, provider, scope FROM ingest_gap
                WHERE source = :src AND started_at < :to AND ended_at > :from AND extract(epoch FROM ended_at - started_at) >= :min
                ORDER BY started_at LIMIT :lim""")
                .param("src", GAP_SOURCE).param("from", Sql.ts(from)).param("to", Sql.ts(to)).param("min", minS).param("lim", limit)
                .query(ShipRepository::gapRow).list();
    }

    private static AisGap gapRow(java.sql.ResultSet rs, int i) throws SQLException {
        return new AisGap(rs.getObject(1, java.time.OffsetDateTime.class).toInstant(),
                rs.getObject(2, java.time.OffsetDateTime.class).toInstant(), rs.getString(3), rs.getString(4), scope(rs.getString(5)));
    }

    /** 저장된 구역 문자열(넣을 때 검사한 값) → 구역. 없거나 읽을 수 없으면 null — 모든 곳에 적용(선을 덜 끊는 쪽으로 추정하지 않는다). */
    static AisScope scope(String text) {
        if (text == null || text.isBlank()) return null;
        try {
            return AisScope.parse(text);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** 저장된 정적 정보 + first/last_seen(없으면 null). 정적 정보를 받은 적 없는 행은 static 필드가 모두 null 이다. */
    public record StoredShip(ShipStatic stat, Instant firstSeen, Instant lastSeen) {}

    public StoredShip find(String mmsi) {
        return Sql.publicRead(db, """
                SELECT mmsi, name, call_sign, imo, ship_type, dim_a, dim_b, dim_c, dim_d, draught_m, destination,
                       eta_month, eta_day, eta_hour, eta_minute, first_seen, last_seen, updated_at, provider
                FROM ship WHERE mmsi = :m""").param("m", mmsi)
                .query((rs, i) -> {
                    java.time.OffsetDateTime upd = rs.getObject("updated_at", java.time.OffsetDateTime.class);
                    ShipStatic st = upd == null ? null : new ShipStatic(rs.getString("mmsi").trim(), rs.getString("name"), rs.getString("call_sign"),
                            (Integer) rs.getObject("imo"), shortObj(rs.getObject("ship_type")), shortObj(rs.getObject("dim_a")), shortObj(rs.getObject("dim_b")),
                            shortObj(rs.getObject("dim_c")), shortObj(rs.getObject("dim_d")), realObj(rs.getObject("draught_m")), rs.getString("destination"),
                            shortObj(rs.getObject("eta_month")), shortObj(rs.getObject("eta_day")), shortObj(rs.getObject("eta_hour")),
                            shortObj(rs.getObject("eta_minute")), upd.toInstant(), rs.getString("provider"));
                    return new StoredShip(st, rs.getObject("first_seen", java.time.OffsetDateTime.class).toInstant(),
                            rs.getObject("last_seen", java.time.OffsetDateTime.class).toInstant());
                }).optional().orElse(null);
    }

    /** 저장된 마지막 위치의 시각(보존 72 h 안, 없으면 null) — (mmsi, ts) PK 색인을 파티션마다 거꾸로 한 번씩 본다. */
    public Instant lastPositionAt(String mmsi) {
        return Sql.publicRead(db, "SELECT ts FROM ship_position WHERE mmsi = :m ORDER BY ts DESC LIMIT 1").param("m", mmsi)
                .query(java.time.OffsetDateTime.class).optional().map(java.time.OffsetDateTime::toInstant).orElse(null);
    }

    /** 저장된 위치 한 점(60 s 창의 첫 보고). */
    public record TrackPoint(Instant ts, double lon, double lat, Double sogKn, Double cogDeg, Integer headingDeg, Integer navStatus,
                             String positionSource, String provider) {}

    /** [from, to] 의 저장 위치(시간순, 최대 limit 점). */
    public List<TrackPoint> track(String mmsi, Instant from, Instant to, int limit) {
        return Sql.publicRead(db, """
                SELECT ts, ST_X(geom) lon, ST_Y(geom) lat, sog_kn, cog_deg, heading_deg, nav_status, position_source, provider
                FROM ship_position WHERE mmsi = :m AND ts BETWEEN :from AND :to ORDER BY ts LIMIT :lim""")
                .param("m", mmsi).param("from", Sql.ts(from)).param("to", Sql.ts(to)).param("lim", limit)
                .query((rs, i) -> new TrackPoint(rs.getObject("ts", java.time.OffsetDateTime.class).toInstant(), rs.getDouble("lon"), rs.getDouble("lat"),
                        realObj(rs.getObject("sog_kn")), realObj(rs.getObject("cog_deg")), shortObj(rs.getObject("heading_deg")),
                        shortObj(rs.getObject("nav_status")), rs.getString("position_source"), rs.getString("provider")))
                .list();
    }

    // ---- 바인딩 도우미(null 은 타입 있는 NULL 로 — 모르는 값을 0 으로 쓰지 않는다) ----

    private static void setReal(PreparedStatement ps, int i, Double v) throws SQLException {
        if (v == null) ps.setNull(i, Types.REAL); else ps.setFloat(i, v.floatValue());
    }

    private static void setShort(PreparedStatement ps, int i, Integer v) throws SQLException {
        if (v == null) ps.setNull(i, Types.SMALLINT); else ps.setShort(i, v.shortValue());
    }

    private static void setInt(PreparedStatement ps, int i, Integer v) throws SQLException {
        if (v == null) ps.setNull(i, Types.INTEGER); else ps.setInt(i, v);
    }

    private static Integer shortObj(Object o) { return o == null ? null : ((Number) o).intValue(); }

    /** real 열 → Double: float 을 그대로 넓히면 0.1 이 0.10000000149 가 된다 — 짧은 십진 표현으로 되돌린다. */
    private static Double realObj(Object o) {
        if (o == null) return null;
        if (o instanceof Float f) return Double.parseDouble(Float.toString(f));
        return ((Number) o).doubleValue();
    }
}
