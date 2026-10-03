package dev.wakeline.it;

import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 남은 일관성 셋(QA 2026-10 기능 개선 제안 4 · 7 · 10 — 계약 v5 §G43 · §G44 · §G45):
 * <ul>
 *   <li>요청 파라미터를 너그럽게 읽지 않는다: 하나만 받는 파라미터가 두 번 오면 400(예전: 형이 있으면 첫 값, 글자면 쉼표로 이어 붙임), 정수는 ASCII 숫자만
 *       (예전: 0x10 · 전각 ５ · +5 도 받음), 날짜는 ISO(yyyy-MM-dd)만(예전: 요청 로캘의 짧은 형식 10/02/26 도 받음), 앞뒤 공백을 지울 때 NUL 같은 제어 문자는
 *       지우지 않는다(예전: trim() 이 지워 hex=71be01%00 · bbox · q 가 정상으로 지남).</li>
 *   <li>405 의 Allow 는 OPTIONS 가 알리는 것과 같다(GET 이면 HEAD · OPTIONS 도 — 예전: GET 만).</li>
 *   <li>같은 값으로 다시 누른 공급자 켜고 끄기 · 설정 저장은 바꾸는 것이 없다 — version 이 오르지 않고 감사 행도 없다(changed=false). 미러는 다시 한다.
 *       aircraft_providers 는 같은 공급자를 두 번 받지 않는다.</li>
 * </ul>
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StrictInputsIT extends IntegrationTest {
    static final String PW = "strict-horse-battery-staple";
    /** 다른 시험이 켜고 끄지 않는 공급자 */
    static final String PROVIDER = "adsbdb";

    @Autowired OpsUserService users;

    @Test
    void aSingleValueParameterSentTwiceIs400() {
        assertThat(get("/api/v1/alerts/history?limit=5").status()).isEqualTo(200);
        assertProblem(get("/api/v1/alerts/history?limit=5&limit=6"), 400, "BAD_REQUEST", "/api/v1/alerts/history");
        assertProblem(get("/api/v1/sigmets?hazard=TS&hazard=ICE"), 400, "BAD_REQUEST", "/api/v1/sigmets");
        assertProblem(get("/api/v1/stats/traffic?day=2026-10-01&day=2026-10-02"), 400, "BAD_REQUEST", "/api/v1/stats/traffic");
    }

    @Test
    void integersAreAsciiDigitsOnly() {
        for (String odd : new String[]{"0x10", "%EF%BC%95", "%2B5", "1e2", "%235"}) // 0x10 · 전각 ５ · +5 · 1e2 · #5
            assertProblem(get("/api/v1/alerts/history?limit=" + odd), 400, "BAD_REQUEST", "/api/v1/alerts/history");
        assertThat(get("/api/v1/alerts/history?limit=-1").status()).as("음수는 정수 — 범위 밖이라 잘라 쓴다(§G41)").isEqualTo(200);
    }

    @Test
    void datesAreIsoOnly() {
        assertThat(get("/api/v1/stats/traffic?day=2026-10-02").status()).isEqualTo(200);
        // 예전: 로캘의 짧은 형식도 받았다 — 로캘은 요청의 Accept-Language(없으면 JVM 기본)라 같은 글자가 클라이언트에 따라 다른 날이 됐다
        // (02/10/26 → en-US 2026-02-10 · en-GB 서기 26년(범위 밖 400) · ko-KR 400)
        for (String lang : new String[]{"en-US", "en-GB"})
            assertProblem(get("/api/v1/stats/traffic?day=02/10/26", Map.of("Accept-Language", lang)), 400, "BAD_REQUEST", "/api/v1/stats/traffic");
    }

    @Test
    void controlCharactersAreNotTrimmedAway() {
        assertThat(get("/api/v1/alerts/history?hex=71be01").status()).isEqualTo(200);
        assertProblem(get("/api/v1/alerts/history?hex=71be01%00"), 400, "BAD_HEX", "/api/v1/alerts/history");
        assertProblem(get("/api/v1/aircraft?bbox=120%00,30,135,43"), 400, "BAD_BBOX", "/api/v1/aircraft");
        assertProblem(get("/api/v1/ships/search?q=%00AB"), 400, "BAD_QUERY", "/api/v1/ships/search");
        assertThat(get("/api/v1/ships/search?q=%20AB%20").status()).as("공백은 그대로 지운다").isEqualTo(200);
    }

    @Test
    void a405SaysEveryMethodTheResourceAllows() {
        Res options = send("OPTIONS", "/api/v1/status", null, Map.of());
        Res post = send("POST", "/api/v1/status", "{}", Map.of("Content-Type", "application/json"));
        assertThat(post.status()).isEqualTo(405);
        String allow = post.headers().getOrDefault("allow", post.headers().get("Allow")).getFirst();
        String optionsAllow = options.headers().getOrDefault("allow", options.headers().get("Allow")).getFirst();
        assertThat(methods(allow)).as("405 Allow = OPTIONS Allow (%s)", optionsAllow).containsExactlyInAnyOrderElementsOf(methods(optionsAllow));
        assertThat(methods(allow)).contains("GET", "HEAD", "OPTIONS");
    }

    static java.util.List<String> methods(String allow) {
        return java.util.Arrays.stream(allow.split(",")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    @Test
    void pressingTheSameProviderSwitchOrSavingTheSameSettingAgainChangesNothing() {
        OpsBrowser b = OpsBrowser.login(this, users, "it-strict", PW);
        try {
            JsonNode off = b.post("/api/v1/ops/providers/" + PROVIDER + "/disable").json();
            assertThat(off.path("changed").asBoolean()).isTrue();
            long audits = count("SELECT count(*) FROM audit_log WHERE action = 'PROVIDER_DISABLE' AND target = ?", PROVIDER);
            JsonNode again = b.post("/api/v1/ops/providers/" + PROVIDER + "/disable").json();
            assertThat(again.path("version").asInt()).as("이미 꺼진 공급자를 다시 끔 — version 그대로").isEqualTo(off.path("version").asInt());
            assertThat(again.path("changed").asBoolean()).isFalse();
            assertThat(again.path("disabled").asBoolean()).isTrue();
            assertThat(count("SELECT count(*) FROM audit_log WHERE action = 'PROVIDER_DISABLE' AND target = ?", PROVIDER)).as("감사 행 없음").isEqualTo(audits);

            JsonNode s = null;
            for (JsonNode x : b.get("/api/v1/ops/settings").json().path("items")) if ("metar_poll_s".equals(x.path("key").asString())) s = x;
            assertThat(s).isNotNull();
            int version = s.path("version").asInt();
            long settingAudits = count("SELECT count(*) FROM audit_log WHERE action = 'SETTING_UPDATE' AND target = 'metar_poll_s'");
            Res same = b.put("/api/v1/ops/settings/metar_poll_s", "{\"value\":" + s.path("value") + "}", version);
            assertThat(same.status()).isEqualTo(200);
            assertThat(same.json().path("version").asInt()).as("같은 값 저장 — version 그대로").isEqualTo(version);
            assertThat(same.json().path("changed").asBoolean()).isFalse();
            assertThat(count("SELECT count(*) FROM audit_log WHERE action = 'SETTING_UPDATE' AND target = 'metar_poll_s'")).isEqualTo(settingAudits);

            JsonNode ap = null;
            for (JsonNode x : b.get("/api/v1/ops/settings").json().path("items")) if ("aircraft_providers".equals(x.path("key").asString())) ap = x;
            assertProblem(b.put("/api/v1/ops/settings/aircraft_providers", "{\"value\":\"opensky,opensky\"}", ap.path("version").asInt()),
                    400, "BAD_VALUE", "/api/v1/ops/settings/aircraft_providers");
        } finally {
            b.post("/api/v1/ops/providers/" + PROVIDER + "/enable");
        }
    }
}
