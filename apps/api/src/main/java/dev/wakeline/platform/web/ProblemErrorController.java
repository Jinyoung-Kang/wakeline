package dev.wakeline.platform.web;

import dev.wakeline.platform.config.AppProperties;
import io.swagger.v3.oas.annotations.Hidden;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.webmvc.error.ErrorController;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * 오류 디스패치(/error)의 본문도 RFC 9457(QA-1313) — Spring Boot 기본 {@code BasicErrorController} 를 대신한다(ErrorController 빈이 있으면 Boot 는
 * 기본 것을 만들지 않는다). Tomcat 이 앱에 넘기기 전에 거절하고 오류 페이지로 보낸 요청 — 예: {@code Cookie} 의 쿠키가 Connector 의 maxCookieCount(200)를
 * 넘으면 CoyoteAdapter 가 {@code sendError(400)} 하고 앱의 필터 · 컨트롤러를 건너뛴 채 /error 로 보낸다 — 은 Boot 기본 오류 JSON
 * ({@code timestamp} · {@code error} · {@code path} — code · request_id · X-Request-Id 없음, Content-Type 은 요청의 Accept 를 따라 geo+json 까지)이었다.
 * 이제 컨테이너 수준 오류의 다른 길({@link ProblemErrorReportValve})과 같은 본문(code = 상태 이름, title · detail = 사유 문구)을 쓴다.
 * <ul>
 *   <li>요청 id: 원래 요청이 {@link RequestIdFilter} 를 거쳤으면 그 값, 아니면(필터를 건너뛴 요청 — 오류 디스패치에서는 그 필터가 돌지 않는다) 여기서 정해
 *       X-Request-Id 로도 돌려준다.</li>
 *   <li>instance: 원래 요청 경로(오류 디스패치의 {@code jakarta.servlet.error.request_uri}).</li>
 *   <li>상태가 없는 요청(누군가 /error 를 직접 부름)은 404 — 공개 자원이 아니다.</li>
 * </ul>
 * 로그는 남기지 않는다 — 오류를 낸 쪽(Tomcat · 필터에서 올라간 예외는 Tomcat 이)이 이미 남긴다. 공개 API 문서에는 싣지 않는다({@link Hidden}).
 */
@Hidden
@org.springframework.context.annotation.Profile("!cli & !migrate")
@Controller
public class ProblemErrorController implements ErrorController {
    private final String trustedProxy;

    public ProblemErrorController(AppProperties props) {
        this.trustedProxy = props.trustedProxy();
    }

    @RequestMapping("${spring.web.error.path:${error.path:/error}}")
    public void error(HttpServletRequest req, HttpServletResponse res) throws IOException {
        int status = req.getAttribute(RequestDispatcher.ERROR_STATUS_CODE) instanceof Integer s && s >= 400 ? s : HttpServletResponse.SC_NOT_FOUND;
        String rid = req.getAttribute(RequestIdFilter.ATTR) instanceof String s ? s : RequestIdFilter.resolve(req, trustedProxy);
        if (res.getHeader(RequestIdFilter.HEADER) == null) res.setHeader(RequestIdFilter.HEADER, rid);
        String instance = req.getAttribute(RequestDispatcher.ERROR_REQUEST_URI) instanceof String u ? u : req.getRequestURI();
        String[] codeTitle = ProblemJson.codeAndTitle(status);
        res.setStatus(status);
        res.setContentType(ProblemJson.CONTENT_TYPE);
        res.getOutputStream().write(ProblemJson.body(status, codeTitle[0], codeTitle[1], codeTitle[1], instance, rid).getBytes(StandardCharsets.UTF_8));
    }
}
