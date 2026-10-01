package dev.wakeline.platform.config;

import dev.wakeline.platform.data.PublicReadGate;
import dev.wakeline.platform.data.SharedJdbcClient;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

import javax.sql.DataSource;

/**
 * 앱의 JdbcClient 빈 — Spring Boot 가 만들던 것(NamedParameterJdbcTemplate 위)과 같고, 공개 조회만 공개 조회 격벽({@link PublicReadGate} — 리뷰
 * cto-2026-10 D6)을 지난다({@link SharedJdbcClient}). 이 빈이 있으면 Boot 의 JdbcClient 자동 구성은 물러난다.
 * 설정: wakeline.public-reads.permits(기본 {@value PublicReadGate#DEFAULT_PERMITS}) · wakeline.public-reads.wait-ms(기본
 * {@value PublicReadGate#DEFAULT_WAIT_MS}) — 크기는 docs/PERF.md §13 의 측정으로 골랐다.
 */
@Configuration(proxyBeanMethods = false)
public class SharedPoolConfig {
    @Bean
    JdbcClient jdbcClient(NamedParameterJdbcTemplate jdbc, DataSource dataSource, MeterRegistry meters,
                          @Value("${spring.datasource.hikari.maximum-pool-size:10}") int poolSize,
                          @Value("${wakeline.public-reads.permits:" + PublicReadGate.DEFAULT_PERMITS + "}") int permits,
                          @Value("${wakeline.public-reads.wait-ms:" + PublicReadGate.DEFAULT_WAIT_MS + "}") long waitMs) {
        PublicReadGate gate = new PublicReadGate(permits, waitMs, poolSize, meters);
        return new SharedJdbcClient(JdbcClient.create(jdbc), JdbcClient.create(gate.guard(dataSource)));
    }
}
