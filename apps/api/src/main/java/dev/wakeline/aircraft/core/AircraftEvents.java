package dev.wakeline.aircraft.core;

import dev.wakeline.platform.support.PipelineEvent;
import dev.wakeline.platform.support.Receipt;

import java.time.Instant;
import java.util.Collection;

/**
 * 항공기 스트림 소비 결과를 알리는 애플리케이션 이벤트(IngestEvents 에서 나눴다). 엔진·WS 허브·항적 저장기가 구독한다(동기 — 스트림 소비 스레드에서 차례로).
 * 결과를 비동기로 저장하는 리스너는 receipt 를 hold 하고 durable 해지면 release 한다 — 그때 메시지를 XACK 한다({@link Receipt}).
 */
public final class AircraftEvents {
    private AircraftEvents() {}

    public record SnapshotUpdated(Snapshot previous, Snapshot current, Receipt receipt) implements PipelineEvent {
        public SnapshotUpdated(Snapshot previous, Snapshot current) { this(previous, current, Receipt.NONE); }
    }

    /**
     * 현재 스냅샷보다 오래된(fetched_at 이 같거나 이전) 항공기 엔트리 — 재시작·재시도 후 밀린 백로그.
     * 실시간 상태·엔진·WS 는 되돌리지 않는다(스냅샷은 '최신만 의미'). 항적 기록(TrackWriter)만 이 이벤트로 이어서 저장한다.
     */
    public record AircraftBacklog(String scope, Instant fetchedAt, Collection<AircraftState> states, Receipt receipt) implements PipelineEvent {
        public AircraftBacklog(String scope, Instant fetchedAt, Collection<AircraftState> states) { this(scope, fetchedAt, states, Receipt.NONE); }
    }
}
