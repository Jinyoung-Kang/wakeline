package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-203(QA 2026-10 기능 · WS): subscribe 의 bbox 원소가 309자리 이상의 정수(JSON 정수 — double 로 바꿀 수 없다)면 BAD_BBOX 오류(연결 유지)가 아니라
 * BAD_MESSAGE 와 1002 로 연결이 닫히고 WARN 이 남는다. 알려진 한계(ADR-017 §6.2 S4 · VERIFICATION #101 '309자리 이상 정수의 WS zoom')는 zoom 만 적었다 —
 * bbox 는 새 경로다(WakelineWsHandler.parseBbox 의 n.asDouble() 이 Jackson 3 에서 JsonNodeException). 1e400(실수 표기)은 Infinity 가 되어 BAD_BBOX 로 맞게 답한다.
 * 실제 앱(Tomcat · 임의 포트)에 실제 WS 로 붙는다 — 격리 스택 A 에서도 같은 요청이 1002 BAD_MESSAGE 였다(tools/qa/ws_probe.py bbox_bigint_400).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa203WsBboxHugeIntegerTest extends IntegrationTest {
    static final String BIG = "1" + "0".repeat(399);

    @Test
    void aBboxMemberBeyondDoubleIsABadBboxErrorAndTheConnectionStaysOpen() throws Exception {
        try (QaWsClient c = QaWsClient.connect(port, "http://localhost:8700")) {
            c.send("{\"type\":\"hello\",\"proto\":1}");
            assertThat(c.await("welcome", 5000)).isTrue();
            c.send("{\"type\":\"subscribe\",\"bbox\":[124,33," + BIG + ",39],\"zoom\":7}");
            assertThat(c.await("error", 5000)).isTrue();
            String err = c.messages.stream().filter(m -> m.startsWith("{\"type\":\"error\"")).findFirst().orElseThrow();
            assertThat(err).as("error for a bbox member beyond double").contains("\"code\":\"BAD_BBOX\"");
            assertThat(c.closeCode(1000)).as("connection must stay open after BAD_BBOX").isNull();
        }
    }
}
