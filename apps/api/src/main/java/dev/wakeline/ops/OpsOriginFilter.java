package dev.wakeline.ops;

import dev.wakeline.platform.web.ApiPaths;
import dev.wakeline.platform.web.ProblemJson;
import dev.wakeline.platform.web.RequestIdFilter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * 운영 변경 요청의 출처 검사(리뷰 cto-2026-10 S1). 쿠키는 포트를 가리지 않고 SameSite 는 사이트(스킴 + 호스트) 단위라, 다른 localhost 포트의 페이지가 보낸
 * 요청에도 운영 세션 쿠키가 실린다. 그래서 /api/v1/ops/** 의 GET 이 아닌 요청은 브라우저가 붙이는(페이지 스크립트가 바꿀 수 없는) 출처 헤더를 본다:
 * <ul>
 *   <li>Origin 이 있는데 허용 목록(wakeline.allowed-origins — WS 핸드셰이크와 같은 목록)의 정확한 origin 이 아니면 403. 목록의 Spring origin 패턴
 *       ("http://localhost:[*]" · "**" 등 '*' 가 든 항목)은 WS 에만 쓰고 여기서는 뺀다 — 패턴 하나가 이 검사가 막으려는 다른 포트 · 다른 사이트를
 *       모두 열기 때문이다(최종 리뷰).</li>
 *   <li>Sec-Fetch-Site 가 있는데 same-origin 이 아니면 403(같은 호스트의 다른 포트는 same-site 다).</li>
 *   <li>둘 다 없으면 통과 — 브라우저가 아닌 클라이언트(curl · 시험)라 피해자의 쿠키가 실리지 않는다. CSRF 토큰 검사는 그대로 뒤따른다.</li>
 * </ul>
 * 로그인(POST /api/v1/ops/session)도 포함한다 — 다른 출처의 페이지가 운영자를 남의 계정으로 로그인시키지 못하게. CsrfFilter 앞에 둔다({@link SecurityConfig}).
 */
public class OpsOriginFilter extends OncePerRequestFilter {
    private static final Logger log = LoggerFactory.getLogger(OpsOriginFilter.class);
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS", "TRACE");
    private final CorsConfiguration allowed = new CorsConfiguration();

    /** @param originPatterns 정리한 허용 목록({@link dev.wakeline.platform.config.AppProperties#originPatterns()}) — 정확한 origin 만 쓴다 */
    public OpsOriginFilter(List<String> originPatterns) {
        List<String> exact = new ArrayList<>();
        for (String o : originPatterns) {
            if (o.contains("*")) log.warn("ops origin check: pattern '{}' ignored — ops changes accept exact origins only (the WS handshake still uses it)", o);
            else exact.add(o);
        }
        allowed.setAllowedOrigins(exact); // 빈 목록이면 Origin 이 있는 요청은 모두 403(닫힌 쪽)
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return SAFE_METHODS.contains(request.getMethod()) || !ApiPaths.OPS.matches(request); // 인가와 같은 규칙(디코딩한 경로)
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String origin = req.getHeader("Origin");
        String site = req.getHeader("Sec-Fetch-Site");
        if ((origin != null && allowed.checkOrigin(origin) == null) || (site != null && !"same-origin".equals(site))) {
            log.debug("ops {} refused: origin {} sec-fetch-site {} request_id={}", req.getMethod(), origin, site, RequestIdFilter.current(req));
            ProblemJson.write(res, req, 403, "ORIGIN_NOT_ALLOWED", "forbidden", "ops changes are accepted only from the allowed origins");
            return;
        }
        chain.doFilter(req, res);
    }
}
