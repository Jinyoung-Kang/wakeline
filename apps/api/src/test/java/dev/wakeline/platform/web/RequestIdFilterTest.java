package dev.wakeline.platform.web;

import dev.wakeline.platform.config.AppProperties;
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

    /** 걸린 시간(조사 2026-10-01 오류 F3): 필터가 요청 시작 시각을 남겨, 503 WARN 이 그 요청이 얼마나 걸렸는지 적을 수 있다. 필터를 거치지 않았으면 null. */
    @Test
    void theFilterRecordsWhenTheRequestStartedSoLogsCanSayHowLongItTook() throws Exception {
        MockHttpServletRequest req = from("203.0.113.9", null);
        assertThat(RequestIdFilter.elapsedMs(req)).as("not filtered — unknown, not 0").isNull();
        long[] seen = {-1};
        RequestIdFilter f = new RequestIdFilter(new AppProperties(EDGE, "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
                120, java.util.List.of(), java.util.List.of()));
        f.doFilter(req, new org.springframework.mock.web.MockHttpServletResponse(), (rq, rs) -> {
            try { Thread.sleep(30); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
            seen[0] = RequestIdFilter.elapsedMs((jakarta.servlet.http.HttpServletRequest) rq);
        });
        assertThat(seen[0]).isBetween(30L, 5_000L);
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
