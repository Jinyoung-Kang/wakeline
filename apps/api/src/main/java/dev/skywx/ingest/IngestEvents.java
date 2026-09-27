package dev.skywx.ingest;

import dev.skywx.domain.AircraftState;

import java.time.Instant;
import java.util.Collection;
import java.util.Set;

/** 스트림 소비 결과를 알리는 애플리케이션 이벤트. 엔진·WS 허브·저장기가 구독한다. */
public final class IngestEvents {
    private IngestEvents() {}

    public record SnapshotUpdated(Snapshot previous, Snapshot current) {}

    public record SigmetsUpdated(SigmetStore.State state) {}

    /**
     * 새 수신 없이 유효시간 만료로 활성 SIGMET 집합이 줄었다(엔진의 주기 점검이 발행).
     * state 는 내용이 같고 version 만 오른 상태 — WS 는 SigmetsUpdated 와 똑같이 모든 구독 세션에 다시 보낸다.
     * DB 저장 대상은 아니다(내용 변화 없음).
     */
    public record SigmetsExpired(SigmetStore.State state, Set<String> expiredIds) {}

    public record RadarUpdated(RadarStore.Frames frames) {}

    /**
     * 현재 스냅샷보다 오래된(fetched_at 이 같거나 이전) 항공기 엔트리 — 재시작·재시도 후 밀린 백로그.
     * 실시간 상태·엔진·WS 는 되돌리지 않는다(스냅샷은 '최신만 의미'). 항적 기록(TrackWriter)만 이 이벤트로 이어서 저장한다.
     */
    public record AircraftBacklog(String scope, Instant fetchedAt, Collection<AircraftState> states) {}
}
