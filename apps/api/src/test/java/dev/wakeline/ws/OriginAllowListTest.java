package dev.wakeline.ws;

import org.junit.jupiter.api.Test;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** SEC-7: Origin 은 명시 목록만. same-origin(DNS 리바인딩: Origin = Host = 공격자 도메인)도 목록 밖이면 403. */
class OriginAllowListTest {
    final OriginAllowList list = new OriginAllowList(List.of("http://localhost:8700", "http://127.0.0.1:8700/"));

    boolean handshake(String host, String origin, MockHttpServletResponse res) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/ws/v1");
        req.addHeader("Host", host);
        req.setServerName(host.split(":")[0]);
        req.setServerPort(Integer.parseInt(host.split(":")[1]));
        if (origin != null) req.addHeader("Origin", origin);
        return list.beforeHandshake(new ServletServerHttpRequest(req), new ServletServerHttpResponse(res), null, new HashMap<>());
    }

    @Test void allowsListedOrigins() throws Exception {
        assertThat(handshake("localhost:8700", "http://localhost:8700", new MockHttpServletResponse())).isTrue();
        assertThat(handshake("127.0.0.1:8700", "http://127.0.0.1:8700", new MockHttpServletResponse())).isTrue(); // 끝 '/' 정규화
    }

    @Test void rejectsDnsRebindingSameOrigin() throws Exception {
        MockHttpServletResponse res = new MockHttpServletResponse();
        assertThat(handshake("rebind.attacker.example:8700", "http://rebind.attacker.example:8700", res)).isFalse();
        assertThat(res.getStatus()).isEqualTo(403);
    }

    @Test void rejectsOtherPortAndNullOrigin() throws Exception {
        assertThat(handshake("localhost:8700", "http://localhost:3000", new MockHttpServletResponse())).isFalse();
        assertThat(handshake("localhost:8700", "null", new MockHttpServletResponse())).isFalse();
    }

    @Test void allowsMissingOrigin_nonBrowserClients() throws Exception {
        assertThat(handshake("localhost:8700", null, new MockHttpServletResponse())).isTrue();
    }

    @Test void normalize_dropsWildcardAndBlanks_fallsBackToDefaultWhenEmpty() {
        assertThat(OriginAllowList.normalize(Arrays.asList(" http://a:1/ ", "*", "", null, "http://a:1"))).containsExactly("http://a:1");
        assertThat(OriginAllowList.normalize(List.of("*"))).isEqualTo(OriginAllowList.DEFAULT);
        assertThat(OriginAllowList.normalize(null)).isEqualTo(OriginAllowList.DEFAULT);
    }

    @Test void patternEntries_work() {
        OriginAllowList p = new OriginAllowList(List.of("http://localhost:[*]"));
        assertThat(p.allows("http://localhost:8701")).isTrue();
        assertThat(p.allows("http://evil.example:8701")).isFalse();
    }
}
