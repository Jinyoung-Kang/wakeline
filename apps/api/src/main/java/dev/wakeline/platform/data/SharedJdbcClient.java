package dev.wakeline.platform.data;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * 공유 풀의 JdbcClient(앱의 JdbcClient 빈 — {@code platform.config.SharedPoolConfig}). 문장은 모두 공유 풀로 그대로 가고, 공개 조회({@link Sql#publicRead})만
 * 같은 풀을 {@link PublicReadGate} 를 지나 빌린다(리뷰 cto-2026-10 D6). 저장소는 늘 받던 JdbcClient 를 그대로 받는다 — 공개 조회인지는
 * Sql.publicRead 가 이 형으로 안다. 시험이 저장소에 직접 넘기는 평범한 JdbcClient 는 격벽이 없다(전과 같다).
 */
public final class SharedJdbcClient implements JdbcClient {
    private final JdbcClient all;
    private final JdbcClient publicReads;

    /**
     * @param all         공유 풀 그대로(Spring Boot 가 만들던 것과 같이 NamedParameterJdbcTemplate 위)
     * @param publicReads 같은 풀을 격벽({@link PublicReadGate#guard})으로 감싼 DataSource 위
     */
    public SharedJdbcClient(JdbcClient all, JdbcClient publicReads) {
        this.all = all;
        this.publicReads = publicReads;
    }

    @Override
    public StatementSpec sql(String sql) { return all.sql(sql); }

    /**
     * 공개 조회가 쓸 JdbcClient. 트랜잭션 안이면 격벽 없이 공유 풀 그대로 — 감싼 DataSource 는 다른 DataSource 라 트랜잭션에 묶인 연결 대신 새 연결을
     * 빌리게 된다(공개 조회는 트랜잭션 안에서 돌지 않지만, 그렇게 바뀌어도 트랜잭션 밖으로 새지 않게).
     */
    JdbcClient publicReads() { return TransactionSynchronizationManager.isActualTransactionActive() ? all : publicReads; }
}
