package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-79: api 는 단일 인스턴스다(스트림 소비자 이름 'api-1' 고정 · 수요 임대 유일 작성자 · 프로세스 안 알림 id). 실행 중인 api 는 Redis 에
 * 인스턴스 임대(wakeline:api:instance, 짧은 TTL, 주기 갱신)를 쥐고, 두 번째 인스턴스는 그 임대가 살아 있으면 기동하지 못한다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class SingleInstanceIT extends IntegrationTest {

    @org.springframework.beans.factory.annotation.Autowired org.springframework.context.ApplicationContext ctx;

    @Test
    void theRunningApiHoldsTheInstanceLease() {
        String holder = ItStack.admin().opsForValue().get("wakeline:api:instance");
        assertThat(holder).as("instance lease holder").isNotBlank();
        assertThat(holder).isEqualTo(ctx.getBean(dev.wakeline.ingest.SingleInstanceGuard.class).instanceId());
        Long ttlMs = ItStack.admin().getExpire("wakeline:api:instance", java.util.concurrent.TimeUnit.MILLISECONDS);
        assertThat(ttlMs).as("lease expires when the process dies").isBetween(1L, 15_000L);
    }
}
