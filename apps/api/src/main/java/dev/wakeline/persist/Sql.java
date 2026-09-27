package dev.wakeline.persist;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;

/** JDBC 바인딩 도우미: pgjdbc 는 java.time.Instant 를 직접 바인딩하지 못하므로 timestamptz 는 OffsetDateTime(UTC)으로 넘긴다. */
public final class Sql {
    private Sql() {}

    public static OffsetDateTime ts(Instant i) { return i == null ? null : OffsetDateTime.ofInstant(i, ZoneOffset.UTC); }
}
