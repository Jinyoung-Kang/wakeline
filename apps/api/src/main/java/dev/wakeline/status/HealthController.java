package dev.wakeline.status;

import dev.wakeline.ingest.IngestHealthIndicator;
import dev.wakeline.ingest.SnapshotStore;
import org.springframework.boot.health.contributor.Status;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * edge 가 노출하는 /healthz — 프로세스 생존 + 수집 경로 상태(수치 최소). actuator 는 내부 포트에만.
 * status: ok(수집 정상) | degraded(수집 지연·소비 정지 등 — reasons 에 원인 코드) | starting(기동 직후 아직 스냅샷 없음).
 * 프로세스가 응답하는 한 HTTP 200 이다(REL-20): edge 컨테이너 헬스체크가 이 주소를 쓰므로, 수집기 장애로 edge·api 가 '비정상' 이 되어
 * 재시작되지 않게 한다. 수집 경로 경보는 /actuator/health/ingest(내부, 503) 와 지표로 한다.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
public class HealthController {
    private final SnapshotStore snapshots;
    private final IngestHealthIndicator ingest;

    public HealthController(SnapshotStore snapshots, IngestHealthIndicator ingest) {
        this.snapshots = snapshots;
        this.ingest = ingest;
    }

    @GetMapping("/healthz")
    public ResponseEntity<Map<String, Object>> healthz() {
        IngestHealthIndicator.Verdict v = ingest.verdict();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("status", Status.UP.equals(v.status()) ? "ok" : Status.DOWN.equals(v.status()) ? "degraded" : "starting");
        if (!v.reasons().isEmpty()) m.put("reasons", v.reasons());
        m.put("region_lag_s", v.regionLagS() < 0 ? -1 : Math.round(v.regionLagS()));
        m.put("snapshot_version", snapshots.version());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(m);
    }
}
