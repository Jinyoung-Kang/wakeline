package dev.wakeline.ws;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * WS 클라이언트 입력의 잘못된 숫자 · 형(리뷰 cto-2026-10 api B2 · §5.4-6): 메시지 종류마다 범위 밖 · 다른 형의 값을 보내도 처리기에서 예외가 나오지 않는다 —
 * 오류 메시지(그 연결만, 닫힘 여부는 코드마다 계약대로)이거나 받아들인다(범위 밖 zoom 은 0–24 로 자른다). 예외가 나오면 Spring 이 ERROR 스택을 남기고
 * 1011 로 닫는다 — 익명 클라이언트가 서버 오류 로그를 만들 수 있었다(Jackson 3 의 asInt() 는 범위 밖이면 던진다: zoom 1e10).
 */
@ExtendWith(OutputCaptureExtension.class)
class WsInputRobustnessTest {
    /** 기대: 받아들임(오류 없음) · 오류(연결 유지) · 치명(오류 뒤 1002 로 닫음). */
    record Row(String name, boolean subscribeFirst, String message, String errorCode, boolean fatal) {
        @Override public String toString() { return name; }
    }

    static Row ok(String name, String message) { return new Row(name, false, message, null, false); }
    static Row okSubscribed(String name, String message) { return new Row(name, true, message, null, false); }
    static Row error(String name, String message, String code) { return new Row(name, false, message, code, false); }
    static Row fatal(String name, String message, String code) { return new Row(name, false, message, code, true); }

    static final String BOX = "[124,33,132,39]";
    /** double 로 나타낼 수 없는 정수(400자리 — double 은 약 1.8e308 까지). */
    static final String HUGE = "1" + "0".repeat(399);

