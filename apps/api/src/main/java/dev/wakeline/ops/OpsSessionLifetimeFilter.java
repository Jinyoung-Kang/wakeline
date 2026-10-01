package dev.wakeline.ops;

import dev.wakeline.platform.web.ApiPaths;
import dev.wakeline.platform.web.Problem;
import dev.wakeline.platform.web.ProblemJson;
import dev.wakeline.platform.web.RequestIdFilter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher;
import org.springframework.security.web.util.matcher.RequestMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.Optional;
import java.util.function.IntFunction;

/**
 * 운영 세션의 절대 수명(R-54, ADR-017 §3). Spring Session 의 timeout 은 유휴 기준이라 요청마다 연장된다 — /ops 탭의 15 s 폴링이 세션을
 * 무기한 살려 두었다. 여기서는 로그인 시각({@link #AUTH_AT}, 없으면 세션 생성 시각)부터 {@code maxAge} 가 지난 세션을 요청이 와도 끝낸다.
 * <p>
 * 보안 필터 체인에서 SecurityContextHolderFilter 앞에 둔다: 세션을 먼저 무효화하므로(Redis 에서 삭제) 그 요청은 보안 컨텍스트 없이
 * 익명으로 처리되고 /api/v1/ops/** 는 404(존재 비공개)가 된다. 로그인(POST /api/v1/ops/session)도 같다 — 만료된 세션은 지우고 새로 로그인한다.
 * 컴포넌트로 등록하지 않는다(서블릿 필터로 한 번 더 걸리지 않게) — {@link SecurityConfig} 가 만든다.
 * <p>
 * 자격 확인(R-95 후속): 세션은 로그인 때 확인한 비밀번호 해시의 표식({@link #CREDENTIAL})에 묶인다. 운영 요청마다 사용자의 지금 표식과 비교해
 * 다르거나(비밀번호 교체) 사용자가 없거나 표식이 없는 세션은 끝낸다. 교체 때의 세션 목록 삭제(OpsSessionRegistry.revokeAll)는 로그인과
 * 경합하면 방금 만든 세션을 놓칠 수 있다 — 이 비교는 순서와 무관하다. DB 를 읽지 못하면 세션은 두고 503(모름 — 끝내지도, 통과시키지도 않는다) +
 * Retry-After(QA-101 — 계약 §2 의 기본 10 s, 해결 목록 GET 은 §G14 가 약속한 30 s: 해결 기록 읽기의 다시 읽는 간격). Redis 만 읽는 로그 조회도 이 확인을
 * 먼저 지나므로 DB 장애 중에는 503 이다 — 실패-닫힘(ADR-017 §6 S3, ADR-024).
 * 로그아웃(DELETE /api/v1/ops/session)은 자격 비교를 하지 않는다(리뷰 cto-2026-10 S3): 권한을 줄이는 요청이라 확인할 것이 없고, DB 장애 중에도 세션을
 * 끝낼 수 있어야 한다(예전에는 503 으로 막혀 세션이 최대 8 h 남았다). 절대 수명 검사는 로그아웃에도 그대로다.
 * <p>
 * 세션 저장소(Redis)를 읽지 못하면(QA-102) 운영 요청은 503 + Retry-After(계약 §2 — 로그인과 같다)다: 세션이 있는지 모르므로 통과시키지도(익명 404)
 * 끝내지도 않는다. 예전에는 그 예외가 필터 밖으로 나가 500 + ERROR 스택이었다. 공개 경로는 세션을 읽지 않는다(OpsSessionIdResolver).
 */
public class OpsSessionLifetimeFilter extends OncePerRequestFilter {
    private static final Logger log = LoggerFactory.getLogger(OpsSessionLifetimeFilter.class);
    /** 해결 목록 GET — 503 의 Retry-After 는 해결 기록을 다시 읽는 간격(계약 v5 §G14 · ResolutionService.RETRY_S). */
    static final RequestMatcher RESOLUTIONS_LIST = PathPatternRequestMatcher.withDefaults().matcher(HttpMethod.GET, "/api/v1/ops/resolutions");
    /** 로그인 시각(epoch ms, Long) 세션 속성. 세션 역직렬화 허용 목록(java.lang.Long)에 이미 있다. */
    public static final String AUTH_AT = "ops_auth_at";
    /** 로그인한 운영자 id(Integer). */
    public static final String USER_ID = "ops_user_id";
    /** 로그인 때 확인한 자격 표식(String, OpsUserService.credentialTag). */
    public static final String CREDENTIAL = "ops_credential";

    private final long maxAgeMs;
    private final Clock clock;
    /** 운영자 id → 지금 자격 표식(없으면 empty). null 이면 자격 확인을 하지 않는다(수명만 보는 단위 시험). */
    private final IntFunction<Optional<String>> currentCredential;

    public OpsSessionLifetimeFilter(Duration maxAge, Clock clock, IntFunction<Optional<String>> currentCredential) {
        if (maxAge.isNegative() || maxAge.isZero()) throw new IllegalArgumentException("ops session max age must be positive: " + maxAge);
        this.maxAgeMs = maxAge.toMillis();
        this.clock = clock;
        this.currentCredential = currentCredential;
    }

    OpsSessionLifetimeFilter(Duration maxAge, Clock clock) {
        this(maxAge, clock, null);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !ApiPaths.OPS.matches(request); // 인가와 같은 규칙(디코딩한 경로) — 원문 앞부분이면 %6Fps 가 빠진다
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        HttpSession s;
        try {
            s = req.getSession(false);
        } catch (DataAccessException e) { // 세션 저장소를 읽지 못함(연결 없음 · 명령 시간 초과 · LOADING) — 저장소 장애라 스택 없이 한 줄
            log.warn("session store unavailable request_id={} path={} → 503: {}: {}", RequestIdFilter.current(req), req.getRequestURI(),
                    e.getClass().getSimpleName(), e.getMostSpecificCause().getMessage());
            unavailable(req, res, "ops session store temporarily unavailable; retry later", Problem.UNAVAILABLE_RETRY_AFTER_S);
            return;
        }
        if (s != null && expired(s, clock.millis())) s.invalidate();
        else if (s != null && currentCredential != null && !ApiPaths.OPS_LOGOUT.matches(req) && s.getAttribute(USER_ID) instanceof Integer uid) {
            Optional<String> now;
            try {
                now = currentCredential.apply(uid);
            } catch (RuntimeException e) {
                unavailable(req, res, "ops temporarily unavailable",
                        RESOLUTIONS_LIST.matches(req) ? (int) ResolutionService.RETRY_S : Problem.UNAVAILABLE_RETRY_AFTER_S);
                return;
            }
            if (now.isEmpty() || !now.get().equals(s.getAttribute(CREDENTIAL))) s.invalidate();
        }
        chain.doFilter(req, res);
    }

    /** 503 + Retry-After(초 — 계약 §2 의 기본은 {@value Problem#UNAVAILABLE_RETRY_AFTER_S} s). */
    private static void unavailable(HttpServletRequest req, HttpServletResponse res, String detail, int retryAfterS) throws IOException {
        res.setHeader(HttpHeaders.RETRY_AFTER, String.valueOf(retryAfterS));
        ProblemJson.write(res, req, 503, "UNAVAILABLE", "service unavailable", detail);
    }

    /** 로그인(또는 속성이 없으면 세션 생성)으로부터 maxAge 이상 지났는가. */
    boolean expired(HttpSession s, long nowMs) {
        Object at = s.getAttribute(AUTH_AT);
        long since = at instanceof Long l ? l : s.getCreationTime();
        return nowMs - since >= maxAgeMs;
    }
}
