package dev.wakeline.platform.data;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;

/**
 * 저장기(DB 쓰기 큐)의 밀림 — /healthz 의 writer_backlog 와 지표 wakeline_writer_oldest_pending_seconds{writer}(ADR-032). QA 2026-10(신뢰성 개선
 * 제안 4): DB 를 60 s 멈추고 40 s 끈 동안 /healthz 는 내내 ok 였고 그동안 항적 큐 887 행 · 선박 큐 347 행이 쌓였다.
 */
public interface WriteBacklog {
    /** 지표 · 진단 이름(track · ship · ordered). */
    String writerName();

    /**
     * 아직 쓰지 못한 것 중 가장 오래된 것이 큐에 들어온 시각(epoch ms), 없으면 -1. 쓰는 중(재시도 중 포함)인 배치 · 작업도 '쓰지 못한 것'이다 —
     * DB 가 답하지 않으면 그 배치가 백오프로 머무르며 이 값이 그대로 남아 나이가 늘어난다.
     */
    long oldestPendingAtMs();

    /** 지금 시각 기준 가장 오래된 미기록 것의 나이(ms), 없으면 0. */
    static long oldestPendingAgeMs(WriteBacklog w, long nowMs) {
        long at = w.oldestPendingAtMs();
        return at < 0 ? 0 : Math.max(0, nowMs - at);
    }

    /** 지표 wakeline_writer_oldest_pending_seconds{writer} — 저장기 생성자가 부른다. */
    static void gauge(WriteBacklog w, MeterRegistry meters) {
        Gauge.builder("wakeline_writer_oldest_pending_seconds", w, x -> oldestPendingAgeMs(x, System.currentTimeMillis()) / 1000.0)
                .tag("writer", w.writerName())
                .description("아직 DB 에 쓰지 못한 것 중 가장 오래된 것의 나이(쓰는 중 · 재시도 중 포함, 없으면 0) — /healthz 의 writer_backlog 기준")
                .register(meters);
    }
}
