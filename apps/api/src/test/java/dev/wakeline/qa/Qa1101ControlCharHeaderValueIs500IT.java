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

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * QA-1101(QA 2026-10-aws · api 보안 · 견고성): 공개 경로가 컨트롤러에서 직접 읽는 요청 헤더(If-None-Match · User-Agent)의 값에 C1 제어 문자
 * (바이트 0x80–0x9F — Tomcat 은 obs-text 로 받아 ISO-8859-1 로 읽는다)가 있으면 익명 요청이 500 INTERNAL + ERROR 스택이 된다.
 * Spring Security 의 StrictHttpFirewall 은 헤더 값을 읽는 순간(getHeader) 검사해 RequestRejectedException 을 던지는데, 보안 체인 안에서 던지면
 * RequestRejectedHandler 가 400 으로 답하지만(대조: 같은 바이트를 Accept 에 넣으면 400 "request rejected") 컨트롤러 안에서 던지면 ProblemAdvice 의
 * @ExceptionHandler(Exception) 이 받아 500 + log.error(스택)로 남긴다. 그 ERROR 는 로그 싱크로 서버 로그 스트림 wakeline:logs(MAXLEN ~ 3000)에
 * 실린다 — 계약 v5 §G2 가 막으려던 '익명 입력이 서버 오류 스트림을 채움'의 다른 길이다. 지문(fp)에 경로가 들어가 경로마다 다른 묶음이 된다(억제는 같은 fp
 * 10 s 에 1건).
 * <p>기대: 4xx(400 — 방화벽의 다른 거절과 같은 problem+json) 또는 그 헤더를 무시한 정상 답. 500 · ERROR · 서버 로그 스트림 항목은 없다.
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1101ControlCharHeaderValueIs500IT'}
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
@ExtendWith(OutputCaptureExtension.class)
class Qa1101ControlCharHeaderValueIs500IT extends IntegrationTest {
    static final JsonMapper JSON = JsonMapper.builder().build();
    /** 헤더 값의 바이트 0x85(NEL) — QaRawHttp 가 ISO-8859-1 로 그대로 보낸다. */
    static final String C1 = "\"\u0085\"";
    static final String BBOX = "126,37,127,38";

    @BeforeEach
    void clearCounters() {
        ItStack.deleteKeys("rl:*");
    }

    @Test
    void controlCharactersInHeadersReadByPublicControllersAreNot500(CapturedOutput output) throws Exception {
        String startId = lastServerLogId();
        // If-None-Match 를 컨트롤러가 읽는 공개 경로 9개 + User-Agent 를 읽는 브라우저 오류 수집 1개
        Map<String, QaRawHttp.Res> res = new LinkedHashMap<>();
        for (String path : List.of("/api/v1/aircraft?bbox=" + BBOX, "/api/v1/ships?bbox=" + BBOX, "/api/v1/sigmets", "/api/v1/radar/frames",
                "/api/v1/radar/kr", "/api/v1/traffic/grid", "/api/v1/ships/coverage", "/api/v1/warnings", "/api/v1/airspace"))
            res.put("GET " + path + " If-None-Match", QaRawHttp.get(port, path, Map.of("If-None-Match", C1)));
        String report = "{\"message\":\"qa-1101 probe\",\"path\":\"/\",\"ts\":\"2026-10-14T00:00:00Z\"}";
        res.put("POST /api/v1/client-errors User-Agent", QaRawHttp.send(port, "POST", "/api/v1/client-errors",
                Map.of("Content-Type", "application/json", "User-Agent", "Mozilla/5.0 \u0085"), report.getBytes(StandardCharsets.UTF_8)));
        // 대조군: 보안 체인 안에서 읽히는 헤더(Accept)의 같은 바이트는 이미 400(방화벽 거절 — RFC 9457)
        QaRawHttp.Res accept = QaRawHttp.get(port, "/api/v1/status", Map.of("Accept", "application/json\u0085"));

        Map<String, Integer> statuses = new LinkedHashMap<>();
        res.forEach((k, v) -> statuses.put(k, v.status()));
        List<JsonNode> errors = awaitServerErrorsAfter(startId, 3_000);
        Set<String> fps = new LinkedHashSet<>();
        for (JsonNode e : errors) fps.add(e.path("fp").asString());

        SoftAssertions soft = new SoftAssertions();
        soft.assertThat(accept.status()).as("control: Accept with the same byte").isEqualTo(400);
        res.forEach((k, v) -> soft.assertThat(v.status()).as("%s with a C1 control character (all statuses: %s)", k, statuses).isLessThan(500));
        soft.assertThat(output.getOut()).as("ERROR log for anonymous header input").doesNotContain("RequestRejectedException");
        soft.assertThat(errors).as("ERROR entries in the server log stream %s written by anonymous header input (distinct fingerprints: %d)",
                LogSink.STREAM, fps.size()).isEmpty();
        soft.assertAll();
    }

    /** 서버 로그 스트림의 마지막 id(없으면 0-0). */
    static String lastServerLogId() {
        List<MapRecord<String, Object, Object>> last = ItStack.admin().opsForStream().reverseRange(LogSink.STREAM, Range.unbounded(),
                org.springframework.data.redis.connection.Limit.limit().count(1));
        return last == null || last.isEmpty() ? "0-0" : last.getFirst().getId().getValue();
    }

    /** startId 뒤에 실린 api 의 ERROR 항목 중 이 결함의 것(ProblemAdvice 'unhandled error' + RequestRejectedException). 싱크는 1 s 마다 보낸다. */
    static List<JsonNode> awaitServerErrorsAfter(String startId, long waitMs) throws InterruptedException {
        long end = System.currentTimeMillis() + waitMs;
        List<JsonNode> out;
        do {
            Thread.sleep(500);
            out = new java.util.ArrayList<>();
            for (MapRecord<String, Object, Object> r : ItStack.admin().opsForStream().range(LogSink.STREAM, Range.of(Range.Bound.exclusive(startId), Range.Bound.unbounded()))) {
                JsonNode e = JSON.readTree(String.valueOf(r.getValue().get("e")));
                if ("ERROR".equals(e.path("level").asString()) && e.path("message").asString().startsWith("unhandled error")
                        && e.toString().contains("RequestRejectedException")) out.add(e);
            }
        } while (System.currentTimeMillis() < end);
        return out;
    }
}
