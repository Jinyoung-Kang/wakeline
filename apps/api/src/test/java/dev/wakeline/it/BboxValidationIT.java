package dev.wakeline.it;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

/**
 * R-16: REST bbox 의 NaN·Infinity·지수 표기는 400 BAD_BBOX(RFC 9457) — WS 와 같은 규칙. 이전에는 NaN 이 범위·면적 검사를 통과해
 * /replay 가 면적 상한(2500 sq°)을 넘는 전세계 조회를 했고, 다른 목록은 400 대신 '0건'(틀린 빈 결과)을 돌려줬다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class BboxValidationIT extends IntegrationTest {

    @Test
    void nonFiniteBboxIsRejectedOnEveryRestEndpoint() {
        String at = Instant.now().minusSeconds(600).truncatedTo(ChronoUnit.SECONDS).toString();
        for (String bbox : new String[]{"-180,NaN,180,NaN", "NaN,NaN,NaN,NaN", "124,33,132,Infinity", "1e2,33,1.2e2,39"}) {
            String q = bbox.replace("+", "%2B");
            for (String path : new String[]{"/api/v1/replay?at=" + at + "&bbox=" + q, "/api/v1/aircraft?bbox=" + q, "/api/v1/ships?bbox=" + q,
                    "/api/v1/airports?bbox=" + q, "/api/v1/sigmets?bbox=" + q}) {
                assertProblem(get(path), 400, "BAD_BBOX", path.substring(0, path.indexOf('?')));
            }
        }
    }
}
