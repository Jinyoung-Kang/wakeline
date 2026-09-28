package dev.wakeline.config;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

/** R-49: 요청 id 는 신뢰 프록시(edge)가 보낸 형식이 맞는 값만 받아들인다. 실제 필터·로그 경로는 SecurityIT. */
class RequestIdFilterTest {
    static final String EDGE = "10.77.0.10";
    static final String EDGE_ID = "3f2b8c1d9e7a4b6c8d0e1f2a3b4c5d6e";

    static MockHttpServletRequest from(String remote, String header) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", "/api/v1/status");
        r.setRemoteAddr(remote);
        if (header != null) r.addHeader(RequestIdFilter.HEADER, header);
        return r;
    }

    @Test
    void edgeIdIsAdoptedOnlyFromTheTrustedProxy() {
        assertThat(RequestIdFilter.resolve(from(EDGE, EDGE_ID), EDGE)).isEqualTo(EDGE_ID);
        assertThat(RequestIdFilter.resolve(from(EDGE, "0b6e1c2a-5d3f-4e8a-9c7b-1a2b3c4d5e6f"), EDGE)).isEqualTo("0b6e1c2a-5d3f-4e8a-9c7b-1a2b3c4d5e6f"); // UUID
        assertThat(RequestIdFilter.resolve(from("203.0.113.9", EDGE_ID), EDGE)).isNotEqualTo(EDGE_ID);
        assertThat(RequestIdFilter.resolve(from(EDGE, EDGE_ID), "")).as("no trusted proxy configured").isNotEqualTo(EDGE_ID);
        assertThat(RequestIdFilter.resolve(from(EDGE, EDGE_ID), null)).isNotEqualTo(EDGE_ID);
        assertThat(RequestIdFilter.resolve(from(EDGE, null), EDGE)).matches("^[0-9a-f]{20,}$");
        assertThat(RequestIdFilter.resolve(from(EDGE, "id with space"), EDGE)).isNotEqualTo("id with space");
    }
}
