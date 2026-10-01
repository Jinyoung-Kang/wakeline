package dev.wakeline.ops;

import dev.wakeline.platform.data.Sql;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;

/**
 * ops_resolution(V13) 문장. api 계정은 SELECT · INSERT 와 revoked_at · revoked_by 열의 UPDATE 만 — 행을 지우지 않는다(되돌림도 기록이다).
 * 트랜잭션 · 감사는 {@link ResolutionService} 가 건다.
 */
@Repository
public class ResolutionRepository {
    /**
     * 활성 해결 읽기 문장의 상한(초) — 넘으면 예외 → 서비스가 마지막 값으로 버틴다. 문장만 덮는다: 풀에서 연결을 얻는 대기(hikari connection-timeout)는
     * 따로다. 그 대기를 한 요청만 겪도록 서비스가 다시 읽기를 하나로 묶고 다른 요청에는 지난 값을 준다(ResolutionService).
     */
    static final int READ_TIMEOUT_S = 3;
    private static final String COLUMNS = "id, kind, key, upto, resolved_at, resolved_by, note";

    /** 되돌린 행: 되돌리기 전의 해결과 되돌린 시각 · 사람. */
    public record Revoked(Resolution resolution, Instant revokedAt, String revokedBy) {}

    private final JdbcClient db;

    public ResolutionRepository(JdbcClient db) { this.db = db; }

    /** 활성(되돌리지 않은) 해결, 최신 순. */
    public List<Resolution> active() {
        return db.sql("SELECT " + COLUMNS + " FROM ops_resolution WHERE revoked_at IS NULL ORDER BY resolved_at DESC, id DESC")
                .withQueryTimeout(READ_TIMEOUT_S).query(ROW).list();
    }

    public Resolution insert(String kind, String key, Instant upto, String by, String note) {
        return db.sql("INSERT INTO ops_resolution (kind, key, upto, resolved_by, note) VALUES (:kind, :key, :upto, :by, :note) RETURNING " + COLUMNS)
                .param("kind", kind).param("key", key).param("upto", Sql.ts(upto)).param("by", by).param("note", note).query(ROW).single();
    }

    /** 활성 행이면 되돌리고(revoked_at = now()) 그 행을, 없거나 이미 되돌렸으면 null. 두 요청이 겹쳐도 한 번만 된다(WHERE revoked_at IS NULL). */
    public Revoked revoke(long id, String by) {
        return db.sql("UPDATE ops_resolution SET revoked_at = now(), revoked_by = :by WHERE id = :id AND revoked_at IS NULL RETURNING "
                        + COLUMNS + ", revoked_at, revoked_by")
                .param("id", id).param("by", by)
                .query((rs, n) -> new Revoked(ROW.mapRow(rs, n), instant(rs, "revoked_at"), rs.getString("revoked_by"))).optional().orElse(null);
    }

    static final RowMapper<Resolution> ROW = (rs, n) -> new Resolution(rs.getLong("id"), rs.getString("kind"), rs.getString("key"),
            instant(rs, "upto"), instant(rs, "resolved_at"), rs.getString("resolved_by"), rs.getString("note"));

    private static Instant instant(ResultSet rs, String col) throws SQLException {
        OffsetDateTime t = rs.getObject(col, OffsetDateTime.class);
        return t == null ? null : t.toInstant();
    }
}
