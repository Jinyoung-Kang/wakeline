package dev.wakeline.platform.support;

/**
 * 수집 파이프라인 이벤트의 표시(리뷰 cto-2026-10 api §2.5-1). 스트림 소비 · 엔진이 발행하는 애플리케이션 이벤트의 페이로드가 이것을 구현하면
 * 이벤트 멀티캐스터(PipelineEventMulticaster)가 그 이벤트의 리스너를 서로 격리한다 — 한 리스너의 예외가 다음 리스너와 발행자(스트림 소비 스레드)로
 * 새지 않는다(API-CONC-2). 예전에는 페이로드를 감싼 클래스가 IngestEvents · EngineEvents 인지로 판단해, 이벤트 묶음을 새로 만들거나 나누면 조용히
 * 격리를 잃었다. 이벤트 묶음(이름이 *Events 인 클래스)의 record 와 dev.wakeline 의 모든 @EventListener 페이로드가 이 표시를 갖는지는
 * PipelineEventTest 가 지킨다.
 */
public interface PipelineEvent {}
