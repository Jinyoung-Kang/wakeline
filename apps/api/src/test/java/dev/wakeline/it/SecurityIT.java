package dev.wakeline.it;

import dev.wakeline.ops.OpsUserService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 보안 수용 기준(FR-14·FR-15·6.2~6.3절)을 실제 소켓·실제 Redis ACL·실제 DB 로:
 * 익명 /ops → 404(존재 여부 비공개), CSRF 없는 변경 → 403, 5회 실패 잠금(동시 시도로도 못 피함), 세션 쿠키 속성,
 * RFC 9457 본문, 공개 API 121번째 요청 → 429 + Retry-After, 신뢰하지 않는 원격의 X-Forwarded-For 무시.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class SecurityIT extends IntegrationTest {
    static final String PW = "correct-horse-battery-staple";

    @Autowired OpsUserService users;
    @Autowired MockMvc mvc;
    @Autowired org.springframework.context.ApplicationContext ctx;

    /** 쿠키 저장(이름 → 값)과 받은 Set-Cookie 원문. */
    final class Browser {
        final Map<String, String> cookies = new LinkedHashMap<>();
        final List<String> setCookies = new ArrayList<>();

        Res send(String method, String path, String body, Map<String, String> extra) {
            Map<String, String> h = new LinkedHashMap<>(extra);
            if (!cookies.isEmpty()) {
                StringBuilder sb = new StringBuilder();
                cookies.forEach((k, v) -> sb.append(sb.isEmpty() ? "" : "; ").append(k).append('=').append(v));
                h.put("Cookie", sb.toString());
            }
            if (body != null) h.putIfAbsent("Content-Type", "application/json");
            Res r = SecurityIT.this.send(method, path, body, h);
            for (String sc : r.headers("Set-Cookie")) {
                setCookies.add(sc);
                String nv = sc.split(";", 2)[0];
                int eq = nv.indexOf('=');
                String name = nv.substring(0, eq).trim(), value = nv.substring(eq + 1).trim();
                boolean expired = sc.toLowerCase(Locale.ROOT).contains("max-age=0") || value.isEmpty();
                if (expired) cookies.remove(name); else cookies.put(name, value);
            }
            return r;
        }

        Res login(String user, String password) { return login(user, password, Map.of()); }

        Res login(String user, String password, Map<String, String> extra) {
            return send("POST", "/api/v1/ops/session", "{\"username\":\"" + user + "\",\"password\":\"" + password + "\"}", extra);
        }

        String csrf() { return cookies.get("WAKELINE_CSRF"); }

        Map<String, String> withCsrf(String... kv) {
            Map<String, String> h = headers(kv);
            h.put("X-CSRF-Token", csrf());
            return h;
        }

        String setCookie(String name) {
            return setCookies.stream().filter(c -> c.startsWith(name + "=")).reduce((a, b) -> b).orElse(null);
        }
    }

    long audit(String action, String target) {
        return count("SELECT count(*) FROM audit_log WHERE action = ? AND target = ?", action, target);
    }

    /** 이 브라우저의 세션이 저장된 Redis 해시 키(쿠키 값 = base64(세션 id)). */
    static String sessionKey(Browser b) {
        String cookie = b.cookies.get("WAKELINE_SESSION");
        assertThat(cookie).as("session cookie").isNotNull();
        return "wakeline:session:sessions:" + new String(java.util.Base64.getDecoder().decode(cookie), java.nio.charset.StandardCharsets.UTF_8);
    }

    /** 세션 해시 필드를 Spring Session 과 같은 형식(JDK 직렬화)으로 덮어쓴다 — 시간이 흐른 세션을 흉내 낸다. */
    static void setSessionField(String key, String field, Object value) {
        byte[] bytes;
        try (var bos = new java.io.ByteArrayOutputStream(); var out = new java.io.ObjectOutputStream(bos)) {
            out.writeObject(value);
            out.flush();
            bytes = bos.toByteArray();
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
        ItStack.admin().execute((org.springframework.data.redis.core.RedisCallback<Object>) c ->
                c.hashCommands().hSet(key.getBytes(java.nio.charset.StandardCharsets.UTF_8), field.getBytes(java.nio.charset.StandardCharsets.UTF_8), bytes));
    }

    static void deleteSessionField(String key, String field) {
        ItStack.admin().opsForHash().delete(key, field);
    }

    // ---------- 익명 → 404 ----------

    @Test
    void anonymousOpsRequestsAre404WhetherOrNotTheResourceExists() {
        JsonNode existing = assertProblem(get("/api/v1/ops/providers"), 404, "NOT_FOUND", "/api/v1/ops/providers");
        JsonNode missing = assertProblem(get("/api/v1/ops/no-such-endpoint"), 404, "NOT_FOUND", "/api/v1/ops/no-such-endpoint");
        assertProblem(get("/api/v1/ops/settings"), 404, "NOT_FOUND", "/api/v1/ops/settings");
        assertProblem(get("/api/v1/ops/audit"), 404, "NOT_FOUND", "/api/v1/ops/audit");
        assertProblem(get("/api/v1/ops/session"), 404, "NOT_FOUND", "/api/v1/ops/session");
        // 있는 자원과 없는 자원의 응답이 구별되지 않는다(경로·요청 id 만 다르다)
        assertThat(existing.path("title")).isEqualTo(missing.path("title"));
        assertThat(existing.path("detail")).isEqualTo(missing.path("detail"));

        // 변경 요청: CSRF 검사가 인가보다 먼저 — 있는/없는 경로 모두 같은 403(존재 여부를 알려 주지 않는다)
        Browser b = new Browser();
        assertProblem(b.send("PUT", "/api/v1/ops/settings/region_poll_s", "{\"value\":20}", headers("If-Match", "1")), 403, "CSRF_INVALID", "/api/v1/ops/settings/region_poll_s");
        assertProblem(b.send("PUT", "/api/v1/ops/nope", "{}", Map.of()), 403, "CSRF_INVALID", "/api/v1/ops/nope");
        // CSRF 쌍(쿠키 + 헤더)을 갖춰도 익명이면 404
        assertThat(b.csrf()).as("CSRF cookie issued to the SPA").isNotBlank();
        assertProblem(b.send("PUT", "/api/v1/ops/settings/region_poll_s", "{\"value\":20}", b.withCsrf("If-Match", "1")), 404, "NOT_FOUND", "/api/v1/ops/settings/region_poll_s");
        assertProblem(b.send("POST", "/api/v1/ops/providers/opensky/disable", null, b.withCsrf()), 404, "NOT_FOUND", "/api/v1/ops/providers/opensky/disable");
    }

    // ---------- 로그인 · 세션 쿠키 · CSRF ----------

    @Test
    void loginSetsHttpOnlySameSiteStrictSessionStoredUnderTheAclNamespace() {
        users.upsert("it-ops", PW);
        Browser b = new Browser();
        // 신뢰하지 않는 원격이 보낸 X-Forwarded-For 는 무시된다 — 감사 로그의 IP 는 실제 접속 주소
        Res r = b.login("it-ops", PW, headers("X-Forwarded-For", "203.0.113.9"));
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.json().path("username").asString()).isEqualTo("it-ops");
        assertThat(r.json().has("password")).isFalse();

        String session = b.setCookie("WAKELINE_SESSION");
        assertThat(session).as("session cookie").isNotNull();
        String attrs = session.toLowerCase(Locale.ROOT);
        assertThat(attrs).contains("; httponly").contains("; samesite=strict");
        // R-97: 세션 쿠키는 api 경로에만 — 웹(Next) 요청에는 실리지 않는다. CSRF 쿠키는 화면 스크립트가 읽어야 해서 / 그대로
        assertThat(attrs).contains("; path=/api;").doesNotContain("; path=/;");
        String csrf = b.setCookie("WAKELINE_CSRF");
        assertThat(csrf).as("CSRF cookie (double submit)").isNotNull();
        assertThat(csrf.toLowerCase(Locale.ROOT)).contains("samesite=strict").contains("; path=/;").doesNotContain("httponly"); // 화면 스크립트가 읽어 헤더로 보낸다

        // 세션은 Redis ACL 이 허용한 이름공간에만(Boot 4 키 이름 변경 회귀 방지 — 예전 키로는 spring:session:* 에 써서 NOPERM)
        assertThat(ItStack.admin().keys("wakeline:session:*")).isNotEmpty();
        assertThat(ItStack.admin().keys("spring:session:*")).isEmpty();

        Res me = b.send("GET", "/api/v1/ops/session", null, Map.of());
        assertThat(me.status()).isEqualTo(200);
        assertThat(me.json().path("role").asString()).isEqualTo("OPS");
        assertThat(b.send("GET", "/api/v1/ops/providers", null, Map.of()).status()).isEqualTo(200);

        String ip = db.sql("SELECT host(ip) FROM audit_log WHERE action = 'LOGIN' AND target = 'it-ops' ORDER BY id DESC LIMIT 1").query(String.class).single();
        assertThat(ip).isEqualTo("127.0.0.1");

        // 로그아웃도 CSRF 필요 → 뒤에는 같은 쿠키로 다시 404
        assertProblem(b.send("DELETE", "/api/v1/ops/session", null, Map.of()), 403, "CSRF_INVALID", "/api/v1/ops/session");
        assertThat(b.send("DELETE", "/api/v1/ops/session", null, b.withCsrf()).status()).isEqualTo(204);
        assertProblem(b.send("GET", "/api/v1/ops/providers", null, Map.of()), 404, "NOT_FOUND", "/api/v1/ops/providers");
    }

    @Test
    void opsChangeWithoutCsrfHeaderIs403AndChangesNothing() {
        users.upsert("it-csrf", PW);
        Browser b = new Browser();
        assertThat(b.login("it-csrf", PW).status()).isEqualTo(200);
        Res list = b.send("GET", "/api/v1/ops/settings", null, Map.of());
        assertThat(list.status()).isEqualTo(200);
        int version = -1;
        for (JsonNode it : list.json().path("items")) if ("region_poll_s".equals(it.path("key").asString())) version = it.path("version").asInt();
        assertThat(version).isPositive();
        String ifMatch = String.valueOf(version);
        long auditBefore = audit("SETTING_UPDATE", "region_poll_s");

        // 쿠키만(헤더 없음) — 교차 사이트 요청이 할 수 있는 전부
        assertProblem(b.send("PUT", "/api/v1/ops/settings/region_poll_s", "{\"value\":15}", headers("If-Match", ifMatch)),
                403, "CSRF_INVALID", "/api/v1/ops/settings/region_poll_s");
        // 틀린 토큰
        assertProblem(b.send("PUT", "/api/v1/ops/settings/region_poll_s", "{\"value\":15}", headers("If-Match", ifMatch, "X-CSRF-Token", "forged-token")),
                403, "CSRF_INVALID", "/api/v1/ops/settings/region_poll_s");
        assertProblem(b.send("POST", "/api/v1/ops/providers/opensky/disable", null, Map.of()), 403, "CSRF_INVALID", "/api/v1/ops/providers/opensky/disable");
        assertThat(db.sql("SELECT version FROM app_setting WHERE key = 'region_poll_s'").query(Integer.class).single()).isEqualTo(version);
        assertThat(audit("SETTING_UPDATE", "region_poll_s")).isEqualTo(auditBefore);

        // 쿠키 + 같은 값의 헤더 → 성공, 감사, Redis 미러(수집기가 읽는 값)
        Res ok = b.send("PUT", "/api/v1/ops/settings/region_poll_s", "{\"value\":15}", b.withCsrf("If-Match", ifMatch));
        assertThat(ok.status()).isEqualTo(200);
        assertThat(ok.json().path("version").asInt()).isEqualTo(version + 1);
        assertThat(ok.json().path("mirrored").asBoolean()).isTrue();
        assertThat(audit("SETTING_UPDATE", "region_poll_s")).isEqualTo(auditBefore + 1);
        assertThat(ItStack.admin().opsForHash().get("wakeline:settings", "region_poll_s")).isEqualTo("15");
        // 같은 버전으로 다시 → 409(낙관적 잠금)
        assertProblem(b.send("PUT", "/api/v1/ops/settings/region_poll_s", "{\"value\":20}", b.withCsrf("If-Match", ifMatch)),
                409, "VERSION_MISMATCH", "/api/v1/ops/settings/region_poll_s");
        // If-Match 없음 → 428
        assertThat(b.send("PUT", "/api/v1/ops/settings/region_poll_s", "{\"value\":20}", b.withCsrf()).status()).isEqualTo(428);
    }

    @Test
    void authenticatedOperatorEndpointsWorkAndEveryChangeIsAudited() {
        users.upsert("it-ops2", PW);
        Browser b = new Browser();
        assertThat(b.login("it-ops2", PW).status()).isEqualTo(200);

        // FR-13 /ops/providers 계약 — 공급자 상태는 수집기가 wakeline:provider:{name} 에 쓴다(수집기 ACL 사용자로 흉내)
        ItStack.hset(ItStack.collector(), "wakeline:provider:adsb_lol", Map.of("state", "ok", "last_ok_at", java.time.Instant.now().toString()));
        JsonNode prov = b.send("GET", "/api/v1/ops/providers", null, Map.of()).json();
        assertThat(prov.has("providers") && prov.has("active") && prov.has("collector") && prov.has("switches") && prov.has("budget_days")).isTrue();
        List<String> names = new ArrayList<>();
        for (JsonNode p : prov.path("providers")) names.add(p.path("name").asString());
        assertThat(names).contains("adsb_lol");
        for (String path : List.of("/api/v1/ops/runs?limit=5", "/api/v1/ops/quality?days=3", "/api/v1/ops/dlq", "/api/v1/ops/audit?limit=5", "/api/v1/ops/settings"))
            assertThat(b.send("GET", path, null, Map.of()).status()).as(path).isEqualTo(200);
        JsonNode auditPage = b.send("GET", "/api/v1/ops/audit?limit=200", null, Map.of()).json();
        boolean sawLogin = false;
        for (JsonNode a : auditPage.path("items")) if ("LOGIN".equals(a.path("action").asString()) && "it-ops2".equals(a.path("username").asString())) sawLogin = true;
        assertThat(sawLogin).isTrue();

        // 공급자 토글: CSRF 필요, 감사 + Redis 플래그(수집기가 읽는다)
        long before = audit("PROVIDER_DISABLE", "opensky");
        assertThat(b.send("POST", "/api/v1/ops/providers/opensky/disable", null, b.withCsrf()).status()).isEqualTo(204);
        assertThat(ItStack.admin().opsForHash().get("wakeline:provider:opensky", "disabled")).isEqualTo("1");
        assertThat(audit("PROVIDER_DISABLE", "opensky")).isEqualTo(before + 1);
        assertThat(b.send("POST", "/api/v1/ops/providers/opensky/enable", null, b.withCsrf()).status()).isEqualTo(204);
        assertThat(ItStack.admin().opsForHash().get("wakeline:provider:opensky", "disabled")).isEqualTo("0");
        assertProblem(b.send("POST", "/api/v1/ops/providers/nope/disable", null, b.withCsrf()), 404, "NOT_FOUND", "/api/v1/ops/providers/nope/disable");
        assertProblem(b.send("POST", "/api/v1/ops/providers/opensky/explode", null, b.withCsrf()), 404, "NOT_FOUND", "/api/v1/ops/providers/opensky/explode");

        // 통계 재집계(멱등) + 감사
        String day = java.time.LocalDate.now(java.time.ZoneOffset.UTC).minusDays(2).toString();
        Res agg = b.send("POST", "/api/v1/ops/stats/aggregate?day=" + day, null, b.withCsrf());
        assertThat(agg.status()).isEqualTo(200);
        assertThat(agg.json().path("day").asString()).isEqualTo(day);
        assertThat(audit("STATS_AGGREGATE", day)).isEqualTo(1);
        // 잘못된 설정 값은 검증에서 거절(범위 밖 좌표)
        Res list = b.send("GET", "/api/v1/ops/settings", null, Map.of());
        String v = null;
        for (JsonNode it : list.json().path("items")) if ("region_center".equals(it.path("key").asString())) v = it.path("version").asString();
        assertProblem(b.send("PUT", "/api/v1/ops/settings/region_center", "{\"value\":\"99,999\"}", b.withCsrf("If-Match", v)),
                400, "BAD_VALUE", "/api/v1/ops/settings/region_center");
        assertProblem(b.send("PUT", "/api/v1/ops/settings/no_such_key", "{\"value\":1}", b.withCsrf("If-Match", "1")),
                404, "NOT_FOUND", "/api/v1/ops/settings/no_such_key");
        // AIS 구독 영역: 틀린 값은 거절, 맞는 값은 감사 기록과 함께 저장되고 wakeline:settings 에 미러된다(ais 가 30 s 마다 읽는다)
        String av = null;
        for (JsonNode it : list.json().path("items")) if ("ais_bboxes".equals(it.path("key").asString())) av = it.path("version").asString();
        assertThat(av).isNotNull();
        assertProblem(b.send("PUT", "/api/v1/ops/settings/ais_bboxes", "{\"value\":\"0,0,0,5\"}", b.withCsrf("If-Match", av)),
                400, "BAD_VALUE", "/api/v1/ops/settings/ais_bboxes");
        Res ais = b.send("PUT", "/api/v1/ops/settings/ais_bboxes", "{\"value\":\"-90,-180,90,180\"}", b.withCsrf("If-Match", av));
        assertThat(ais.status()).isEqualTo(200);
        assertThat(ItStack.admin().opsForHash().get("wakeline:settings", "ais_bboxes")).isEqualTo("-90,-180,90,180");
        assertThat(audit("SETTING_UPDATE", "ais_bboxes")).isEqualTo(1);
    }

    // ---------- 세션 절대 수명(R-54) ----------

    /**
     * 유휴 한도(8 h)는 요청마다 연장된다 — /ops 탭의 15 s 폴링이 세션을 무기한 살려 두었다. 로그인 시각부터 8 h 가 지나면 요청이 계속 와도
     * 세션을 끝낸다(ADR-017 §3): 그 요청은 익명(404)이 되고 Redis 의 세션도 지워진다.
     */
    @Test
    void opsSessionEndsAtItsAbsoluteLifetimeEvenWhenKeptBusy() {
        users.upsert("it-abs", PW);
        Browser b = new Browser();
        assertThat(b.login("it-abs", PW).status()).isEqualTo(200);
        for (int i = 0; i < 3; i++) assertThat(b.send("GET", "/api/v1/ops/providers", null, Map.of()).status()).isEqualTo(200); // 폴링
        String key = sessionKey(b);
        long loggedIn = System.currentTimeMillis() - java.time.Duration.ofHours(8).plusMinutes(1).toMillis();
        setSessionField(key, "sessionAttr:ops_auth_at", loggedIn);
        setSessionField(key, "creationTime", loggedIn);

        assertProblem(b.send("GET", "/api/v1/ops/providers", null, Map.of()), 404, "NOT_FOUND", "/api/v1/ops/providers");
        assertThat(ItStack.admin().hasKey(key)).as("expired session removed from Redis").isFalse();
        assertProblem(b.send("GET", "/api/v1/ops/session", null, Map.of()), 404, "NOT_FOUND", "/api/v1/ops/session");
        // 다시 로그인하면 새 8 h
        assertThat(b.login("it-abs", PW, b.withCsrf()).status()).isEqualTo(200);
        assertThat(b.send("GET", "/api/v1/ops/providers", null, Map.of()).status()).isEqualTo(200);
    }

    /**
     * 경로의 글자를 퍼센트 인코딩해도(%6Fps = ops) Tomcat·Spring 은 디코딩한 경로로 운영 API 에 보내고 인가한다. 수명 검사와 CSRF 면제
     * 판단이 원문 URI 앞부분만 보면 이 요청은 두 검사를 모두 건너뛴다(R-54 후속). 인가와 같은 규칙으로 판단해야 한다.
     */
    @Test
    void percentEncodedOpsPathCannotSkipTheLifetimeCheck() {
        users.upsert("it-abs-enc", PW);
        Browser b = new Browser();
        assertThat(b.login("it-abs-enc", PW).status()).isEqualTo(200);
        assertThat(b.send("GET", "/api/v1/%6Fps/providers", null, Map.of()).status()).as("encoded path reaches the ops API").isEqualTo(200);
        String key = sessionKey(b);
        long loggedIn = System.currentTimeMillis() - java.time.Duration.ofHours(8).plusMinutes(1).toMillis();
        setSessionField(key, "sessionAttr:ops_auth_at", loggedIn);
        setSessionField(key, "creationTime", loggedIn);

        assertThat(b.send("GET", "/api/v1/%6Fps/providers", null, Map.of()).status()).isEqualTo(404);
        assertThat(ItStack.admin().hasKey(key)).as("expired session removed from Redis").isFalse();
    }

    @Test
    void anonymousPercentEncodedOpsPathIs404() {
        for (String path : List.of("/api/v1/%6Fps/providers", "/api/v1/o%70s/settings", "/api/v%31/ops/audit", "/api/v1/%6F%70%73/pipeline"))
            assertThat(get(path).status()).as(path).isEqualTo(404);
    }

    @Test
    void percentEncodedOpsPathStillNeedsCsrf() {
        users.upsert("it-csrf-enc", PW);
        Browser b = new Browser();
        assertThat(b.login("it-csrf-enc", PW).status()).isEqualTo(200);
        long auditBefore = audit("PROVIDER_DISABLE", "opensky");
        Res r = b.send("POST", "/api/v1/%6Fps/providers/opensky/disable", null, Map.of());
        if (r.status() == 204) b.send("POST", "/api/v1/ops/providers/opensky/enable", null, b.withCsrf()); // 우회됐다면 다른 테스트를 위해 되돌린다
        assertThat(r.status()).as("cookie-only change on an encoded ops path").isEqualTo(403);
        assertThat(audit("PROVIDER_DISABLE", "opensky")).isEqualTo(auditBefore);
    }

    /** 로그인 시각 속성이 없는 세션(이 규칙 전에 만들어진 세션)은 세션 생성 시각으로 판단한다. 7 h 59 분이면 아직 유효하다. */
    @Test
    void sessionWithoutLoginTimeFallsBackToItsCreationTime() {
        users.upsert("it-abs2", PW);
        Browser b = new Browser();
        assertThat(b.login("it-abs2", PW).status()).isEqualTo(200);
        String key = sessionKey(b);
        deleteSessionField(key, "sessionAttr:ops_auth_at");
        setSessionField(key, "creationTime", System.currentTimeMillis() - java.time.Duration.ofHours(8).minusMinutes(1).toMillis());
        assertThat(b.send("GET", "/api/v1/ops/providers", null, Map.of()).status()).isEqualTo(200);

        setSessionField(key, "creationTime", System.currentTimeMillis() - java.time.Duration.ofHours(8).plusMinutes(1).toMillis());
        assertProblem(b.send("GET", "/api/v1/ops/providers", null, Map.of()), 404, "NOT_FOUND", "/api/v1/ops/providers");
        assertThat(ItStack.admin().hasKey(key)).isFalse();
    }

    // ---------- 비밀번호 변경 → 기존 세션 폐기(R-95) ----------

    /**
     * make ops-user(= OpsUserService.upsert)로 비밀번호를 바꾸면 그 사용자의 기존 세션이 모두 끝난다(ADR-017 §3) — 탈취된 세션 쿠키가
     * 비밀번호 교체 뒤에도 유효하면 안 된다. 다른 운영자의 세션은 그대로다.
     */
    @Test
    void changingThePasswordEndsAllExistingSessionsOfThatUser() {
        users.upsert("it-rotate", PW);
        users.upsert("it-bystander", PW);
        Browser first = new Browser(), second = new Browser(), bystander = new Browser();
        assertThat(first.login("it-rotate", PW).status()).isEqualTo(200);
        assertThat(second.login("it-rotate", PW).status()).isEqualTo(200);
        assertThat(bystander.login("it-bystander", PW).status()).isEqualTo(200);
        for (Browser b : List.of(first, second, bystander)) assertThat(b.send("GET", "/api/v1/ops/providers", null, Map.of()).status()).isEqualTo(200);
        String firstKey = sessionKey(first);

        String newPw = "rotated-" + PW;
        users.upsert("it-rotate", newPw); // ops-user CLI 경로

        for (Browser b : List.of(first, second))
            assertProblem(b.send("GET", "/api/v1/ops/providers", null, Map.of()), 404, "NOT_FOUND", "/api/v1/ops/providers");
        assertThat(ItStack.admin().hasKey(firstKey)).as("revoked session deleted from Redis").isFalse();
        assertThat(bystander.send("GET", "/api/v1/ops/providers", null, Map.of()).status()).as("other operator unaffected").isEqualTo(200);
        assertThat(new Browser().login("it-rotate", PW).status()).isEqualTo(401);
        Browser fresh = new Browser();
        assertThat(fresh.login("it-rotate", newPw).status()).isEqualTo(200);
        assertThat(fresh.send("GET", "/api/v1/ops/providers", null, Map.of()).status()).isEqualTo(200);
    }

    // ---------- 잠금 ----------

    @Test
    void accountLocksAfterFiveFailuresAndResponsesDoNotRevealWhy() {
        users.upsert("it-lock", PW);
        Browser b = new Browser();
        List<JsonNode> failures = new ArrayList<>();
        for (int i = 0; i < 5; i++)
            failures.add(assertProblem(b.login("it-lock", "wrong-password-" + i), 401, "BAD_CREDENTIALS", "/api/v1/ops/session"));
        // 6번째는 맞는 비밀번호여도 실패(잠김) — 응답은 틀린 비밀번호·없는 계정과 구별되지 않는다
        JsonNode locked = assertProblem(b.login("it-lock", PW), 401, "BAD_CREDENTIALS", "/api/v1/ops/session");
        JsonNode unknown = assertProblem(b.login("it-nobody-" + System.nanoTime(), PW), 401, "BAD_CREDENTIALS", "/api/v1/ops/session");
        for (JsonNode other : List.of(locked, unknown)) {
            assertThat(other.path("detail")).isEqualTo(failures.getFirst().path("detail"));
            assertThat(other.path("title")).isEqualTo(failures.getFirst().path("title"));
        }
        assertThat(b.setCookie("WAKELINE_SESSION")).isNull();

        assertThat(admin().sql("SELECT locked_until > now() FROM ops_user WHERE username = 'it-lock'").query(Boolean.class).single()).isTrue();
        assertThat(audit("LOGIN_FAILED", "it-lock")).isEqualTo(6);
        assertThat(audit("ACCOUNT_LOCKED", "it-lock")).isEqualTo(1);
        assertThat(db.sql("SELECT after->>'reason' FROM audit_log WHERE action = 'LOGIN_FAILED' AND target = 'it-lock' ORDER BY id DESC LIMIT 1")
                .query(String.class).single()).isEqualTo("locked");
    }

    /**
     * R-55: 아이디 칸에 비밀번호를 잘못 치는 흔한 실수 — 지울 수 없는 감사 로그(INSERT·SELECT 권한만)에 그 원문이 남으면 안 된다.
     * 없는 계정의 실패는 'unknown account' 로만 기록하고(사유는 남긴다), 있는 계정은 이름을 그대로 남긴다.
     */
    @Test
    void failedLoginForAnUnknownAccountDoesNotStoreWhatWasTyped() {
        String typed = "Pw-typed-into-username-" + System.nanoTime();
        Res r = new Browser().login(typed, "whatever-password");
        assertProblem(r, 401, "BAD_CREDENTIALS", "/api/v1/ops/session");
        assertThat(count("SELECT count(*) FROM audit_log WHERE target LIKE ? OR before::text LIKE ? OR after::text LIKE ?",
                "%" + typed + "%", "%" + typed + "%", "%" + typed + "%")).as("typed name stored anywhere in audit_log").isZero();
        var row = db.sql("SELECT target, after->>'reason' AS reason FROM audit_log WHERE action = 'LOGIN_FAILED' AND request_id = :rid")
                .param("rid", r.header("X-Request-Id")).query().singleRow();
        assertThat(row.get("target")).isEqualTo("unknown account");
        assertThat(row.get("reason")).isEqualTo("unknown_user");

        users.upsert("it-known", PW);
        Res known = new Browser().login("it-known", "wrong-password-1");
        assertThat(known.status()).isEqualTo(401);
        assertThat(db.sql("SELECT target FROM audit_log WHERE action = 'LOGIN_FAILED' AND request_id = :rid")
                .param("rid", known.header("X-Request-Id")).query(String.class).single()).isEqualTo("it-known");
    }

    @Test
    void parallelWrongPasswordsCannotBypassTheLockout() throws Exception {
        users.upsert("it-par", PW);
        int n = 8; // 로그인 요청 제한(IP 당 분당 10) 안
        awaitFreshMinuteWindow(15);
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Integer>> fs = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            int k = i;
            fs.add(pool.submit(() -> { go.await(); return new Browser().login("it-par", "parallel-wrong-" + k).status(); }));
        }
        go.countDown();
        for (var f : fs) assertThat(f.get()).isEqualTo(401);
        pool.shutdown();
        // 읽고-쓰기 방식이었다면 동시 실패가 서로 덮어써 잠기지 않을 수 있다. 원자적 UPDATE 로 정확히 한 번 잠긴다.
        assertThat(admin().sql("SELECT locked_until > now() FROM ops_user WHERE username = 'it-par'").query(Boolean.class).single()).isTrue();
        assertThat(audit("ACCOUNT_LOCKED", "it-par")).isEqualTo(1);
        assertThat(audit("LOGIN_FAILED", "it-par")).isEqualTo(n);
        assertThat(new Browser().login("it-par", PW).status()).isEqualTo(401);
    }

    @Test
    void loginAttemptsAreRateLimitedPerIpWithRetryAfter() {
        awaitFreshMinuteWindow(20);
        Browser b = new Browser();
        for (int i = 0; i < 10; i++) assertThat(b.login("it-rl-" + i, "whatever-password").status()).isEqualTo(401);
        JsonNode p = assertProblem(b.login("it-rl-x", "whatever-password", headers("X-Forwarded-For", "198.51.100.77")), 429, "RATE_LIMITED", "/api/v1/ops/session");
        assertThat(p.path("detail").asString()).contains("login");
    }

    // ---------- 공개 API 요청 제한 · X-Forwarded-For ----------

    @Test
    void publicApi121stRequestGets429WithRetryAfterAndForgedForwardedForIsIgnored() throws Exception {
        awaitFreshMinuteWindow(20);
        for (int i = 1; i <= 120; i++) {
            // 매번 다른 XFF — 믿었다면 요청마다 새 버킷이 되어 제한이 걸리지 않는다
            Res r = get("/api/v1/status", headers("X-Forwarded-For", "203.0.113." + i));
            assertThat(r.status()).as("request #%d", i).isEqualTo(200);
            assertThat(r.header("X-RateLimit-Limit")).isEqualTo("120");
            assertThat(r.header("X-RateLimit-Remaining")).isEqualTo(String.valueOf(120 - i));
        }
        Res limited = get("/api/v1/status", headers("X-Forwarded-For", "203.0.113.200"));
        assertProblem(limited, 429, "RATE_LIMITED", "/api/v1/status");
        int retryAfter = Integer.parseInt(limited.header("Retry-After"));
        assertThat(retryAfter).isBetween(1, 60);
        assertThat(limited.header("X-RateLimit-Remaining")).isEqualTo("0");
        // 카운터는 실제 접속 주소 하나에만 쌓였다
        assertThat(ItStack.admin().keys("rl:api:203.0.113.*")).isEmpty();
        var mine = ItStack.admin().keys("rl:api:127.0.0.1:*");
        assertThat(mine).hasSize(1);
        assertThat(ItStack.admin().opsForValue().get(mine.iterator().next())).isEqualTo("121");
        // 경로 글자를 인코딩해도(%61pi = api) 같은 API 로 가므로 같은 제한을 받는다(원문 URI 앞부분만 보면 제한을 건너뛴다 — R-54 후속)
        assertProblem(get("/%61pi/v1/status"), 429, "RATE_LIMITED", "/%61pi/v1/status");
        // /api 밖(헬스체크)은 제한 대상이 아니다
        assertThat(get("/healthz").status()).isEqualTo(200);

        // 대조군: 신뢰 프록시(edge)에서 온 요청의 XFF 는 첫 값이 클라이언트다
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/v1/status").with(req -> { req.setRemoteAddr(TRUSTED_PROXY); return req; })
                        .header("X-Forwarded-For", "198.51.100.7, 10.0.0.1"))
                .andExpect(status().isOk());
        assertThat(ItStack.admin().keys("rl:api:198.51.100.7:*")).hasSize(1);
    }

    // ---------- 자동 생성 계정 없음(R-28) ----------

    /**
     * Spring Boot 의 UserDetailsServiceAutoConfiguration 은 다른 인증 수단이 없으면 in-memory 'user' 계정을 만들고 그 비밀번호를
     * 기동 로그에 WARN 으로 찍는다(비밀값이 로그에). 운영자 인증은 OpsUserService(BCrypt)뿐이므로 그런 계정이 아예 없어야 한다.
     */
    @Test
    void noGeneratedInMemoryUserAccountExists() {
        assertThat(ctx.getBeanNamesForType(org.springframework.security.core.userdetails.UserDetailsService.class)).isEmpty();
    }

    // ---------- RFC 9457 · 보안 헤더 ----------

    @Test
    void errorsAreRfc9457ProblemDetailsWithoutInternals() {
        assertProblem(get("/api/v1/aircraft"), 400, "BAD_REQUEST", "/api/v1/aircraft");
        assertProblem(get("/api/v1/aircraft?bbox=1,2,3"), 400, "BAD_BBOX", "/api/v1/aircraft");
        assertProblem(get("/api/v1/aircraft?bbox=-180,-90,180,90"), 422, "BBOX_TOO_LARGE", "/api/v1/aircraft");
        assertProblem(get("/api/v1/aircraft/search?q=%27;drop"), 400, "BAD_QUERY", "/api/v1/aircraft/search");
        assertProblem(get("/api/v1/aircraft/fedcba"), 404, "NOT_FOUND", "/api/v1/aircraft/fedcba");
        assertProblem(get("/api/v1/no-such-endpoint"), 404, "NOT_FOUND", "/api/v1/no-such-endpoint");
        assertProblem(get("/api/v1/alerts/history?from=2026-01-01T00:00:00Z&to=2025-01-01T00:00:00Z"), 400, "BAD_RANGE", "/api/v1/alerts/history");
        assertProblem(get("/api/v1/alerts/history?from=yesterday"), 400, "BAD_REQUEST", "/api/v1/alerts/history");
        Res post = send("POST", "/api/v1/aircraft?bbox=126,37,127,38", "{}", headers("Content-Type", "application/json"));
        assertProblem(post, 405, "METHOD_NOT_ALLOWED", "/api/v1/aircraft");
        assertThat(post.header("Allow")).contains("GET");
    }

    /**
     * R-84: 거절된 경로도 RFC 9457 — Spring 방화벽(//·;·/./ → 이전에는 Boot 기본 JSON)과 Tomcat 자체 거절(%2F → 이전에는 Tomcat HTML 페이지)
     * 모두 application/problem+json · code · request_id(= X-Request-Id). 거절은 그대로(우회 없음).
     */
    @Test
    void rejectedPathsAreProblemDetailsToo() {
        for (String p : List.of("/api/v1//ops/providers", "/api/v1/ops;x=1/providers", "/api/v1/./ops/providers", "/api/v1/ops%2Fproviders")) {
            Res r = get(p);
            JsonNode problem = assertProblem(r, 400, "BAD_REQUEST", p);
            assertThat(problem.path("title").asString()).isEqualTo("bad request");
            assertThat(r.body()).doesNotContain("<html").doesNotContain("Tomcat");
        }
    }

    /**
     * R-84: X-Content-Type-Options · X-Frame-Options · Referrer-Policy · Permissions-Policy 는 edge(security_headers.conf)가 모든 응답에 붙인다 —
     * api 도 붙이면 같은 헤더가 두 번 나가고, 한쪽만 바꾸면 값이 충돌한다. api 는 자기 응답에만 의미 있는 CSP 와 캐시 헤더만 둔다.
     */
    @Test
    void responsesCarrySecurityHeadersAndNoCorsGrant() {
        Res r = get("/api/v1/status", headers("Origin", "https://evil.example"));
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.header("Content-Security-Policy")).isEqualTo("default-src 'none'; frame-ancestors 'none'");
        Res opsDenied = get("/api/v1/ops/providers");
        for (Res x : List.of(r, opsDenied))
            for (String edgeOwned : List.of("X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy"))
                assertThat(x.headers(edgeOwned)).as("%s is added by the edge only", edgeOwned).isEmpty();
        assertThat(opsDenied.header("Content-Security-Policy")).isEqualTo("default-src 'none'; frame-ancestors 'none'");
        assertThat(r.header("Access-Control-Allow-Origin")).isNull();
        assertThat(r.header("X-Request-Id")).matches("^[0-9a-f]{20,}$");
        // 클라이언트가 보낸 요청 id 는 믿지 않는다
        assertThat(get("/api/v1/status", headers("X-Request-Id", "attacker-chosen")).header("X-Request-Id")).isNotEqualTo("attacker-chosen");
    }

    /**
     * R-49: edge(신뢰 프록시)가 붙인 X-Request-Id(nginx $request_id, 32 hex)는 그대로 쓴다 — edge 접근 로그·api 로그·오류 본문이 같은 id 로 이어진다.
     * 로그 줄에는 요청 중 MDC 의 id 가 [rid:…] 로 붙는다. 형식이 틀린 값(로그 주입 등)이나 신뢰하지 않는 원격의 값은 버리고 새로 만든다.
     */
    @Test
    @org.junit.jupiter.api.extension.ExtendWith(org.springframework.boot.test.system.OutputCaptureExtension.class)
    void requestIdFromTheTrustedEdgeIsUsedInProblemsAndLogs(org.springframework.boot.test.system.CapturedOutput output) throws Exception {
        String edgeId = "3f2b8c1d9e7a4b6c8d0e1f2a3b4c5d6e";
        var r = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/v1/aircraft?bbox=126,37,127,38")
                        .with(req -> { req.setRemoteAddr(TRUSTED_PROXY); return req; })
                        .header("X-Request-Id", edgeId).contentType("application/json").content("{}"))
                .andExpect(status().isMethodNotAllowed()).andReturn();
        assertThat(r.getResponse().getHeader("X-Request-Id")).isEqualTo(edgeId);
        assertThat(Streams.JSON.readTree(r.getResponse().getContentAsString()).path("request_id").asString()).isEqualTo(edgeId);
        assertThat(output.getOut()).contains("[rid:" + edgeId + "]");

        for (String bad : List.of("bad id\r\nforged log line", "x".repeat(65), "short"))
            assertThat(mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/v1/status")
                            .with(req -> { req.setRemoteAddr(TRUSTED_PROXY); return req; }).header("X-Request-Id", bad))
                    .andReturn().getResponse().getHeader("X-Request-Id")).as("malformed edge id %s", bad).matches("^[0-9a-f]{20,}$");
    }
}
