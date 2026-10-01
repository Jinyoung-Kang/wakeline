package dev.wakeline.ops;

import dev.wakeline.platform.web.ApiPaths;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.session.web.http.HttpSessionIdResolver;

import java.util.List;

/**
 * 세션 id 는 운영 경로(/api/v1/ops/** — {@link ApiPaths#OPS}, 인가와 같은 매처)에서만 읽는다(QA-102). 세션 쿠키는 Path=/api 라(R-97) 로그인한 운영자의
 * 브라우저는 상황판의 공개 REST 요청에도 그 쿠키를 싣는데, 예전에는 그 요청마다 Spring Session 이 Redis 에서 세션을 찾았다 — Redis 가 멈추면 공개
 * 경로까지 500 + ERROR 스택(필터 단계 예외라 ProblemAdvice 에 닿지 않았다)이었고, 평소에도 공개 요청마다 Redis 읽기와 세션 유휴 시각 연장이 있었다.
 * 공개 경로는 세션을 쓰지 않는다(보안 컨텍스트 · 요청 제한 · CSRF 모두 세션 없이) — 이제 세션 저장소에 닿지 않고 쿠키가 없는 요청과 같게 답한다.
 * 쿠키를 쓰고 지우는 일(로그인 · 로그아웃)은 그대로 쿠키 해석기에 넘긴다.
 */
final class OpsSessionIdResolver implements HttpSessionIdResolver {
    private final HttpSessionIdResolver cookies;

    OpsSessionIdResolver(HttpSessionIdResolver cookies) { this.cookies = cookies; }

    @Override
    public List<String> resolveSessionIds(HttpServletRequest request) {
        return ApiPaths.OPS.matches(request) ? cookies.resolveSessionIds(request) : List.of();
    }

    @Override
    public void setSessionId(HttpServletRequest request, HttpServletResponse response, String sessionId) {
        cookies.setSessionId(request, response, sessionId);
    }

    @Override
    public void expireSession(HttpServletRequest request, HttpServletResponse response) {
        cookies.expireSession(request, response);
    }
}
