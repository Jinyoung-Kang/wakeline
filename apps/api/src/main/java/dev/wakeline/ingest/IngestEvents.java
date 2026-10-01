package dev.wakeline.ingest;

import dev.wakeline.domain.AisGap;
import dev.wakeline.domain.ShipState;
import dev.wakeline.domain.ShipStatic;
import dev.wakeline.domain.SigmetRecord;
import dev.wakeline.platform.support.PipelineEvent;
import dev.wakeline.platform.support.Receipt;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 스트림 소비 결과를 알리는 애플리케이션 이벤트. 엔진·WS 허브·저장기가 구독한다(동기 — 스트림 소비 스레드에서 차례로).
 * 결과를 비동기로 저장하는 리스너는 receipt 를 hold 하고 durable 해지면 release 한다 — 그때 메시지를 XACK 한다({@link Receipt}).
 */
public final class IngestEvents {
    private IngestEvents() {}

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

    /**
     * 선박(AIS) 실시간 상태가 바뀌었다(계약 v2 §B3). 스트림 소비(ships 메시지 — states·statics 는 메시지에 든 모든 보고, 저장 대상)와
     * 만료 점검(removed 만, 저장할 것 없음)·부트스트랩(아무것도 저장하지 않음)이 발행한다.
     * changed = 실시간 상태가 실제로 바뀐 MMSI(위치 또는 정적 정보), removed = 실시간 목록에서 빠진 MMSI.
     * 저장기(ShipWriter)는 receipt 를 hold 하고 커밋 뒤 release 한다 → 그때 XACK.
     */
    public record ShipsUpdated(Instant fetchedAt, String provider, List<ShipState> states, List<ShipStatic> statics,
                               Set<String> changed, Set<String> removed, Receipt receipt) implements PipelineEvent {
        /** 저장할 보고 없이 실시간 목록만 바뀐 경우(만료·부트스트랩). */
        public static ShipsUpdated liveOnly(Set<String> changed, Set<String> removed) {
            return new ShipsUpdated(null, null, List.of(), List.of(), changed, removed, Receipt.NONE);
        }
    }

    /**
     * 선박 저장기(persist.ShipWriter)가 한 ships 메시지에서 저장하려고 고른 위치(MMSI 별 60 s 창의 첫 보고 · 저장 범위 안 — ship_position 에 쓰는 것과 같은 표본).
     * 저장 성공과는 무관하다(받은 것의 표본). 관측 수신 격자(ADR-027 · coverage.ShipCoverage)가 센다 — 부트스트랩이 읽는 ship_position 과 실시간 셈이 같은 뜻.
     * 스트림 소비 스레드에서 ShipsUpdated 처리 중에 발행되는 파이프라인 이벤트라 리스너 예외는 그 리스너에 가둔다(API-CONC-2 — 저장기로 새지 않는다).
     */
    public record ShipsSampled(List<ShipState> positions) implements PipelineEvent {}

    /**
     * AIS 수신 공백 하나가 끝났다(kind ais_gap) — 저장기가 ingest_gap 에 남긴다(영구, 중복은 (source, 구역(scope), started_at) 으로 무시 — V8).
     * 같은 시각에 시작해도 구역이 다르면 다른 공백이다.
     */
    public record AisGapReceived(AisGap gap, Receipt receipt) implements PipelineEvent {}
}
