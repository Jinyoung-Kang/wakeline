package dev.wakeline.config;

import org.apache.catalina.Lifecycle;
import org.apache.catalina.Valve;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.core.StandardHost;
import org.apache.catalina.valves.ErrorReportValve;
import org.apache.coyote.ActionCode;
import org.springframework.boot.tomcat.ConfigurableTomcatWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.core.Ordered;

import java.io.IOException;
import java.io.Writer;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 컨테이너 수준 오류 본문을 RFC 9457 로(R-84). 앱의 필터·서블릿에 닿기 전에 Tomcat 이 거절한 요청 — 예: 인코딩된 슬래시(%2F),
 * 디코딩·정규화할 수 없는 URI — 은 기본 ErrorReportValve 가 HTML 오류 페이지를 썼다. 이 밸브는 같은 자리에서 problem+json 을 쓴다.
 * 앱이 이미 본문을 쓴 오류(ProblemAdvice · 보안 필터 · /error)는 건드리지 않는다(내용이 이미 있으면 아무것도 하지 않는다).
 * 요청 id 는 앱 필터가 붙였으면 그 값, 아니면 여기서 만든다(X-Request-Id 로도 돌려준다).
 */
public class ProblemErrorReportValve extends ErrorReportValve {
    /** edge 주소 — edge 가 보낸 요청 id 를 여기서도 쓴다(R-49, {@link RequestIdFilter#resolve}). */
    private final String trustedProxy;

    public ProblemErrorReportValve() { this(null); }

    public ProblemErrorReportValve(String trustedProxy) {
        this.trustedProxy = trustedProxy;
        setShowReport(false);
        setShowServerInfo(false);
    }

    @Override
    protected void report(Request request, Response response, Throwable throwable) {
        int status = response.getStatus();
        if (status < 400 || response.getContentWritten() > 0 || !response.setErrorReported()) return;
        AtomicBoolean ioAllowed = new AtomicBoolean(false);
        response.getCoyoteResponse().action(ActionCode.IS_IO_ALLOWED, ioAllowed);
        if (!ioAllowed.get()) return;
        Object attr = request.getAttribute(RequestIdFilter.ATTR);
        String rid = attr != null ? attr.toString() : RequestIdFilter.resolve(request, trustedProxy);
        String[] codeTitle = ProblemJson.codeAndTitle(status);
        try {
            response.setContentType(ProblemJson.CONTENT_TYPE);
            response.setCharacterEncoding("UTF-8");
            if (response.getHeader(RequestIdFilter.HEADER) == null) response.setHeader(RequestIdFilter.HEADER, rid);
            Writer w = response.getReporter();
            if (w != null) {
                w.write(ProblemJson.body(status, codeTitle[0], codeTitle[1], codeTitle[1], request.getRequestURI(), rid));
                response.finishResponse();
            }
        } catch (IOException | IllegalStateException e) {
            // 응답을 더 쓸 수 없다(연결 끊김 등) — 상태 코드만 남는다
        }
    }

    /**
     * 호스트의 오류 보고 밸브를 이것으로 바꾼다. Boot 는 include-stacktrace=never 일 때 기본 ErrorReportValve 를 호스트에 더한다 — 그 밸브가
     * 남아 있으면 안쪽 밸브가 먼저 보고하므로 HTML 이 나간다. 그래서 호스트가 시작되기 직전에 다른 ErrorReportValve 를 모두 빼고 이것 하나만 둔다
     * (errorReportValveClass 도 이 클래스로 — 호스트가 기본 밸브를 다시 넣지 않게). 순서와 무관하게 동작하도록 가장 늦게 돈다.
     */
    public static final class Customizer implements WebServerFactoryCustomizer<ConfigurableTomcatWebServerFactory>, Ordered {
        private final String trustedProxy;

        public Customizer(String trustedProxy) { this.trustedProxy = trustedProxy; }

        @Override
        public void customize(ConfigurableTomcatWebServerFactory factory) {
            factory.addContextCustomizers(context -> {
                if (context.getParent() instanceof StandardHost host) {
                    host.setErrorReportValveClass(ProblemErrorReportValve.class.getName());
                    host.addLifecycleListener(e -> {
                        if (Lifecycle.BEFORE_START_EVENT.equals(e.getType())) install(host, trustedProxy);
                    });
                }
            });
        }

        static void install(StandardHost host, String trustedProxy) {
            for (Valve v : host.getPipeline().getValves())
                if (v instanceof ErrorReportValve && !(v instanceof ProblemErrorReportValve)) host.getPipeline().removeValve(v);
            for (Valve v : host.getPipeline().getValves()) if (v instanceof ProblemErrorReportValve) return;
            host.getPipeline().addValve(new ProblemErrorReportValve(trustedProxy));
        }

        @Override
        public int getOrder() { return Ordered.LOWEST_PRECEDENCE; }
    }
}
