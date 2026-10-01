package dev.wakeline.platform.support;

import org.springframework.context.SmartLifecycle;

/**
 * 스트림 소비자(ingest.StreamConsumer)가 메시지를 읽기 전에 돌고 있어야 하고, 소비자가 멈춘 뒤에야 멈추는 구성 요소(QA-100 · QA-105):
 * 메시지의 결과를 들고 가는 저장기(항적 · 선박 · 순서 큐 — 영수증을 잡아 행이 커밋된 뒤에만 ACK 되게 한다, at-least-once)와
 * 인스턴스 가드(임대를 쥔 프로세스만 읽는다 — R-79).
 * <p>
 * 순서는 phase 숫자가 아니라 <b>의존</b>으로 정한다: 소비자는 이것들을 모두 생성자로 받는다. Spring 의 lifecycle 처리기는 빈을 시작하기 전에 그 빈이
 * 의존하는 빈을 phase 와 상관없이 먼저 시작하고, 빈을 멈추기 전에 그 빈에 의존하는 빈을 먼저 멈춘다 — 그래서 다른 빈이 소비자에 의존해 소비자를
 * 일찍 시작시켜도 이것들이 먼저 시작하고, 종료 때는 소비자가 먼저 멈춘다. 예전에는 phase 만 믿었는데 더 낮은 phase 의 빈(StreamAckFinalizer)이
 * 소비자에 의존해 소비자를 가장 먼저 시작시켰다 — 저장기가 돌기 전에 처리한 선박 메시지의 행을 버리고 ACK 했다(QA-100, 영구 손실).
 * 소비자는 읽기마다 {@link #readyForStream()} 도 확인한다(가드가 Redis 장애로 임대 없이 기동한 경우 — 임대를 잡을 때까지 읽지 않는다).
 */
public interface StreamPrerequisite extends SmartLifecycle {

    /** 소비자가 지금 읽어도 되는가. 기본은 돌고 있는가(저장기는 돌고 있으면 행을 받아 영수증을 잡는다). */
    default boolean readyForStream() { return isRunning(); }
}
