package dev.wakeline.platform.web;

import dev.wakeline.DbTestSupport;
import jakarta.servlet.RequestDispatcher;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1313: 오류 디스패치(/error)의 본문은 RFC 9457 — Boot 기본 오류 JSON(timestamp · error · path)이 아니다. 실제 길(쿠키 201개 → Tomcat 400 → /error)은
 * Qa1313TooManyCookiesErrorBodyIsNotProblemIT.
 */
class ProblemErrorControllerTest {
    static final JsonMapper JSON = JsonMapper.builder().build();
    final ProblemErrorController controller = new ProblemErrorController(DbTestSupport.PROPS);

    @Test
    void aContainerErrorIsAProblemWithTheOriginalPathAndANewRequestId() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/error");
        req.setAttribute(RequestDispatcher.ERROR_STATUS_CODE, 400);
        req.setAttribute(RequestDispatcher.ERROR_REQUEST_URI, "/api/v1/aircraft");
        MockHttpServletResponse res = new MockHttpServletResponse();
        controller.error(req, res);
        assertThat(res.getStatus()).isEqualTo(400);
        assertThat(res.getContentType()).startsWith("application/problem+json");
        JsonNode p = JSON.readTree(res.getContentAsString());
        assertThat(p.path("code").asString()).isEqualTo("BAD_REQUEST");
        assertThat(p.path("instance").asString()).isEqualTo("/api/v1/aircraft");
        assertThat(p.has("timestamp")).isFalse();
        // 필터를 건너뛴 요청 — 여기서 정한 id 를 본문과 헤더에 같게
        assertThat(res.getHeader("X-Request-Id")).isNotBlank().isEqualTo(p.path("request_id").asString());
    }

    @Test
    void theFilterRequestIdIsKept_andADirectRequestIs404() throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/error");
        req.setAttribute(RequestDispatcher.ERROR_STATUS_CODE, 500);
        req.setAttribute(RequestIdFilter.ATTR, "rid-from-filter-1");
        MockHttpServletResponse res = new MockHttpServletResponse();
        res.setHeader("X-Request-Id", "rid-from-filter-1");
        controller.error(req, res);
        assertThat(res.getStatus()).isEqualTo(500);
        assertThat(JSON.readTree(res.getContentAsString()).path("request_id").asString()).isEqualTo("rid-from-filter-1");
        assertThat(res.getHeaders("X-Request-Id")).containsExactly("rid-from-filter-1");

        MockHttpServletResponse direct = new MockHttpServletResponse();
        controller.error(new MockHttpServletRequest("GET", "/error"), direct);
        assertThat(direct.getStatus()).isEqualTo(404);
        assertThat(JSON.readTree(direct.getContentAsString()).path("instance").asString()).isEqualTo("/error");
    }
}
