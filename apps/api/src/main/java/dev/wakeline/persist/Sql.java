package dev.wakeline.persist;

import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;

/** JDBC 바인딩 도우미: pgjdbc 는 java.time.Instant 를 직접 바인딩하지 못하므로 timestamptz 는 OffsetDateTime(UTC)으로 넘긴다. */
public final class Sql {
    private Sql() {}

    /**
     * 공개(인증 없는) REST 조회 문장의 상한(초, R-62 · ADR-017 §2). 넘으면 드라이버가 서버에 취소를 보내고(57014) 요청은 503 + Retry-After 가 된다 —
     * DB 가 느릴 때 공개 조회가 풀을 오래 잡아 기록기(항적·선박·알림)를 막지 못하게. 그 밖의 문장은 연결 설정(statement_timeout 30 s ·
     * lock_timeout 5 s, application.yml)이 상한이다.
     */
    public static final int PUBLIC_READ_TIMEOUT_S = 3;

    public static OffsetDateTime ts(Instant i) { return i == null ? null : OffsetDateTime.ofInstant(i, ZoneOffset.UTC); }

    /** 공개 REST 조회 문장({@value #PUBLIC_READ_TIMEOUT_S} s 상한). */
    public static JdbcClient.StatementSpec publicRead(JdbcClient db, String sql) {
        return db.sql(sql).withQueryTimeout(PUBLIC_READ_TIMEOUT_S);
    }
}
