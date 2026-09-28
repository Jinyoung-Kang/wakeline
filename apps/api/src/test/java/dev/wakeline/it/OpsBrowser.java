package dev.wakeline.it;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** 운영자 브라우저 흉내(쿠키 저장 · CSRF 이중 제출) — 운영 API 통합 테스트용. 로그인은 {@link #login}. */
final class OpsBrowser {
    private final IntegrationTest test;
    final Map<String, String> cookies = new LinkedHashMap<>();

    OpsBrowser(IntegrationTest test) { this.test = test; }

    IntegrationTest.Res send(String method, String path, String body, Map<String, String> extra) {
        Map<String, String> h = new LinkedHashMap<>(extra);
        if (!cookies.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            cookies.forEach((k, v) -> sb.append(sb.isEmpty() ? "" : "; ").append(k).append('=').append(v));
            h.put("Cookie", sb.toString());
        }
        if (body != null) h.putIfAbsent("Content-Type", "application/json");
        IntegrationTest.Res r = test.send(method, path, body, h);
        for (String sc : r.headers("Set-Cookie")) {
            String nv = sc.split(";", 2)[0];
            int eq = nv.indexOf('=');
            String name = nv.substring(0, eq).trim(), value = nv.substring(eq + 1).trim();
            if (sc.toLowerCase(Locale.ROOT).contains("max-age=0") || value.isEmpty()) cookies.remove(name); else cookies.put(name, value);
        }
        return r;
    }

    IntegrationTest.Res get(String path) { return send("GET", path, null, Map.of()); }

    /** CSRF 헤더(쿠키 값을 되돌려 보냄)를 단 변경 요청. */
    IntegrationTest.Res post(String path) { return send("POST", path, null, Map.of("X-CSRF-Token", String.valueOf(cookies.get("WAKELINE_CSRF")))); }

    static OpsBrowser login(IntegrationTest test, dev.wakeline.ops.OpsUserService users, String user, String password) {
        users.upsert(user, password);
        OpsBrowser b = new OpsBrowser(test);
        assertThat(b.send("POST", "/api/v1/ops/session", "{\"username\":\"" + user + "\",\"password\":\"" + password + "\"}", Map.of()).status())
                .isEqualTo(200);
        return b;
    }
}
