package dev.wakeline.weather.core;

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

    /** fetched_at 단조 보장: 현재보다 새 목록일 때만 교체한다(백로그 재생이 되돌리지 않게). @return 교체했으면 true */
    public boolean replaceIfNewer(Frames f) {
        while (true) {
            Frames cur = frames.get();
            if (!f.fetchedAt().isAfter(cur.fetchedAt())) return false;
            if (frames.compareAndSet(cur, f)) return true;
        }
    }
}
