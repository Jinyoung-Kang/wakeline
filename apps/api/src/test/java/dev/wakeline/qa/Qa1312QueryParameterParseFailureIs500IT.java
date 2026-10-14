package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import dev.wakeline.logs.LogSink;
import org.assertj.core.api.SoftAssertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.stream.MapRecord;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * QA-1312(QA 2026-10-aws · api-live — 공개 입력 견고성): Tomcat 이 질의 문자열을 해석하다 실패하면 — 잘못된 퍼센트 인코딩({@code %zz} · 끝의 {@code %} ·
 * {@code %2} · UTF-8 이 아닌 {@code %FF} · {@code %C3}) 또는 파라미터 1,000개 초과(Connector 의 maxParameterCount 기본값 — {@code x&x&…} 약 2 KB,
 * edge 의 URI 8 KB · CloudFront 8,192 B 안) — 파라미터를 읽는 공개 GET 18곳 모두가 익명 요청에 500 INTERNAL 로 답하고, {@code ProblemAdvice} 가 Tomcat 의
 * {@code InvalidParameterException}("Character decoding failed. Parameter [x] with value [%zz] has been ignored …" ·
 * "More than the maximum number of request parameters …")을 '결함일 수 있는 오류'로 보고 ERROR + 스택을 남긴다. 그 ERROR 는 로그 싱크로 서버 로그 스트림
 * {@code wakeline:logs} 에 실리고(라이브 스택 A: {@code /api/v1/ops/logs?level=ERROR} 에 "unhandled error … path=/api/v1/aircraft"), 예외 메시지에
 * 클라이언트가 보낸 파라미터 이름 · 값이 그대로 들어간다. 쓰지 않는 파라미터 하나({@code &x=%FF})로도 같다. 파라미터를 읽지 않는 경로(/status 등)는 200.
 * QA-1101(헤더 값의 C1 제어 문자 → 500 + ERROR)과 같은 영향(익명 입력이 서버 오류 스트림을 채움)이고 원인은 다르다(질의 해석 실패를 4xx 로 바꾸지 않음).
 * <p>기대: 400 problem+json(BAD_REQUEST — 방화벽 · 경로 디코딩 실패와 같은 부류). 500 · ERROR · 서버 로그 스트림 항목은 없다.
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1312QueryParameterParseFailureIs500IT'}
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
@ExtendWith(OutputCaptureExtension.class)
class Qa1312QueryParameterParseFailureIs500IT extends IntegrationTest {
    static final JsonMapper JSON = JsonMapper.builder().build();
    static final String MANY = String.join("&", Collections.nCopies(1000, "x"));
    static final Map<String, String> ACCEPT = Map.of("Accept", "application/geo+json, application/json;q=0.9, application/problem+json;q=0.8");
    static final String BBOX = "126,37,127,38";

    @BeforeEach
    void clearCounters() {
        ItStack.deleteKeys("rl:*");
    }

    @Test
    void aQueryStringTomcatCannotParseIsAClientErrorNot500(CapturedOutput output) throws Exception {
        String startId = Qa1101ControlCharHeaderValueIs500IT.lastServerLogId();
        String at = java.time.Instant.now().minusSeconds(120).truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString();
        Map<String, Integer> statuses = new LinkedHashMap<>();
        Map<String, String> bodies = new LinkedHashMap<>();
        for (String target : List.of(
                // 잘못된 퍼센트 인코딩
                "/api/v1/aircraft?bbox=%zz",
                "/api/v1/aircraft?bbox=" + BBOX + "&x=%FF",
                "/api/v1/aircraft?bbox=" + BBOX + "%",
                "/api/v1/sigmets?hazard=%zz",
                "/api/v1/alerts?kind=%C3",
                "/api/v1/ships/search?q=%2",
                "/api/v1/stats/traffic?day=%",
                "/api/v1/watch?airports=%zz",
                // 파라미터 1,001개
                "/api/v1/aircraft?bbox=" + BBOX + "&" + MANY,
                "/api/v1/replay?at=" + at + "&bbox=" + BBOX + "&" + MANY,
                "/api/v1/alerts/history?limit=5&" + MANY)) {
            QaRawHttp.Res r = QaRawHttp.get(port, target, ACCEPT);
            String label = target.length() > 80 ? target.substring(0, 60) + "…(" + target.length() + " B)" : target;
            statuses.put(label, r.status());
            bodies.put(label, r.body().length() > 160 ? r.body().substring(0, 160) : r.body());
        }
        // 대조군: 파라미터를 읽지 않는 경로는 같은 입력에도 200 · 합쳐 1,000개면 200 · 올바른 인코딩(%25)은 200
        QaRawHttp.Res status = QaRawHttp.get(port, "/api/v1/status?x=%zz&y&" + MANY, ACCEPT);
        QaRawHttp.Res thousand = QaRawHttp.get(port, "/api/v1/aircraft?bbox=" + BBOX + "&" + String.join("&", Collections.nCopies(999, "x")), ACCEPT);
        QaRawHttp.Res encoded = QaRawHttp.get(port, "/api/v1/aircraft?bbox=" + BBOX + "&x=%25zz", ACCEPT);
        List<JsonNode> errors = awaitServerErrorsAfter(startId, 3_000);

        SoftAssertions soft = new SoftAssertions();
        soft.assertThat(status.status()).as("control: /status reads no parameter").isEqualTo(200);
        soft.assertThat(thousand.status()).as("control: /aircraft with 1,000 parameters in total").isEqualTo(200);
        soft.assertThat(encoded.status()).as("control: a correctly encoded '%%' (%%25)").isEqualTo(200);
        statuses.forEach((t, st) -> soft.assertThat(st).as("GET %s — body %s (all: %s)", t, bodies.get(t), statuses).isLessThan(500));
        soft.assertThat(output.getOut()).as("ERROR log for an anonymous query string").doesNotContain("InvalidParameterException");
        soft.assertThat(errors).as("ERROR entries in the server log stream %s written by anonymous requests", LogSink.STREAM).isEmpty();
        soft.assertAll();
    }

    /** startId 뒤에 실린 api 의 ERROR 항목 중 이 결함의 것(ProblemAdvice 'unhandled error' + InvalidParameterException). 싱크는 1 s 마다 보낸다. */
    static List<JsonNode> awaitServerErrorsAfter(String startId, long waitMs) throws InterruptedException {
        long end = System.currentTimeMillis() + waitMs;
        List<JsonNode> out;
        do {
            Thread.sleep(500);
            out = new ArrayList<>();
            for (MapRecord<String, Object, Object> r : ItStack.admin().opsForStream().range(LogSink.STREAM, Range.of(Range.Bound.exclusive(startId), Range.Bound.unbounded()))) {
                JsonNode e = JSON.readTree(String.valueOf(r.getValue().get("e")));
                if ("ERROR".equals(e.path("level").asString()) && e.path("message").asString().startsWith("unhandled error")
                        && e.toString().contains("InvalidParameterException")) out.add(e);
            }
        } while (System.currentTimeMillis() < end);
        return out;
    }
}
