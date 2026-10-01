package dev.wakeline.platform.web;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.data.redis.core.StringRedisTemplate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 리뷰 cto-2026-10 A4(B10): 공개 API 요청 제한은 Redis 장애면 연다(가용성 우선 — edge 의 1차 제한은 남는다). 예전에는 열린 것을 아무도 몰랐다 — 지표도
 * 로그도 없었다. 이제 wakeline_rate_limiter_errors_total{bucket} 로 세고 WARN 은 분에 한 번(스택 없음). 보안 경로(hitStrict)는 전처럼 던진다(호출자가 503).
 */
@ExtendWith(OutputCaptureExtension.class)
class RateLimiterTest {
    @Test
    void aRedisFailureOpensThePublicLimitButIsCountedAndWarnedOncePerMinute(CapturedOutput out) {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        RateLimiter limiter = new RateLimiter(new StringRedisTemplate(), meters); // 연결 없음 — Redis 오류
        for (int i = 0; i < 3; i++) assertThat(limiter.hit("api", "1.2.3.4", 60)).containsExactly(0, 60);
        assertThat(meters.find("wakeline_rate_limiter_errors_total").tag("bucket", "api").counter().count()).isEqualTo(3.0);
        assertThat(out.getAll().split("rate limiter unavailable", -1)).as("one WARN, not one per request").hasSize(2);
        assertThat(out.getAll()).contains("'api' limit is open");
        assertThatThrownBy(() -> limiter.hitStrict("login", "1.2.3.4", 60)).isInstanceOf(RuntimeException.class);
    }
}
