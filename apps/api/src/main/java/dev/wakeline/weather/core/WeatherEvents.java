package dev.wakeline.weather.core;

import dev.wakeline.platform.support.PipelineEvent;
import dev.wakeline.platform.support.Receipt;

import java.time.Instant;
import java.util.Map;
import java.util.Set;

/**
 * SIGMET · 레이더 스트림 소비 결과를 알리는 애플리케이션 이벤트(IngestEvents 에서 나눴다). 엔진·WS 허브·SIGMET 저장기가 구독한다(동기 — 스트림 소비
 * 스레드에서 차례로). 결과를 비동기로 저장하는 리스너는 receipt 를 hold 하고 durable 해지면 release 한다 — 그때 메시지를 XACK 한다({@link Receipt}).
 */
public final class WeatherEvents {
    private WeatherEvents() {}

    public record SigmetsUpdated(SigmetStore.State state) implements PipelineEvent {}

    /**
     * 새 수신 없이 유효시간 만료로 활성 SIGMET 집합이 줄었다(엔진의 주기 점검이 발행).
     * state 는 내용이 같고 version 만 오른 상태 — WS 는 SigmetsUpdated 와 똑같이 모든 구독 세션에 다시 보낸다.
     * DB 저장 대상은 아니다(내용 변화 없음).
     */
    public record SigmetsExpired(SigmetStore.State state, Set<String> expiredIds) implements PipelineEvent {}

    public record RadarUpdated(RadarStore.Frames frames) implements PipelineEvent {}

    /**
     * SIGMET 세트 한 벌을 <b>스트림 순서대로</b> 이력(DB)에 남기라는 이벤트(API-CONC-1). 실시간 저장소(SigmetStore)에 반영됐는지와
     * 무관하다 — 재시작 뒤 밀린 세트(백로그)도 이것으로 저장된다. 이전에는 백로그 세트를 저장하지 않아 api 가 멈춘 동안 발표·만료·철회된
     * 경보가 재생·통계에서 사라졌다. 같은 세트가 다시 오면(재전달·부트스트랩) 저장기가 수신 시각 기준으로 건너뛴다.
     */
    public record SigmetSetReceived(Instant fetchedAt, String provider, Map<String, SigmetRecord> byId, Receipt receipt) implements PipelineEvent {
        public SigmetSetReceived(Instant fetchedAt, String provider, Map<String, SigmetRecord> byId) { this(fetchedAt, provider, byId, Receipt.NONE); }
    }
}
