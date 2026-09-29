package dev.wakeline.ops;

import dev.wakeline.config.Problem;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 해결 표시 API(계약 v5 §G13 · ADR-022) — 운영 전용: /api/v1/ops/** 규칙(운영 세션 필요 · 익명 404 · 쓰기는 CSRF, 없으면 403).
 * 쓰기는 감사(RESOLVE · UNRESOLVE)와 한 트랜잭션이다({@link ResolutionService}). 증거(로그 · 실행 기록 · 공급자 상태)는 지우지 않는다.
 * <ul>
 *   <li>POST /api/v1/ops/resolutions {kind, key, upto?, note?} → 201 {id, kind, key, upto, resolved_at, resolved_by, note}. JSON 이 아니면 415,
 *       본문 규칙({@link ResolutionService#parse(tools.jackson.databind.JsonNode)})에 맞지 않으면 400 BAD_RESOLUTION.</li>
 *   <li>GET /api/v1/ops/resolutions → {items: [활성 해결, 최신 순], resolution_state}. 해결 기록을 한 번도 읽지 못했으면(DB 장애) 503 —
 *       빈 목록으로 "해결 없음" 을 지어내지 않는다(Retry-After: 30 — 다시 읽는 간격). 읽기에 실패해 마지막 값을 보이면 resolution_state = "stale".</li>
 *   <li>DELETE /api/v1/ops/resolutions/{id} → 204(revoked_at · revoked_by 를 채운다 — 행은 남는다). 없는 id · 이미 되돌린 행은 404.</li>
 * </ul>
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/ops/resolutions")
public class ResolutionController {
    private final ResolutionService resolutions;
    private final AuditService audit;

    public ResolutionController(ResolutionService resolutions, AuditService audit) {
        this.resolutions = resolutions;
        this.audit = audit;
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Resolution> create(@RequestBody(required = false) String body, HttpServletRequest req, Authentication auth) {
        ResolutionService.Draft d = resolutions.parse(body);
        Integer uid = userId(auth);
        Resolution r = resolutions.create(d, auth.getName(), (target, before, after) -> audit.record(req, uid, "RESOLVE", target, before, after));
        return ResponseEntity.status(HttpStatus.CREATED).body(r);
    }

    @GetMapping
    public Map<String, Object> list() {
        Resolutions r = resolutions.active();
        // Retry-After = 다시 읽는 간격(실패한 읽기는 그동안 캐시된다 — 계약 §2 의 기본 10 s 뒤 재시도는 같은 503 을 받는다)
        if (r.state() == Resolutions.State.UNAVAILABLE)
            throw new Problem(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE", "service unavailable", "resolutions could not be read from the database",
                    (int) ResolutionService.RETRY_S);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("items", r.items());
        m.put("resolution_state", r.state().label());
        return m;
    }

    @DeleteMapping("/{id:\\d{1,18}}")
    public ResponseEntity<Void> revoke(@PathVariable long id, HttpServletRequest req, Authentication auth) {
        Integer uid = userId(auth);
        resolutions.revoke(id, auth.getName(), (target, before, after) -> audit.record(req, uid, "UNRESOLVE", target, before, after));
        return ResponseEntity.noContent().build();
    }

    private static Integer userId(Authentication auth) { return auth instanceof OpsAuthentication o ? o.user().id() : null; }
}
