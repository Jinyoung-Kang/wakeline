package dev.wakeline.ops;

import dev.wakeline.config.AppProperties;
import dev.wakeline.config.ClientIp;
import dev.wakeline.config.Problem;
import dev.wakeline.config.RateLimiter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
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

/** 운영자 로그인(6.3절): BCrypt 검증 → 세션 ID 교체 → Redis 세션(TTL 8 h) → HttpOnly·SameSite=Strict 쿠키 + CSRF 쿠키. */
@org.springframework.context.annotation.Profile("!cli & !migrate")
@RestController
@RequestMapping("/api/v1/ops/session")
public class OpsSessionController {
    private final OpsUserService users;
    private final SecurityContextRepository contextRepository;
    private final AuditService audit;
    private final RateLimiter limiter;
    private final AppProperties props;

    public OpsSessionController(OpsUserService users, SecurityContextRepository contextRepository, AuditService audit, RateLimiter limiter, AppProperties props) {
        this.users = users;
        this.contextRepository = contextRepository;
        this.audit = audit;
        this.limiter = limiter;
        this.props = props;
    }

    /** IP당 분당 로그인 시도 상한. */
    static final int LOGIN_LIMIT_PER_MIN = 10;

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
            audit.record(req, null, "LOGIN_FAILED", body.username(), null, Map.of("reason", result.failure().name().toLowerCase(java.util.Locale.ROOT)));
            if (result.lockedNow())
                audit.record(req, null, "ACCOUNT_LOCKED", body.username(), null, Map.of("minutes", OpsUserService.LOCK_MINUTES, "after_failures", OpsUserService.MAX_FAILED));
            throw new Problem(HttpStatus.UNAUTHORIZED, "BAD_CREDENTIALS", "unauthorized", "invalid credentials");
        }
        var user = result.user().get();
        req.getSession(true);
        req.changeSessionId(); // 세션 고정 방지: 로그인 전 세션이 있었다면 ID 를 교체한다
        Authentication auth = new OpsAuthentication(user, List.of(new SimpleGrantedAuthority("ROLE_OPS")));
        SecurityContext ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(auth);
        SecurityContextHolder.setContext(ctx);
        contextRepository.saveContext(ctx, req, res);
        req.getSession().setAttribute("ops_user_id", user.id());
        audit.record(req, user.id(), "LOGIN", user.username(), null, null);
        return ResponseEntity.ok(Map.of("username", user.username(), "role", user.role()));
    }

    @GetMapping
    public ResponseEntity<Map<String, Object>> me(Authentication auth) {
        if (auth == null || !auth.isAuthenticated()) throw Problem.notFound("no such resource");
        return ResponseEntity.ok(Map.of("username", auth.getName(), "role", "OPS"));
    }

    @DeleteMapping
    public ResponseEntity<Void> logout(HttpServletRequest req, Authentication auth) {
        Integer uid = auth instanceof OpsAuthentication o ? o.user().id() : null;
        audit.record(req, uid, "LOGOUT", auth == null ? null : auth.getName(), null, null);
        var s = req.getSession(false);
        if (s != null) s.invalidate();
        SecurityContextHolder.clearContext();
        return ResponseEntity.noContent().build();
    }
}
