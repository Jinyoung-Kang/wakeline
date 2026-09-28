package dev.wakeline.config;

import org.apache.catalina.Valve;
import org.apache.catalina.core.StandardHost;
import org.apache.catalina.valves.ErrorReportValve;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** R-84: MVC 밖 problem+json 본문(이스케이프·상태 이름)과 호스트 오류 보고 밸브 교체. 실제 거절 경로는 SecurityIT. */
class ProblemJsonTest {

    @Test
    void bodyIsValidJsonEvenForHostileInstanceStrings() {
        String instance = "/api/v1/x\"},\"code\":\"OK\\\n\u0001 ";
        JsonNode n = JsonMapper.builder().build().readTree(ProblemJson.body(400, "BAD_REQUEST", "bad request", "request rejected", instance, "rid-1"));
        assertThat(n.path("instance").asString()).isEqualTo(instance);
        assertThat(n.path("code").asString()).isEqualTo("BAD_REQUEST");
        assertThat(n.path("type").asString()).isEqualTo("https://wakeline.invalid/problems/bad-request");
        assertThat(n.path("status").asInt()).isEqualTo(400);
        assertThat(n.path("request_id").asString()).isEqualTo("rid-1");
        assertThat(ProblemJson.str(null)).isEqualTo("null");
        assertThat(ProblemJson.str("tab\there\r")).isEqualTo("\"tab\\there\\r\"");
    }

    @Test
    void statusOnlyErrorsUseTheStatusName() {
        assertThat(ProblemJson.codeAndTitle(400)).containsExactly("BAD_REQUEST", "bad request");
        assertThat(ProblemJson.codeAndTitle(505)).containsExactly("HTTP_VERSION_NOT_SUPPORTED", "http version not supported");
        assertThat(ProblemJson.codeAndTitle(599)).containsExactly("ERROR", "error");
    }

    @Test
    void hostKeepsExactlyOneProblemErrorReportValve() {
        StandardHost host = new StandardHost();
        ErrorReportValve bootDefault = new ErrorReportValve();
        host.getPipeline().addValve(bootDefault);
        ProblemErrorReportValve.Customizer.install(host);
        ProblemErrorReportValve.Customizer.install(host); // 두 번 불려도 하나
        List<Class<?>> reporters = new ArrayList<>();
        for (Valve v : host.getPipeline().getValves()) if (v instanceof ErrorReportValve) reporters.add(v.getClass());
        assertThat(reporters).containsExactly(ProblemErrorReportValve.class);
        assertThat(new ProblemErrorReportValve().isShowReport()).isFalse();
        assertThat(new ProblemErrorReportValve().isShowServerInfo()).isFalse();
        assertThat(new ProblemErrorReportValve.Customizer().getOrder()).isEqualTo(org.springframework.core.Ordered.LOWEST_PRECEDENCE);
    }
}
