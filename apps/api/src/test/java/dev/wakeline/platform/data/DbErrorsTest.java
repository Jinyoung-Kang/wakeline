package dev.wakeline.platform.data;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.jdbc.UncategorizedSQLException;

import java.sql.SQLException;

import static org.assertj.core.api.Assertions.assertThat;

/** 쓰기 오류 분류(일시 · 영구) — OrderedWriterTest 에서 분류 함수와 함께 옮겼다(api-review §2.5-2 DbErrors). */
class DbErrorsTest {
    @Test
    void transientClassification() {
        assertThat(DbErrors.isTransient(new CannotGetJdbcConnectionException("x"))).isTrue();
        assertThat(DbErrors.isTransient(new RuntimeException(new SQLException("conn", "08006")))).isTrue();
        assertThat(DbErrors.isTransient(new RuntimeException(new SQLException("deadlock", "40P01")))).isTrue();
        assertThat(DbErrors.isTransient(new UncategorizedSQLException("x", "UPDATE", new SQLException("lock timeout", "55P03")))).isTrue();
        assertThat(DbErrors.isTransient(new UncategorizedSQLException("x", "UPDATE", new SQLException("object not in state", "55000")))).isFalse();
        assertThat(DbErrors.isTransient(new DataIntegrityViolationException("fk", new SQLException("fk", "23503")))).isFalse();
        assertThat(DbErrors.isPermanent(new RuntimeException(new SQLException("no partition", "23514")))).isTrue();
        assertThat(DbErrors.isPermanent(new RuntimeException(new SQLException("cannot affect row a second time", "21000")))).isTrue();
        assertThat(DbErrors.isPermanent(new CannotGetJdbcConnectionException("x"))).isFalse();
    }
}
