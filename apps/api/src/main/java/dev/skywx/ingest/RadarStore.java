package dev.skywx.ingest;

import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/** RainViewer 프레임 목록(host, past[]). 타일 자체는 브라우저가 직접 받는다. */
@Component
public class RadarStore {
    public record Frame(long time, String path) {}
    public record Frames(String host, long generated, List<Frame> past, Instant fetchedAt, String provider) {
        public static Frames empty() { return new Frames("", 0, List.of(), Instant.EPOCH, "-"); }
    }

    private final AtomicReference<Frames> frames = new AtomicReference<>(Frames.empty());

    public Frames frames() { return frames.get(); }
    public void replace(Frames f) { frames.set(f); }
}
