package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1310(QA 2026-10-aws · api-live — 공개 입력 규칙): ASCII 가 아닌 글자가 유니코드 대소문자 접기로 ASCII 값이 되어 정해진 값 · 검색어로 받아들여진다.
 * <ul>
 *   <li>정해진 값 필터(계약 v5 §G42 — "모르는 값이면 400 BAD_FILTER", 맞는 값은 대소문자를 가리지 않는다): {@code Params.choice} 가
 *       {@code String.equalsIgnoreCase} 로 견주는데, 이것은 글자마다 {@code Character.toUpperCase} · {@code toLowerCase} 라
 *       점 없는 ı(U+0131) → I, 점 있는 İ(U+0130) → i, 긴 s ſ(U+017F) → S 가 맞는 글자로 친다 — {@code group=fır} 가 fir,
 *       {@code kind=obſerved} 가 observed, {@code detail=lıte} 가 lite 로 200.</li>
 *   <li>항공기 검색 {@code q}(ASCII 영숫자 · '-', 2–10자): 검사를 대문자로 바꾼 뒤에 해서({@code q.strip().toUpperCase(Locale.ROOT)} 다음 정규식)
 *       {@code q=ſJO} 가 "SJO" 로, {@code q=ıBX} 가 "IBX" 로 바뀌어 다른 호출부호를 찾고(라이브 스택 A: SJO463 · IBX60), {@code ßß} 는 "SSSS" 가 된다.</li>
 * </ul>
 * 앞선 QA(2026-10 기능 개선 제안 5)가 공항 ICAO · hex 에서 같은 부류('rksı' → RKSI)를 "ASCII 를 먼저 검사" 로 고쳤는데(Params.icao · Params.hex),
 * 정해진 값 필터와 항공기 검색에는 남았다. 선박 검색(ShipQuery)은 ASCII 를 먼저 봐 400 이다(대조군).
 * <p>기대: ASCII 가 아닌 글자가 든 값은 400(필터 BAD_FILTER · 검색 BAD_QUERY). 대조군(ASCII 대문자 · 선박 검색)은 지금도 맞다.
 * <p>실행: {@code cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1310NonAsciiCaseFoldAcceptedIT'}
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1310NonAsciiCaseFoldAcceptedIT extends IntegrationTest {
    @BeforeEach
    void clearCounters() {
        ItStack.deleteKeys("rl:*");
    }

    @ParameterizedTest(name = "{0} → {1} {2}")
    @CsvSource(delimiter = '|', value = {
            // 대조군 — 지금도 맞다
            "/api/v1/stats/sigmet?group=FIR | 200 | -",
            "/api/v1/alerts?kind=OBSERVED | 200 | -",
            "/api/v1/ships/search?q=ev%C4%B1er | 400 | BAD_QUERY",
            "/api/v1/airports/rks%C4%B1/wx | 400 | BAD_ICAO",
            // 정해진 값 필터(§G42)
            "/api/v1/stats/sigmet?group=f%C4%B1r | 400 | BAD_FILTER",
            "/api/v1/stats/sigmet?group=f%C4%B0r | 400 | BAD_FILTER",
            "/api/v1/alerts?kind=ob%C5%BFerved | 400 | BAD_FILTER",
            "/api/v1/alerts?kind=pred%C4%B1cted | 400 | BAD_FILTER",
            "/api/v1/aircraft?bbox=124,33,132,39&detail=l%C4%B1te | 400 | BAD_FILTER",
            // 항공기 검색 q
            "/api/v1/aircraft/search?q=%C5%BFJO | 400 | BAD_QUERY",
            "/api/v1/aircraft/search?q=%C4%B1BX | 400 | BAD_QUERY",
            "/api/v1/aircraft/search?q=%C3%9F%C3%9F | 400 | BAD_QUERY",
            "/api/v1/aircraft/search?q=%EF%AC%801 | 400 | BAD_QUERY",
    })
    void nonAsciiLettersAreNotFoldedIntoAsciiValues(String target, int status, String code) {
        QaRawHttp.Res r = QaRawHttp.send(port, "GET", target,
                java.util.Map.of("Accept", "application/geo+json, application/json, application/problem+json"), null);
        assertThat(r.status()).as("GET %s — body %s", target, r.body()).isEqualTo(status);
        if (!"-".equals(code)) assertThat(r.body()).contains("\"code\":\"" + code + "\"");
    }
}
