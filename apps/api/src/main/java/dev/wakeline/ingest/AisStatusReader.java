package dev.wakeline.ingest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * ais 수집기의 상태 해시(wakeline:ais:status, 계약 v2 §B1)를 5 s 마다 한 번 읽어 {@link AisStatus} 에 넘긴다(스케줄러 스레드 — 요청·세션마다
 * 읽지 않는다). 읽기 실패(Redis 장애)는 넘기지 않아 이전 값이 남고 heartbeat 가 저절로 오래된다. 예전에는 AisStatus.refresh 가 읽고 ShipSweeper 가
 * 불렀다 — 판단(AisStatus)과 Redis 읽기를 나눴다(리뷰 cto-2026-10 api §2.1 규칙 4: 업무 규칙 쪽은 Redis 를 import 하지 않는다).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Component
public class AisStatusReader {
    private static final Logger log = LoggerFactory.getLogger(AisStatusReader.class);
    private final StringRedisTemplate redis;
    private final AisStatus status;

    public AisStatusReader(StringRedisTemplate redis, AisStatus status) {
        this.redis = redis;
        this.status = status;
    }

    /** 해시를 한 번 읽는다(스케줄러 스레드). 실패하면 이전 값을 둔다. */
    @Scheduled(initialDelay = 1_000, fixedDelay = 5_000)
    public void refresh() {
        try {
            status.update(redis.opsForHash().entries(AisStatus.KEY));
        } catch (RuntimeException e) {
            log.debug("ais status unavailable: {}", e.toString());
        }
    }
}