    static Stream<Row> rows() {
        return Stream.of(
                // subscribe — zoom 은 0–24 로 자른다(형이 숫자가 아니면 기본 7)
                ok("zoom 1e10", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":1e10}"),
                ok("zoom -1e10", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":-1e10}"),
                ok("zoom 2^31 (long)", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":2147483648}"),
                ok("zoom big integer", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":123456789012345678901234567890}"),
                ok("zoom 1e400 (overflows double)", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":1e400}"),
                // QA-203: double 로 나타낼 수 없는 정수(309자리 이상)도 끝으로 자른다 — 예전에는 BAD_MESSAGE · 1002(ADR-017 §6.2 S4 의 한계)
                ok("zoom 400-digit integer", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":" + HUGE + "}"),
                ok("zoom -400-digit integer", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":-" + HUGE + "}"),
                ok("zoom 6.9", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":6.9}"),
                ok("zoom string", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":\"7\"}"),
                ok("zoom null", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":null}"),
                ok("detail number", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":7,\"detail\":1e10}"),
                error("bbox member 1e400", "{\"type\":\"subscribe\",\"bbox\":[1e400,33,132,39],\"zoom\":7}", "BAD_BBOX"),
                error("bbox member big integer", "{\"type\":\"subscribe\",\"bbox\":[123456789012345678901234567890,33,132,39],\"zoom\":7}", "BAD_BBOX"),
                error("bbox member 400-digit integer", "{\"type\":\"subscribe\",\"bbox\":[124,33," + HUGE + ",39],\"zoom\":7}", "BAD_BBOX"),
                error("bbox member -400-digit integer", "{\"type\":\"subscribe\",\"bbox\":[-" + HUGE + ",33,132,39],\"zoom\":7}", "BAD_BBOX"),
                // Jackson 의 숫자 길이 상한(1,000자리 — StreamReadConstraints)을 넘으면 JSON 해석 오류다(BAD_JSON · 1002)
                fatal("number over 1000 digits", "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":1" + "0".repeat(1000) + "}", "BAD_JSON"),
                error("bbox member string", "{\"type\":\"subscribe\",\"bbox\":[\"124\",33,132,39],\"zoom\":7}", "BAD_BBOX"),
                error("bbox three members", "{\"type\":\"subscribe\",\"bbox\":[124,33,132],\"zoom\":7}", "BAD_BBOX"),
                error("bbox string", "{\"type\":\"subscribe\",\"bbox\":\"124,33,132,39\",\"zoom\":7}", "BAD_BBOX"),
                // select · select_ship · layers · resync
                error("hex number", "{\"type\":\"select\",\"hex\":1e10}", "BAD_HEX"),
                error("hex array", "{\"type\":\"select\",\"hex\":[\"a1b2c3\"]}", "BAD_HEX"),
                error("mmsi number", "{\"type\":\"select_ship\",\"mmsi\":440000001}", "BAD_MMSI"),
                error("mmsi 1e20", "{\"type\":\"select_ship\",\"mmsi\":1e20}", "BAD_MMSI"),
                error("layers number", "{\"type\":\"layers\",\"aircraft\":1e10}", "BAD_LAYERS"),
                error("layers string", "{\"type\":\"layers\",\"ships\":\"true\"}", "BAD_LAYERS"),
                error("resync scope number", "{\"type\":\"resync\",\"scope\":1e10}", "BAD_RESYNC"),
                error("resync scope object", "{\"type\":\"resync\",\"scope\":{}}", "BAD_RESYNC"),
                okSubscribed("resync scope null", "{\"type\":\"resync\",\"scope\":null}"),
                // 메시지 모양
                error("type number", "{\"type\":1e10}", "UNKNOWN_TYPE"),
                error("type object", "{\"type\":{}}", "UNKNOWN_TYPE"),
                error("array message", "[1e400]", "UNKNOWN_TYPE"),
                error("null message", "null", "UNKNOWN_TYPE"),
                ok("ping with extra numbers", "{\"type\":\"ping\",\"n\":1e400}"),
                okSubscribed("pause then numbers", "{\"type\":\"pause\",\"n\":123456789012345678901234567890}"),
                fatal("not json", "{\"type\":", "BAD_JSON"));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("rows")
    void badNumbersAndTypesAreClientErrorsNeverHandlerExceptions(Row row) throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.connect("s1", "1.2.3.4");
            k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
            if (row.subscribeFirst()) k.msg(f, "{\"type\":\"subscribe\",\"bbox\":" + BOX + ",\"zoom\":7}");
            int before = f.sent.size();
            assertThatCode(() -> k.msg(f, row.message())).as(row.name()).doesNotThrowAnyException();
            List<JsonNode> after = new ArrayList<>();
            for (String s : f.sent.subList(before, f.sent.size())) after.add(WsTestKit.parse(s));
            List<String> errors = after.stream().filter(n -> "error".equals(n.path("type").asString())).map(n -> n.path("code").asString()).toList();
            if (row.errorCode() == null) {
                assertThat(errors).as(row.name() + " accepted").isEmpty();
                assertThat(f.closedWith).as(row.name() + " still open").isNull();
            } else {
                assertThat(errors).as(row.name()).containsExactly(row.errorCode());
                if (row.fatal()) assertThat(f.closedWith).extracting(CloseStatus::getCode).isEqualTo(CloseStatus.PROTOCOL_ERROR.getCode());
                else assertThat(f.closedWith).as(row.name() + " still open").isNull();
            }
        }
    }

    /** hello 의 proto: 숫자가 아니거나 1 이 아니면(범위 밖 포함) 치명 오류 UNSUPPORTED_PROTO — 예외가 아니다. */
    @ParameterizedTest(name = "proto {0}")
    @MethodSource("badProtos")
    void helloWithABadProtoIsUnsupported(String proto) throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            FakeWsSession f = k.connect("s1", "1.2.3.4");
            assertThatCode(() -> k.msg(f, "{\"type\":\"hello\",\"proto\":" + proto + "}")).doesNotThrowAnyException();
            assertThat(f.sent).anySatisfy(s -> assertThat(WsTestKit.parse(s).path("code").asString()).isEqualTo("UNSUPPORTED_PROTO"));
            assertThat(f.closedWith).extracting(CloseStatus::getCode).isEqualTo(CloseStatus.PROTOCOL_ERROR.getCode());
        }
    }

    static Stream<String> badProtos() {
        return Stream.of("1e10", "-1e10", "4294967297", "123456789012345678901234567890", "1e400", "2", "\"x\"", "null", "{}", "[1]");
    }

    /**
     * 처리기의 마지막 그물(리뷰 cto-2026-10 S4): 메시지를 처리하다 우리 코드에서 예외가 나도(여기서는 선박 팬아웃이 던진다) 처리기 밖으로 나가지 않는다 —
     * 그 연결만 BAD_MESSAGE 로 알리고 1002(프로토콜 오류)로 닫는다. 예전에는 Spring 이 ERROR 스택을 남기고 1011 로 닫았다. WARN 은 분에 한 번 스택 없이.
     */
    @Test
    void anExceptionWhileHandlingAMessageClosesThatClientWithAProtocolErrorAndOneWarning(CapturedOutput out) throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            ShipFanout throwing = new ShipFanout(k.hub, k.ships, k.meters, null, k.shipClock::get) {
                @Override void layersChanged(WsSession s) { throw new IllegalStateException("bug in the ship fan-out"); }
            };
            WakelineWsHandler h = new WakelineWsHandler(k.hub, k.props, WsTestKit.JSON, k.snapshots, throwing);
            List<FakeWsSession> clients = new ArrayList<>();
            for (int i = 0; i < 3; i++) {
                FakeWsSession f = new FakeWsSession("s" + i, "1.2.3.4");
                h.afterConnectionEstablished(f);
                h.handleMessage(f, new TextMessage("{\"type\":\"hello\",\"proto\":1}"));
                assertThatCode(() -> h.handleMessage(f, new TextMessage("{\"type\":\"layers\",\"ships\":true}"))).doesNotThrowAnyException();
                assertThat(WsTestKit.ofType(f, "error")).extracting(n -> n.path("code").asString()).containsExactly("BAD_MESSAGE");
                assertThat(f.closedWith).extracting(CloseStatus::getCode).isEqualTo(CloseStatus.PROTOCOL_ERROR.getCode());
                clients.add(f);
            }
            assertThat(out.getAll().split("ws 'layers' message failed", -1)).as("one WARN per minute, not one per message").hasSize(2);
            assertThat(out.getAll()).doesNotContain("at dev.wakeline.ws.WakelineWsHandler"); // 스택 없음
        }
    }
}
