package dev.wakeline.persist;

import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.regex.Pattern;

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

    /**
     * 공개 REST 조회 문장({@value #PUBLIC_READ_TIMEOUT_S} s 상한). label = 이 문장의 이름(예: replay.track_point) — {@link #tag} 로 SQL 앞 주석에 싣는다.
     * 문장이 실패하면 Spring 이 예외 메시지('SQL [...]')에 이 SQL 을 그대로 싣고, 503 WARN 이 거기서 이름과 이 문장의 한도를 읽는다
     * (ProblemAdvice.statement — 조사 2026-10-01 오류 F3: 재생은 이런 문장 3~4개를 차례로 내는데 어느 것이 끊겼는지 알 수 없었다). 같은 이름이
     * PostgreSQL 로그 · pg_stat_activity 의 문장 앞머리에도 보인다.
     */
    public static JdbcClient.StatementSpec publicRead(JdbcClient db, String label, String sql) {
        return db.sql(tag(label, PUBLIC_READ_TIMEOUT_S) + sql).withQueryTimeout(PUBLIC_READ_TIMEOUT_S);
    }

    /** 문장 이름의 모양 — SQL 주석 안에 들어가므로 주석을 닫거나 로그 줄을 깨는 글자는 받지 않는다. */
    static final Pattern LABEL = Pattern.compile("[a-z0-9_.]{1,64}");

    /** 문장 이름표(SQL 앞 주석): 호출부가 준 이름과 그 문장에 거는 한도(초). ProblemAdvice.STATEMENT_TAG 가 같은 모양을 읽는다. */
    public static String tag(String label, int limitS) {
        if (label == null || !LABEL.matcher(label).matches()) throw new IllegalArgumentException("statement label must match " + LABEL + ": " + label);
        return "/* wakeline " + label + " limit_s=" + limitS + " */ ";
    }
}
