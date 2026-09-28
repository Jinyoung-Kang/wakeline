package dev.wakeline.persist;

import dev.wakeline.domain.Bbox;
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

    /** [from, to] 의 항적(시간순, 앞에서부터 최대 limit 점 — 호출자가 limit + 1 로 물어 잘렸는지 안다). stepS > 0 이면 버킷마다 첫 점. */
    public List<Map<String, Object>> track(String hex, Instant from, Instant to, int stepS, int limit) {
        String sql = stepS > 0 ? """
                SELECT DISTINCT ON (bucket) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, provider,
                       to_timestamp(floor(extract(epoch FROM ts) / :step) * :step) bucket
                FROM track_point WHERE hex = :hex AND ts BETWEEN :from AND :to ORDER BY bucket, ts LIMIT :lim"""
                : """
                SELECT hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, provider
                FROM track_point WHERE hex = :hex AND ts BETWEEN :from AND :to ORDER BY ts LIMIT :lim""";
        var q = Sql.publicRead(db, sql).param("hex", hex).param("from", Sql.ts(from)).param("to", Sql.ts(to)).param("lim", limit);
        if (stepS > 0) q = q.param("step", stepS);
        return q.query().listOfRows().stream().map(r -> {
            var m = new java.util.LinkedHashMap<>(r);
            m.remove("bucket");
            m.put("ts", toInstant(m.get("ts")));
            return (Map<String, Object>) m;
        }).toList();
    }

    /** 재생 결과: 행 + 실제로 행을 준 테이블(track_point | track_point_1m | none, 계약 §2 — COR-22). */
    public record Replay(List<Map<String, Object>> aircraft, String source) {}

    /**
     * 시각 at 의 항공기(3분 창). 원해상도(track_point)가 비어 있을 때만 1분 요약(track_point_1m)으로 내려간다.
     * source 는 요청 시각으로 짐작하지 않고, 행을 실제로 준 질의로 정한다.
     * 행마다 averaged 를 단다(DH-11): false = 기록된 위치 그대로, true = 1분 동안의 위치·고도·속도 평균(요약 — 실제로 있던 한 점이
     * 아니다, samples = 평균에 쓴 점 수). 요약에는 방위·지상 여부가 없으므로 null(0·false 로 채우지 않는다).
     */
    public Replay replay(Instant at, Bbox b) {
        List<Map<String, Object>> rows = Sql.publicRead(db, """
                SELECT DISTINCT ON (hex) hex, ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, track_deg, on_ground, provider, false averaged
                FROM track_point
                WHERE ts BETWEEN :t - interval '3 minutes' AND :t
                  AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                ORDER BY hex, ts DESC""")
                .param("t", Sql.ts(at)).param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax())
                .query().listOfRows();
        String source = "track_point";
        if (rows.isEmpty()) {
            // 1분 요약에는 방위·지상 여부가 없다 — 모르는 값은 null 로 둔다(false·0 으로 채우지 않는다)
            rows = Sql.publicRead(db, """
                    SELECT DISTINCT ON (hex) hex, ts_minute ts, ST_X(geom) lon, ST_Y(geom) lat, alt_ft, gs_kt, NULL::real track_deg, NULL::boolean on_ground,
                           '1m_summary' provider, true averaged, n samples
                    FROM track_point_1m
                    WHERE ts_minute BETWEEN :t - interval '3 minutes' AND :t
                      AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                    ORDER BY hex, ts_minute DESC""")
                    .param("t", Sql.ts(at)).param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax())
                    .query().listOfRows();
            source = rows.isEmpty() ? "none" : "track_point_1m";
        }
        return new Replay(rows.stream().map(r -> { var m = new java.util.LinkedHashMap<>(r); m.put("ts", toInstant(m.get("ts"))); return (Map<String, Object>) m; }).toList(), source);
    }

    /** RainViewer 는 과거 프레임을 2시간만 제공한다 — 그보다 오래된 시각에는 레이더를 붙이지 않는다. */
    public static final java.time.Duration RADAR_REPLAY_WINDOW = java.time.Duration.ofHours(2);
    /** 재생 시각과 프레임 시각의 최대 차이. */
    public static final java.time.Duration RADAR_MATCH_TOLERANCE = java.time.Duration.ofMinutes(10);

    /**
     * 재생 시각 at 에 가장 가까운 저장된 RainViewer 프레임(±10분, collector 가 radar_frame 에 기록). at 이 최근 2시간 밖이면 null
     * (RainViewer 가 그 타일을 더 이상 주지 않는다). @return {host, path, time(유닉스 초 — /radar/frames 의 past[].time 과 같은 단위)} 또는 null
     */
    public Map<String, Object> radarFrameNear(Instant at, Instant now) {
        if (at.isBefore(now.minus(RADAR_REPLAY_WINDOW)) || at.isAfter(now.plus(RADAR_MATCH_TOLERANCE))) return null;
        return Sql.publicRead(db, """
                SELECT frame_time, host, path FROM radar_frame
                WHERE frame_time BETWEEN :lo AND :hi
                ORDER BY abs(extract(epoch FROM frame_time - :t)), frame_time DESC LIMIT 1""")
                .param("t", Sql.ts(at)).param("lo", Sql.ts(at.minus(RADAR_MATCH_TOLERANCE))).param("hi", Sql.ts(at.plus(RADAR_MATCH_TOLERANCE)))
                .query().listOfRows().stream().findFirst().map(r -> {
                    Map<String, Object> m = new java.util.LinkedHashMap<>();
                    m.put("host", r.get("host"));
                    m.put("path", r.get("path"));
                    Instant t = toInstant(r.get("frame_time"));
                    m.put("time", t == null ? null : t.getEpochSecond());
                    return m;
                }).orElse(null);
    }

    public static Instant toInstant(Object v) {
        if (v instanceof java.sql.Timestamp t) return t.toInstant();
        if (v instanceof java.time.OffsetDateTime o) return o.toInstant();
        if (v instanceof Instant i) return i;
        return null;
    }
}
