package dev.wakeline.ops;

import dev.wakeline.config.AppProperties;
import dev.wakeline.config.ClientIp;
import dev.wakeline.config.OpsSessionLifetimeFilter;
import dev.wakeline.config.Problem;
import dev.wakeline.config.RateLimiter;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.SecurityContextRepository;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 운영자 로그인(6.3절): BCrypt 검증 → LOGIN 감사 기록 → 세션 ID 교체 → Redis 세션(유휴 8 h, 로그인부터 절대 8 h — R-54) → HttpOnly·SameSite=Strict 쿠키 + CSRF 쿠키.
 * 감사 기록이 세션보다 먼저다(API-CONC-6): 기록이 실패하면(DB 장애) 세션을 만들지 않고 503 — 감사 기록 없는 인증 세션은 생기지 않는다.
 * 로그아웃은 반대로 세션 종료가 우선이다: 감사 기록 실패와 무관하게 세션을 무효화한다(권한을 줄이는 쪽은 실패하지 않게).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/ops/session")
public class OpsSessionController {
    private static final Logger log = LoggerFactory.getLogger(OpsSessionController.class);
    private final OpsUserService users;
    private final SecurityContextRepository contextRepository;
    private final AuditService audit;
    private final RateLimiter limiter;
    private final AppProperties props;
    private final Counter auditFailures;

    public OpsSessionController(OpsUserService users, SecurityContextRepository contextRepository, AuditService audit, RateLimiter limiter, AppProperties props,
                                MeterRegistry meters) {
        this.users = users;
        this.contextRepository = contextRepository;
        this.audit = audit;
        this.limiter = limiter;
        this.props = props;
        this.auditFailures = Counter.builder("wakeline_audit_failures_total").tag("action", "LOGOUT")
                .description("감사 기록 실패(로그아웃은 기록 실패와 무관하게 세션을 끝낸다)").register(meters);
    }

    /** IP당 분당 로그인 시도 상한. */
    static final int LOGIN_LIMIT_PER_MIN = 10;
    /** 없는 계정으로 실패한 로그인의 감사 target(R-55, ADR-017 §3 — 입력 원문은 저장하지 않는다). */
    static final String UNKNOWN_ACCOUNT = "unknown account";

    public record Login(@NotBlank @Size(max = 64) String username, @NotBlank @Size(min = 8, max = 256) String password) {}

    /**
     * 로그인. 요청 제한은 실패 시 닫힘(Redis 장애면 503 — 제한 없이 무차별 대입을 받지 않는다, SEC-6).
     * 실패도 감사 기록(LOGIN_FAILED, 잠금이 걸리면 ACCOUNT_LOCKED)을 남긴다. 응답은 사유를 구분하지 않는다.
     */
    @PostMapping
    public ResponseEntity<Map<String, Object>> login(@Valid @RequestBody Login body, HttpServletRequest req, HttpServletResponse res) {
        String ip = ClientIp.resolve(req, props.trustedProxy());
        long[] hit;
        try {
            hit = limiter.hitStrict("login", ip, 60);
        } catch (RuntimeException e) {
            throw Problem.unavailable("login temporarily unavailable");
        }
        if (hit[0] > LOGIN_LIMIT_PER_MIN) throw Problem.tooManyRequests("too many login attempts", hit[1]);
        var result = users.authenticate(body.username(), body.password());
        if (result.user().isEmpty()) {
            // 없는 계정이면 입력한 이름을 남기지 않는다(R-55): 아이디 칸에 잘못 친 비밀번호가 지울 수 없는 감사 로그에 남는다.
            // 있는 계정(틀린 비밀번호·잠김)은 계정 이름이 곧 입력값이다(정확히 일치해야 찾는다).
            String target = result.failure() == OpsUserService.Failure.UNKNOWN_USER ? UNKNOWN_ACCOUNT : body.username();
            audit.record(req, null, "LOGIN_FAILED", target, null, Map.of("reason", result.failure().name().toLowerCase(java.util.Locale.ROOT)));
            if (result.lockedNow())
                audit.record(req, null, "ACCOUNT_LOCKED", body.username(), null, Map.of("minutes", OpsUserService.LOCK_MINUTES, "after_failures", OpsUserService.MAX_FAILED));
            throw new Problem(HttpStatus.UNAUTHORIZED, "BAD_CREDENTIALS", "unauthorized", "invalid credentials");
        }
        var user = result.user().get();
        // 먼저 감사 기록 — 실패하면 예외(DataAccessException → 503)로 끝나고 세션·보안 컨텍스트는 만들어지지 않는다
        audit.record(req, user.id(), "LOGIN", user.username(), null, null);
        req.getSession(true);
        req.changeSessionId(); // 세션 고정 방지: 로그인 전 세션이 있었다면 ID 를 교체한다
        Authentication auth = new OpsAuthentication(user, List.of(new SimpleGrantedAuthority("ROLE_OPS")));
        SecurityContext ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(auth);
        SecurityContextHolder.setContext(ctx);
        contextRepository.saveContext(ctx, req, res);
        req.getSession().setAttribute("ops_user_id", user.id());
        // 절대 수명(R-54)의 기준 — 유휴 연장과 무관하게 로그인 시각부터 센다. 다시 로그인하면 새로 시작한다.
        req.getSession().setAttribute(OpsSessionLifetimeFilter.AUTH_AT, System.currentTimeMillis());
        return ResponseEntity.ok(Map.of("username", user.username(), "role", user.role()));
    }

    @GetMapping
    public ResponseEntity<Map<String, Object>> me(Authentication auth) {
        if (auth == null || !auth.isAuthenticated()) throw Problem.notFound("no such resource");
        return ResponseEntity.ok(Map.of("username", auth.getName(), "role", "OPS"));
    }

    /**
     * 로그아웃: 세션 무효화는 감사 기록 결과와 무관하게 한다. 기록 실패는 삼키지 않고 오류 로그 + wakeline_audit_failures_total{action=LOGOUT}
     * 로 남기고 204 를 준다 — 세션은 이미 끝났으므로 클라이언트에 '로그아웃 실패'로 보이면 안 된다.
     */
    @DeleteMapping
    public ResponseEntity<Void> logout(HttpServletRequest req, Authentication auth) {
        Integer uid = auth instanceof OpsAuthentication o ? o.user().id() : null;
        try {
            audit.record(req, uid, "LOGOUT", auth == null ? null : auth.getName(), null, null);
        } catch (RuntimeException e) {
            auditFailures.increment();
            log.error("LOGOUT audit record failed (session invalidated anyway): {}", e.toString());
        } finally {
            var s = req.getSession(false);
            if (s != null) s.invalidate();
            SecurityContextHolder.clearContext();
        }
        return ResponseEntity.noContent().build();
    }
}
