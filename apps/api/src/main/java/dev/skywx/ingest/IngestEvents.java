package dev.skywx.ingest;

/** 스트림 소비 결과를 알리는 애플리케이션 이벤트. 엔진·WS 허브·저장기가 구독한다. */
public final class IngestEvents {
    private IngestEvents() {}

    public record SnapshotUpdated(Snapshot previous, Snapshot current) {}

    public record SigmetsUpdated(SigmetStore.State state) {}

    public record RadarUpdated(RadarStore.Frames frames) {}
}
