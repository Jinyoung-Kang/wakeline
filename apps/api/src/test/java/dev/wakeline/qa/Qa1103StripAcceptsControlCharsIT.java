package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1103(QA 2026-10-aws · api 입력 견고성): 계약 v5 §G43 "앞뒤 공백은 공백 글자만 지운다 — NUL 같은 제어 문자는 남아 각 경로의 형식 검사에 걸린다"
 * (예: {@code hex=71be01%00} → 400 BAD_HEX). 그런데 공통 파라미터 함수가 Java {@code String.strip()} 을 쓰고, strip 은 Character.isWhitespace —
 * 탭 · 줄바꿈 말고도 정보 구분 제어 문자 U+001C–U+001F 까지 지운다(ShipController.normalizeMmsi 는 {@code trim()} — U+0000–U+0020 모두).
 * 그래서 제어 문자(유니코드 Cc)가 앞뒤에 붙은 값이 400 이 아니라 '정상 값'으로 처리된다: Params.hex · Params.icao · Params.choice · NumberParams(정수) ·
 * TimeParams(날짜) · normalizeMmsi. 같은 부류를 공역 category 에서는 결함으로 고쳤다(QA-500 · §G53 — "ASCII 공백만 지운다, 탭 · 제어 문자는 400").
 * 앞선 출시 QA(2026-10-10)는 이것을 개선 제안 1 로만 적었다(재현하지 않음).
 * <p>기대: 400(각 경로의 형식 코드). 대조군 {@code %00} 은 이미 400 이다.
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1103StripAcceptsControlCharsIT'}
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1103StripAcceptsControlCharsIT extends IntegrationTest {
    @BeforeEach
    void clearCounters() {
        ItStack.deleteKeys("rl:*");
    }

    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', value = {
            // 대조군(지금도 400 — §G43 의 예)
            "/api/v1/alerts/history?hex=71be01%00 | BAD_HEX",
            // U+001F(단위 구분) · U+001C(파일 구분) — 공백이 아닌 제어 문자
            "/api/v1/alerts/history?hex=71be01%1F | BAD_HEX",
            "/api/v1/alerts/history?hex=%1C71be01 | BAD_HEX",
            "/api/v1/aircraft/71be01%1F | BAD_HEX",
            "/api/v1/airports/RKSI%1F/wx | BAD_ICAO",
            "/api/v1/ships/440123456%1F | BAD_MMSI",
            "/api/v1/alerts/history?limit=10%1F | BAD_REQUEST",
            "/api/v1/alerts?kind=observed%1F | BAD_FILTER",
            "/api/v1/stats/sigmet?group=fir%1F | BAD_FILTER",
            "/api/v1/stats/traffic?day=2026-10-01%1F | BAD_REQUEST",
            // 탭(U+0009) — 제어 문자이면서 공백. 공역 category 는 400(§G53), 여기서는 지운다
            "/api/v1/alerts/history?hex=71be01%09 | BAD_HEX",
            "/api/v1/ships/440123456%09 | BAD_MMSI",
    })
    void controlCharactersAroundAParameterAre400(String target, String code) {
        QaRawHttp.Res r = QaRawHttp.get(port, target);
        assertThat(r.status()).as("GET %s — body %s", target, r.body()).isEqualTo(400);
        assertThat(r.body()).contains("\"code\":\"" + code + "\"");
    }
}
