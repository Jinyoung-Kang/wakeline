package dev.wakeline.persist;

import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.AisScope;
import dev.wakeline.domain.ShipQuery;
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
     * '창마다 첫 보고 하나' 가 DB 에서 지켜진다(쓰는 스레드는 ShipWriter 워커 하나뿐 — 종료 flush 도 그 워커가 한다 — 이라 경합이 없다). 같은 (mmsi, ts) 는
     * PK 충돌로 무시.
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

    /**
     * 정적 정보 upsert: 더 오래된 내용(updated_at)이 최신을 덮지 않는다. 있는 행은 이 정적 정보가 덮어쓰는 필드({@link ShipStatic#written()} — 받은 필드,
     * 모르면 값이 있는 필드)만 바꾸고 나머지 열은 저장값을 둔다(계약 v5 §G19 — Class B 24A 만 받은 레코드가 저장된 호출부호 · 크기를 NULL 로 지우지 않게).
     * 열마다 불리언 매개변수(?) 하나 — VALUES 뒤의 매개변수라 pgjdbc 는 이 문장을 다중 VALUES 로 다시 쓰지 않는다(배치는 문장마다 — 정적 정보는 드물다).
     * 열 이름 = {@link ShipStatic#FIELDS}.
     */
    private static final String STATIC_SQL = """
            INSERT INTO ship AS s (mmsi, name, call_sign, imo, ship_type, dim_a, dim_b, dim_c, dim_d, draught_m, destination,
                                   eta_month, eta_day, eta_hour, eta_minute, first_seen, last_seen, updated_at, provider)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (mmsi) DO UPDATE SET
            """ + String.join(",\n", ShipStatic.FIELDS.stream().map(f -> "  " + f + " = CASE WHEN ? THEN EXCLUDED." + f + " ELSE s." + f + " END").toList())
            + """
            ,
              updated_at = EXCLUDED.updated_at, provider = EXCLUDED.provider,
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
     * 정적 정보 배치. 같은 MMSI 는 먼저 한 행으로 합친다 — updated_at 순으로 겹친다({@link ShipStatic#overlay}: 필드마다 그 필드를 덮어쓴 가장 새 것의 값,
     * 같은 시각이면 뒤의 것, 받은 필드는 합), first_seen = 받은 시각의 최솟값, last_seen = 최댓값. 한 행으로 만드는 까닭: 한 배치에 24A · 24B 가 따로 오면
     * 가장 새 것 하나만 쓰면 앞 것만 받은 필드를 잃고, 같은 키 두 행이 한 다중 VALUES 문장이 되면 "ON CONFLICT DO UPDATE command cannot affect row a second
     * time"(SQLState 21000)으로 배치 전체가 실패한다(리뷰 2026-09-28b #9).
     */
    public void upsertStatics(List<StaticRow> rows) {
        if (rows.isEmpty()) return;
        Map<String, MergedStatic> byMmsi = new LinkedHashMap<>();
        for (StaticRow r : rows) {
            byMmsi.merge(r.stat().mmsi(), new MergedStatic(r.stat(), r.receivedAt(), r.receivedAt()), (a, b) -> new MergedStatic(
                    b.stat().updatedAt().isBefore(a.stat().updatedAt()) ? b.stat().overlay(a.stat()) : a.stat().overlay(b.stat()),
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
            java.util.Set<String> written = s.written();
            for (int i = 0; i < ShipStatic.FIELDS.size(); i++) ps.setBoolean(20 + i, written.contains(ShipStatic.FIELDS.get(i)));
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
        return Sql.publicRead(db, "ais.gaps", """
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
        return Sql.publicRead(db, "ais.gaps_at_least", """
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

    /** ship 표의 정적 정보 열(조회 문장들이 같은 목록을 쓴다 — {@link #staticRow}). */
    private static final String STATIC_COLUMNS = """
            s.mmsi, s.name, s.call_sign, s.imo, s.ship_type, s.dim_a, s.dim_b, s.dim_c, s.dim_d, s.draught_m, s.destination,
            s.eta_month, s.eta_day, s.eta_hour, s.eta_minute, s.updated_at, s.provider""";

    public StoredShip find(String mmsi) { return find(db, mmsi); }

    /** MMSI 하나의 저장 행(공개 조회 상한) — 주어진 연결 출처로(REST 는 공유 풀, 선택 조회는 {@link ReadPool}). */
    public static StoredShip find(JdbcClient db, String mmsi) {
        return Sql.publicRead(db, "ship.find", "SELECT " + STATIC_COLUMNS + ", s.first_seen, s.last_seen FROM ship s WHERE s.mmsi = :m").param("m", mmsi)
                .query((rs, i) -> new StoredShip(staticRow(rs), rs.getObject("first_seen", java.time.OffsetDateTime.class).toInstant(),
                        rs.getObject("last_seen", java.time.OffsetDateTime.class).toInstant()))
                .optional().orElse(null);
    }

    /** 정적 정보를 받은 적 없는 행(updated_at NULL — 위치로만 만든 행)은 null. */
    private static ShipStatic staticRow(java.sql.ResultSet rs) throws SQLException {
        java.time.OffsetDateTime upd = rs.getObject("updated_at", java.time.OffsetDateTime.class);
        if (upd == null) return null;
        return new ShipStatic(rs.getString("mmsi").trim(), rs.getString("name"), rs.getString("call_sign"),
                (Integer) rs.getObject("imo"), shortObj(rs.getObject("ship_type")), shortObj(rs.getObject("dim_a")), shortObj(rs.getObject("dim_b")),
                shortObj(rs.getObject("dim_c")), shortObj(rs.getObject("dim_d")), realObj(rs.getObject("draught_m")), rs.getString("destination"),
                shortObj(rs.getObject("eta_month")), shortObj(rs.getObject("eta_day")), shortObj(rs.getObject("eta_hour")),
                shortObj(rs.getObject("eta_minute")), upd.toInstant(), rs.getString("provider"));
    }

    /**
     * 검색 결과 한 행: 저장된 정적 정보(받은 적 없으면 null) + ship.last_seen. last_seen 은 순서에 쓰고, 저장만 된 선박(실시간 아님)의
     * last_seen_at 으로도 나간다 — 위치로는 10분 단위로만 넓혀지므로 저장된 마지막 위치 시각과 둘 중 늦은 것(계약 v5 §G4, ShipController.lastSeenAt).
     */
    public record SearchRow(String mmsi, ShipStatic stat, Instant lastSeen) {}

    /**
     * 선박 검색(계약 v5 §B1 — 규칙은 {@link ShipQuery}): 정확 일치 → last_seen 최신 → MMSI 순으로 최대 limit 행. 조건마다 인덱스를 쓴다 —
     * MMSI 는 기본 키(앞부분은 9자리 숫자열 범위 [000…, 999…]), IMO 는 ship_imo, 선명·호출부호 앞부분은 바이트 순서 범위(~>=~ · ~<~)로
     * V10 ship_name_prefix · ship_call_sign_prefix(text_pattern_ops — 파라미터 그대로 일반 계획에서도 쓴다, AircraftRepository.search 와 같은 방식).
     */
    public List<SearchRow> search(ShipQuery q, int limit) {
        String where = switch (q.kind()) {
            case MMSI -> "s.mmsi = :q";
            case MMSI_PREFIX -> "s.mmsi BETWEEN :lo AND :hi";
            case MMSI_PREFIX_OR_IMO -> "(s.mmsi BETWEEN :lo AND :hi OR s.imo = :imo)";
            case IMO -> "s.imo = :imo";
            case NAME_OR_CALL_SIGN -> "((upper(s.name) ~>=~ :q AND upper(s.name) ~<~ :hi) OR (upper(s.call_sign) ~>=~ :q AND upper(s.call_sign) ~<~ :hi))";
        };
        // 정확 일치가 먼저(ShipQuery.exact 와 같은 뜻). MMSI 정확은 모두 정확, MMSI 앞부분은 정확 일치가 없다 — 순서 항을 두지 않는다(상수 ORDER BY 는 문법 오류)
        String exact = switch (q.kind()) {
            case MMSI, MMSI_PREFIX -> "";
            case MMSI_PREFIX_OR_IMO, IMO -> "coalesce(s.imo = :imo, false) DESC, ";
            case NAME_OR_CALL_SIGN -> "coalesce(upper(s.name) = :q OR upper(s.call_sign) = :q, false) DESC, ";
        };
        JdbcClient.StatementSpec st = Sql.publicRead(db, "ship.search", "SELECT " + STATIC_COLUMNS + ", s.last_seen FROM ship s WHERE " + where
                + " ORDER BY " + exact + "s.last_seen DESC, s.mmsi LIMIT :n").param("n", limit);
        switch (q.kind()) {
            case MMSI -> st = st.param("q", q.text());
            case MMSI_PREFIX -> st = st.param("lo", q.mmsiLow()).param("hi", q.mmsiHigh());
            case MMSI_PREFIX_OR_IMO -> st = st.param("lo", q.mmsiLow()).param("hi", q.mmsiHigh()).param("imo", q.imo());
            case IMO -> st = st.param("imo", q.imo());
            case NAME_OR_CALL_SIGN -> st = st.param("q", q.text()).param("hi", q.textHigh());
        }
        return st.query((rs, i) -> new SearchRow(rs.getString("mmsi").trim(), staticRow(rs),
                rs.getObject("last_seen", java.time.OffsetDateTime.class).toInstant())).list();
    }

    /** 저장된 정적 정보(받은 적 없거나 행이 없으면 null)와 마지막 저장 위치 시각(보존 72 h 안, 없으면 null). */
    public record Known(ShipStatic stat, Instant lastPositionAt) {}

    /**
     * 검색 결과 MMSI 들(≤ 20)의 {@link Known} — 한 문장. 마지막 위치 시각은 MMSI 마다 {@link #lastPositionAt} 와 같은 역순 한 행
     * ((mmsi, ts) 기본 키, 파티션마다). 저장된 것이 하나도 없는 MMSI 는 결과에 없다.
     */
    public Map<String, Known> lookup(Collection<String> mmsis) {
        if (mmsis.isEmpty()) return Map.of();
        Map<String, Known> out = new LinkedHashMap<>();
        Sql.publicRead(db, "ship.lookup", """
                SELECT u.m AS q_mmsi, s.mmsi, s.name, s.call_sign, s.imo, s.ship_type, s.dim_a, s.dim_b, s.dim_c, s.dim_d, s.draught_m, s.destination,
                       s.eta_month, s.eta_day, s.eta_hour, s.eta_minute, s.updated_at, s.provider,
                       (SELECT p.ts FROM ship_position p WHERE p.mmsi = u.m ORDER BY p.ts DESC LIMIT 1) AS last_position_at
                FROM unnest(string_to_array(:ids, ',')::char(9)[]) AS u(m) LEFT JOIN ship s ON s.mmsi = u.m""")
                .param("ids", String.join(",", mmsis))
                .query((java.sql.ResultSet rs) -> {
                    ShipStatic st = rs.getString("mmsi") == null ? null : staticRow(rs);
                    java.time.OffsetDateTime last = rs.getObject("last_position_at", java.time.OffsetDateTime.class);
                    if (st != null || last != null) out.put(rs.getString("q_mmsi").trim(), new Known(st, last == null ? null : last.toInstant()));
                });
        return out;
    }

    /** 저장된 마지막 위치의 시각(보존 72 h 안, 없으면 null) — (mmsi, ts) PK 색인을 파티션마다 거꾸로 한 번씩 본다. */
    public Instant lastPositionAt(String mmsi) {
        return Sql.publicRead(db, "ship.last_position", "SELECT ts FROM ship_position WHERE mmsi = :m ORDER BY ts DESC LIMIT 1").param("m", mmsi)
                .query(java.time.OffsetDateTime.class).optional().map(java.time.OffsetDateTime::toInstant).orElse(null);
    }

    /** 저장된 위치 한 점(60 s 창의 첫 보고). */
    public record TrackPoint(Instant ts, double lon, double lat, Double sogKn, Double cogDeg, Integer headingDeg, Integer navStatus,
                             String positionSource, String provider) {}

    /** [from, to] 의 저장 위치(시간순, 최대 limit 점). */
    public List<TrackPoint> track(String mmsi, Instant from, Instant to, int limit) {
        return Sql.publicRead(db, "ship.track", """
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
