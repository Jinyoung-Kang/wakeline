package dev.skywx.ops;

import dev.skywx.config.AppProperties;
import dev.skywx.config.ClientIp;
import dev.skywx.config.Problem;
import dev.skywx.config.RateLimiter;
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
@org.springframework.context.annotation.Profile("!cli")
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

    public record Login(@NotBlank @Size(max = 64) String username, @NotBlank @Size(min = 8, max = 256) String password) {}

    @PostMapping
    public ResponseEntity<Map<String, Object>> login(@Valid @RequestBody Login body, HttpServletRequest req, HttpServletResponse res) {
        String ip = ClientIp.resolve(req, props.trustedProxy());
        if (limiter.hit("login", ip, 60)[0] > 10) throw new Problem(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", "rate limited", "too many login attempts");
        var user = users.authenticate(body.username(), body.password())
                .orElseThrow(() -> new Problem(HttpStatus.UNAUTHORIZED, "BAD_CREDENTIALS", "unauthorized", "invalid credentials"));
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
