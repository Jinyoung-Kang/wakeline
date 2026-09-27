package dev.skywx.rest;

import dev.skywx.ingest.SnapshotStore;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.Map;

/** edge 가 노출하는 /healthz — 프로세스 생존 + 스트림 소비 지연(수치 최소). actuator 는 내부 포트에만. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
public class HealthController {
    private final SnapshotStore snapshots;

    public HealthController(SnapshotStore snapshots) { this.snapshots = snapshots; }

    @GetMapping("/healthz")
    public ResponseEntity<Map<String, Object>> healthz() {
        double lag = snapshots.region().lagSeconds(Instant.now());
        return ResponseEntity.ok(Map.of("status", "ok", "region_lag_s", lag < 0 ? -1 : Math.round(lag), "snapshot_version", snapshots.version()));
    }
}
