package dev.wakeline.it;

import dev.wakeline.ops.OpsUserService;
import dev.wakeline.ops.StartupMirror;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-94(계약 v5 §D1 · ADR-019): 운영자가 끈 공급자는 수집기 계정이 Redis 의 disabled 를 바꿔도, Redis 해시를 잃어도(볼륨 손실·AOF 복구)
 * 주기 미러(StartupMirror, 60 s)가 되돌린다 — 원본은 DB provider_switch 이고 Redis 는 미러다.
 * 첫 시험은 HTTP 와 v5 이전에도 있던 빈(StartupMirror)만 써서 이전 코드에서도 돈다 — 이전 코드에서는 실패한다(Redis 가 원본이라 되돌릴 값이 없었다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class ProviderSwitchIT extends IntegrationTest {
    static final String PW = "switch-horse-battery-staple";
    /** 다른 통합 시험이 켜고 끄지 않는 공급자(SecurityIT 는 opensky) */
    static final String PROVIDER = "rainviewer";
    static final String KEY = "wakeline:provider:" + PROVIDER;

    @Autowired OpsUserService users;
    @Autowired StartupMirror mirror;

    static Object flag() { return ItStack.admin().opsForHash().get(KEY, "disabled"); }

    /** 시험 전 해시를 되살린다(없었으면 지운다) — 켜짐 + 필드 없음은 원본(켜짐)과 같은 뜻이라 주기 미러가 다시 쓰지 않는다. */
    static void restore(Map<Object, Object> before) {
        ItStack.admin().delete(KEY);
        if (!before.isEmpty()) ItStack.admin().opsForHash().putAll(KEY, before);
    }

    @Test
    void anOperatorSwitchSurvivesACollectorWriteAndALostRedisHash() {
        OpsBrowser b = OpsBrowser.login(this, users, "it-switch", PW);
        Map<Object, Object> before = new LinkedHashMap<>(ItStack.admin().opsForHash().entries(KEY));
        try {
            assertThat(b.post("/api/v1/ops/providers/" + PROVIDER + "/disable").status()).isBetween(200, 299);
            assertThat(flag()).isEqualTo("1");

            // 수집기 계정은 같은 해시에 상태 필드를 쓰므로(ACL ~wakeline:provider:*) disabled 도 바꿀 수 있다 — 운영자 결정을 감사 없이 뒤집는다
            ItStack.hset(ItStack.collector(), KEY, Map.of("disabled", "0"));
            mirror.periodicMirror();
            assertThat(flag()).as("collector write reverted to the operator's switch").isEqualTo("1");

            // Redis 가 해시를 잃었다 — 꺼 둔 공급자가 조용히 '켜짐'(필드 없음)으로 돌아가지 않는다
            ItStack.admin().delete(KEY);
            mirror.periodicMirror();
            assertThat(flag()).as("lost Redis hash restored from the database").isEqualTo("1");
        } finally {
            b.post("/api/v1/ops/providers/" + PROVIDER + "/enable");
            restore(before);
        }
    }

    /**
     * 운영 목록 GET /ops/providers 의 provider_switch: 모든 공급자의 원본(DB)과 collector 가 따르는 Redis 미러, 그리고 둘이 다른가(mirror_differs).
     * 토글 응답은 원본 행(version · updated_at)과 미러 여부(mirrored)를 돌려준다 — 화면은 이 둘로 "DB 반영 · 수집기 미반영"을 알린다.
     */
    @Test
    void theProviderListCarriesTheDatabaseSwitchAndWhetherRedisMirrorsIt() {
        OpsBrowser b = OpsBrowser.login(this, users, "it-switch-view", PW);
        Map<Object, Object> before = new LinkedHashMap<>(ItStack.admin().opsForHash().entries(KEY));
        try {
            JsonNode all = b.get("/api/v1/ops/providers").json().path("provider_switch");
            List<String> names = new ArrayList<>();
            for (JsonNode s : all) names.add(s.path("provider").asString());
            assertThat(names).containsExactlyElementsOf(dev.wakeline.rest.StatusService.PROVIDERS);
            // null 인 필드는 응답에서 빠진다(앱 JSON 규칙 NON_NULL) — 기동 때 이관된 행은 운영자가 없다(updated_by 없음)
            for (JsonNode s : all) assertThat(s.path("updated_by").isMissingNode() || s.path("updated_by").isString()).isTrue();

            JsonNode off = b.post("/api/v1/ops/providers/" + PROVIDER + "/disable").json();
            assertThat(off.path("mirrored").asBoolean()).isTrue();
            JsonNode s = view(b);
            assertThat(s.path("disabled").asBoolean()).isTrue();
            assertThat(s.path("version").asInt()).isEqualTo(off.path("version").asInt());
            assertThat(s.path("updated_by").asString()).isEqualTo("it-switch-view");
            assertThat(s.path("redis_disabled").asString()).isEqualTo("1");
            assertThat(s.path("mirror_differs").asBoolean()).isFalse();

            // 수집기 계정이 뒤집으면 다음 주기 미러 전까지 '다름' — 주기 미러 뒤 다시 같다
            ItStack.hset(ItStack.collector(), KEY, Map.of("disabled", "0"));
            JsonNode flipped = view(b);
            if (!"1".equals(String.valueOf(flag()))) { // 그 사이 60 s 주기 미러가 돌지 않았다면(대개)
                assertThat(flipped.path("redis_disabled").asString()).isEqualTo("0");
                assertThat(flipped.path("mirror_differs").asBoolean()).isTrue();
            }
            mirror.periodicMirror();
            assertThat(view(b).path("mirror_differs").asBoolean()).isFalse();
        } finally {
            b.post("/api/v1/ops/providers/" + PROVIDER + "/enable");
            restore(before);
        }
    }

    JsonNode view(OpsBrowser b) {
        for (JsonNode s : b.get("/api/v1/ops/providers").json().path("provider_switch")) if (PROVIDER.equals(s.path("provider").asString())) return s;
        throw new AssertionError(PROVIDER + " missing from provider_switch");
    }
}
