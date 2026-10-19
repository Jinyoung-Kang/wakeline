package dev.wakeline.it;

import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 개선 작업 독립 검토 R5: 운영 요청의 자격 확인(OpsSessionLifetimeFilter — 세션의 비밀번호 표식을 DB 의 지금 값과 비교)이 장애가 아닌 '결함'
 * (권한 42501 · 코드 결함)으로 실패하면 500 + ERROR(스택)다(IM-24). 그 ERROR 줄은 응답의 요청 id 로 찾을 수 있어야 한다 — 운영자는 화면 · 응답의
 * request_id 로 시스템 로그를 찾는다. 예전에는 필터가 예외를 다시 던져 Tomcat 이 ERROR 를 남겼는데, 그때는 요청 id 필터가 이미 MDC 를 지운 뒤라
 * 그 줄에 요청 id 가 없었다.
 * 실제 Tomcat(전체 앱)에서 api 계정의 ops_user 읽기 권한을 잠시 빼 결함을 만든다(끝나면 되돌린다 — V1 의 권한 그대로).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class OpsCredentialDefectLogIT extends IntegrationTest {
    static final String PW = "defect-horse-battery-staple";

    @Autowired OpsUserService users;

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aDefectInTheCredentialCheckIsLoggedAtErrorWithTheRequestIdTheResponseCarries(CapturedOutput output) {
        OpsBrowser b = OpsBrowser.login(this, users, "it-cred-defect", PW);
        Res r;
        try {
            admin().sql("REVOKE SELECT ON ops_user FROM wakeline_api").update();
            r = b.get("/api/v1/ops/providers");
        } finally {
            admin().sql("GRANT SELECT ON ops_user TO wakeline_api").update();
        }
        assertThat(r.status()).as("a defect is not hidden as 503 — body: %s", r.body()).isEqualTo(500);
        assertThat(r.header("Retry-After")).isNull();
        String rid = r.header("X-Request-Id");
        assertThat(rid).isNotBlank();
        assertThat(r.body()).contains("\"request_id\":\"" + rid + "\"");
        List<String> errors = Arrays.stream(output.getAll().split("\n")).filter(l -> l.contains(" ERROR ")).toList();
        assertThat(errors).as("ERROR lines: %s", errors).anySatisfy(l -> assertThat(l).contains(rid).contains("/api/v1/ops/providers"));
        assertThat(output.getAll()).as("the stack is kept for a defect").contains("permission denied for table ops_user");
        // 권한을 되돌린 뒤에는 같은 세션이 그대로 쓰인다(결함은 세션을 끝내지 않는다)
        assertThat(b.get("/api/v1/ops/providers").status()).isEqualTo(200);
    }
}
