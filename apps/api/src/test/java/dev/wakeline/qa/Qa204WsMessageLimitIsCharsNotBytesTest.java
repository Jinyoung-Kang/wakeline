package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-204(QA 2026-10 기능 · WS): 클라이언트 메시지 상한은 계약상 4 KB(schemas/ws/client.v1.json '≤ 4 KB' · WakelineWsHandler 설명 '클라이언트 메시지 ≤ 4 KB' ·
 * 상수 MAX_MESSAGE_BYTES = 4096)인데, setTextMessageSizeLimit(4096) 은 Tomcat 에서 디코딩한 글자(UTF-16 단위) 수 상한이라 3바이트 글자로 채운 메시지는
 * 4,096 글자 = 12 KB 남짓까지 받아들인다. 4,097 바이트의 ASCII 는 1009 로 닫는다(바이트 = 글자).
 * 실제 앱(Tomcat)에 실제 WS 로 붙는다 — 격리 스택 A 에서 4,096 글자 · 12,240 바이트가 pong 을 받았다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa204WsMessageLimitIsCharsNotBytesTest extends IntegrationTest {

    @Test
    void aMessageOverFourKilobytesIsRejectedEvenWhenItHasFewerThan4096Characters() throws Exception {
        try (QaWsClient c = QaWsClient.connect(port, "http://localhost:8700")) {
            c.send("{\"type\":\"hello\",\"proto\":1}");
            assertThat(c.await("welcome", 5000)).isTrue();
            String msg = "{\"type\":\"ping\",\"pad\":\"" + "가".repeat(3000) + "\"}"; // 3,024 글자 · 9,024 바이트
            assertThat(msg.getBytes(StandardCharsets.UTF_8).length).isGreaterThan(4096);
            c.send(msg);
            Integer code = c.closeCode(3000);
            assertThat(code).as("a %d-byte message must be refused like a 4,097-byte ASCII one (1009); pong received: %s",
                    msg.getBytes(StandardCharsets.UTF_8).length, c.messages.stream().anyMatch(m -> m.startsWith("{\"type\":\"pong\""))).isEqualTo(1009);
        }
    }
}
