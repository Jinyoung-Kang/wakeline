# Wakeline: application security review

- **Date:** 2026-10-01
- **Commit reviewed:** `e0e1eba` on `main`, with a clean working tree
- **Method:** Read-only static review of all 953 tracked files. I read `apps/api`, `apps/web`, `apps/collector`, `infra/`, `tools/`, `.github/`, the migrations, schemas and docs.
- **Bytecode checks:** I inspected the pinned Spring Security 7.1.1 jars from the local Gradle cache with `javap`.
- **Local experiment:** I ran one offline Python test to check how `xml.etree` parses a UTF-16 DTD (see L-1).
- **Not done:**
  - I sent no requests to 8700/8701 and ran no docker commands against the stack.
  - I did not read `.env`. No scanners were run because gitleaks and Trivy are not installed locally.
  - I did not inspect the design PDF `docs/SkyWx_설계서_로컬개발용_v0.2.pdf` for embedded secrets.
- **Network use:** Limited to endoflife.date and vendor support/EOL pages. They are cited in §6.

**Threat model I used.** The stack is published only on `127.0.0.1:8700`; port 8701 is the isolated stack. The realistic attackers are:

1. Other web content in the operator's browser:
   - cross-site pages;
   - pages on *other localhost ports*;
   - DNS-rebinding pages.
2. Other local processes.
3. A malicious, compromised or MITM'd upstream provider. HTTPS plus the host allow-list makes this unlikely.
4. A compromised collector or ais container. These parse the most untrusted data, so I treated them as a trust boundary toward the api.

---

## 1. Findings summary

| ID | Severity | Title | Primary evidence |
|---|---|---|---|
| **M-1** | **Medium** | Ops CSRF protection can be bypassed from any *other localhost origin*. The token is accepted from the `_csrf` request parameter, the CSRF cookie is readable and tossable across ports, SameSite does not separate ports, and there is no Origin check. The same root cause sends the session cookie to other local servers (known R-97). | `SecurityConfig.java:52-55, 106-131`; `OpsController.java:69-79, 119-126`; Spring Security 7.1.1 `CsrfConfigurer$SpaCsrfTokenRequestHandler` |
| **M-2** | **Medium** (process) | The security automation is configured but never runs. There is no git remote, so GitHub Actions (npm audit, pip-audit, Trivy, CodeQL, gitleaks) and Dependabot never execute. The local gate covers only gitleaks and Trivy. | `git remote -v` is empty; `.github/workflows/ci.yml`; `.github/dependabot.yml`; `tools/security_gate.sh:2-6` |
| L-1 | Low | The PORT-MIS XML DTD refusal checks raw bytes, so a UTF-16 body bypasses it (verified locally). | `apps/collector/wakeline_collector/portcalls.py:82, 126-129, 320-324` |
| L-2 | Low | Unmasked exception and provider-response text is stored in `quality_event.detail` and shown raw on `/ops`. | `jobs/kma_radar.py:1306-1310, 1331`; `providers/kma_radar.py:82-83`; `db.py:187-197`; `OpsController.java:183`; `apps/web/app/ops/page.tsx:380` |
| L-3 | Low | Redis service passwords are passed on the `redis-server` argv, contrary to the project rule "passwords via env/stdin, never the command line". | `infra/redis/start.sh:89, 94-99` |
| L-4 | Low | The `--create-ops-user` CLI still accepts the password from an environment variable, contrary to contract §7 (stdin). | `apps/api/src/main/java/dev/wakeline/WakelineApplication.java:98-100` |
| L-5 | Low | Behind Docker NAT, per-IP limits apply to the whole host, and lockout is per account. Any local process can therefore lock `admin` or use up the login and WS slots (known R-96). | `OpsSessionController.java:66, 81-85`; `OpsUserService.java:19-20`; `infra/edge/nginx.conf:34-37` |
| L-6 | Low | The RainViewer tile `host`/`path` from the provider is trusted end to end. CSP is the only control. | `jobs/weather.py:305-311`; `apps/web/lib/maplayers.ts:190`; `apps/web/proxy.ts:15-16` |
| L-7 | Low | The HTTP response-size cap is checked only after each compressed chunk is decompressed. A single compressed chunk can reach about 64 MiB before the check. | `apps/collector/wakeline_collector/http.py:191-200`; httpx `_decoders.GZipDecoder.decode` |
| L-8 | Low | Supply-chain hygiene: `uv sync` runs without `--locked`, Gradle has no dependency verification or lockfile, and there is no root `.dockerignore` for the repo-root build context. | `apps/collector/Dockerfile:8-11`; `apps/api/build.gradle.kts`; `infra/compose.yml:27-29` |
| L-9 | Low | Version lag: Next.js 16.3.6 is behind 16.3.8 (released 2026-09-30), and ESLint 9 (dev) has been EOL since 2026-08-06. | `apps/web/package.json`; `package-lock.json` |
| I-1…I-11 | Info | Hardening notes (§2.3). | — |

**I found no critical or high findings.**

---

## 2. Findings in detail

### M-1 (Medium): Ops CSRF bypass from other localhost origins

**Status:** Confirmed by code and bytecode reading. It was not exercised at runtime because I was not allowed to call 8700/8701.

**Evidence**

`apps/api/src/main/java/dev/wakeline/config/SecurityConfig.java:52-54`. CSRF is enforced for `/api/v1/ops/**` with the SPA handler:
```java
.csrf(c -> c.spa().csrfTokenRepository(csrfRepository)
        .ignoringRequestMatchers(req -> !ApiPaths.OPS.matches(req) || "GET".equals(req.getMethod())
```

`SecurityConfig.java:108-112`. The token lives in a cookie that is not HttpOnly, on Path `/`. SameSite=Strict:
```java
CookieCsrfTokenRepository repo = CookieCsrfTokenRepository.withHttpOnlyFalse(); // 화면 스크립트가 읽어 헤더로 되돌려 보낸다
repo.setCookiePath("/");
repo.setCookieCustomizer(c -> c.sameSite("Strict").secure(secure));
```

`SecurityConfig.java:126-128`. The session cookie is HttpOnly, SameSite=Strict and Path `/api`. There is no Domain attribute, and Secure is off by default.

Spring Security **7.1.1** (`spring-security-config/-web-7.1.1.jar` in `~/.gradle`, checked with `javap`):
- `CsrfConfigurer$SpaCsrfTokenRequestHandler.resolveCsrfTokenValue` uses the *plain* handler only when the `X-CSRF-Token` header has text.
- Otherwise it delegates to `XorCsrfTokenRequestAttributeHandler`. That handler's resolution falls back to `request.getParameter("_csrf")`, so the token can come from the query string or the form body.
- `CsrfFilter` 7.1.1 has no Origin or Sec-Fetch-Site check.

There are state-changing ops endpoints that need **no JSON body**:
- `OpsController.java:119-120`:
  ```java
  @PostMapping("/providers/{name}/{action}")
  public Map<String, Object> toggleProvider(@PathVariable String name, @PathVariable String action, HttpServletRequest req, Authentication auth) {
  ```
- `OpsController.java:69`: `@PostMapping("/stats/aggregate")`, which takes `?day=`.

The API has no CORS configuration and no Origin check on REST. There are no `@CrossOrigin`, `.cors()` or `CorsConfigurationSource` references; only the WS handshake has an allow-list. `SecurityIT` has no test for a `_csrf` parameter or a foreign Origin. The earlier review (docs/review/VERIFICATION.md R-97) concluded that the CSRF defence "depends only on custom header + absence of CORS". That assumption is wrong because the parameter path exists.

**Reasoning and impact**

Three facts combine:
- Cookies are not isolated by port (RFC 6265 §8.5).
- SameSite is decided per *site*, which is scheme plus host; the port is ignored.
- So a page on `http://localhost:<any other port>` is same-site with the console. If the operator uses `127.0.0.1:8700`, the same holds for `127.0.0.1:<other port>`.

Such a page can:
1. Read `WAKELINE_CSRF` through `document.cookie`, or set its own value (cookie tossing with a more specific path such as `/api/v1/ops`; `CookieCsrfTokenRepository` takes the first matching cookie).
2. Build the XOR-masked form of the token: base64url(36 zero bytes ‖ token).
3. Send a *simple* request, either an HTML form POST or `fetch(…, {method:'POST', mode:'no-cors', credentials:'include'})`, to `http://localhost:8700/api/v1/ops/providers/adsb_fi/disable?_csrf=<masked>`.

There is no custom header, so there is no CORS preflight. The Strict session cookie (Path `/api`) is still sent because the request is same-site. The edge accepts `Host: localhost:8700`. CsrfFilter passes, ROLE_OPS is granted from the session, and the provider is disabled.

What an attacker can do this way:
- Turn off any of the 11 providers: all aircraft, weather, radar, AIS-adjacent and port-call collection.
- Trigger re-aggregation of past days.

The audit log records the action as the operator's own. JSON-body, PUT and DELETE endpoints (settings, resolutions, logout) still need a preflight and stay protected.

**Same root cause, known R-97 (deferred):** `WAKELINE_SESSION` (Path `/api`) is also sent to *any other local server's* `/api/*` routes. Many dev apps on `localhost:3000` call their own `/api`. Such a server receives a session ID that can be replayed for up to 8 hours. It is not bound to IP or user agent.

**Precondition:** Attacker-controlled script or HTML on another localhost origin (an XSS in another local app, a malicious dev server or package) while an ops session is active. The compose comments themselves mention SmartCollab on 8080/8081.

**How to confirm:** Use the isolated stack on 8701. Log in, serve a page on `http://localhost:9999` that issues the fetch above, and expect HTTP 200 plus a `PROVIDER_DISABLE` audit row.

**Fix** (in code, independent of the hostname decision):
1. Reject non-GET `/api/v1/ops/**` requests when `Origin` is not in `WAKELINE_ALLOWED_ORIGINS`, or when `Sec-Fetch-Site` is not `same-origin`. This is a filter beside `OpsSessionLifetimeFilter` that reuses `ApiPaths.OPS`.
2. Resolve the token from the header only: a custom `CsrfTokenRequestHandler` that never reads parameters. Every cross-origin call then needs a preflight.
3. Optionally keep the token server-side (`HttpSessionCsrfTokenRepository`, served by a same-origin GET) and rotate it at login (see I-4).
4. Separately, adopt a dedicated hostname such as `wakeline.localhost` (R-97).
5. Add SecurityIT cases for a `_csrf` parameter with a foreign Origin.

### M-2 (Medium, process): security automation configured but not executing

**Status:** Evidence-backed. Needs confirmation that no other clone pushes to a CI-enabled remote.

**Evidence**

- `git remote -v` prints nothing. The repo has 962 commits; HEAD is `e0e1eba` from 2026-10-01. The earlier review noted the same in `docs/review/review-v1-findings.json` ("`git remote -v` 출력이 비어 있다").
- `.github/workflows/ci.yml` defines these jobs, which only run on GitHub:
  - npm audit (l.103-104)
  - pip-audit (l.41-44)
  - Trivy for own and third-party images (l.161-177, 204-221)
  - CodeQL (l.223-237)
  - gitleaks (l.147-148)
- `.github/dependabot.yml` (weekly updates plus security updates) also needs GitHub.
- `tools/security_gate.sh:2-6`, the local `make security`, runs **only gitleaks and Trivy**.
- npm audit, pip-audit and semgrep exist only in the manual `perf/review_measure.sh`. Its last local results are in `perf/results/review-final/summary.tsv`, dated 2026-09-28:
  - npm audit: 0
  - pip-audit: 0
  - Trivy: api MEDIUM 36; collector HIGH 44 at that time

**Impact:** Vulnerability intake is entirely manual and episodic. For example, Next.js has shipped two patch releases since the pinned 16.3.6 (L-9), and no alert would reach the owner. The CI policy tests (`infra/tests/test_ci_policy.py`) check the *configuration*, not that it runs.

**Fix:** Either push to a GitHub remote and enable Actions, Dependabot alerts and security updates, or extend `make security` with:
- `npm audit --audit-level=high`
- `uvx pip-audit` (as in CI)
- `osv-scanner` or OWASP dependency-check for Gradle

Then schedule it weekly (launchd or cron).

### L-1 (Low): PORT-MIS DTD refusal is byte-level; UTF-16 bypasses it

**Evidence**

`portcalls.py:82`:
```python
_DTD_RE = re.compile(rb"<!(?:DOCTYPE|ENTITY)", re.IGNORECASE)
```

`portcalls.py:322-324`: `_refuse_dtd(body)` followed by `root = ET.fromstring(body)` on the raw response bytes, which come from `providers/portmis.py` via `parse_index_page(resp.body, …)`.

**Local verification** (offline; Python 3.13.13, expat 2.8.1): I took a `UTF-16` encoded `<!DOCTYPE … <!ENTITY a "AAAA"><!ENTITY b "&a;&a;&a;&a;">]>` document.
- `_DTD_RE.search(body)` returned `False`.
- `ET.fromstring` expanded `&b;` to 16 characters.
- An external `SYSTEM` entity produced `ParseError: undefined entity`. ElementTree does not fetch external entities.

`marine_grid.py:280-300` already fixed this pattern (strict UTF-8 decode, reject NUL, scan the decoded text) after the 2026-10-01 review. `portcalls.py` was not aligned.

**Impact:** Only internal-entity expansion is reachable, and expat ≥ 2.4 amplification limits bound it. There is no XXE or SSRF. It needs a malicious response from `apis.data.go.kr` over TLS.

**Fix:** Reuse the `marine_grid._collection` approach, or use `defusedxml.ElementTree.fromstring`.

### L-2 (Low): Unmasked provider and exception text in `quality_event.detail`

**Evidence**
- `jobs/kma_radar.py:1309`: `quality.append(("kma_radar_parse", None, {"tm": tm, "error": str(e)[:200]}))`. Line 1331 does the same for `kma_radar_missing`.
- `providers/kma_radar.py:82-83` raises `ValueError(f"not gzip: {resp.body[:80].decode('euc-kr', 'replace')!r}")`, so `str(e)` carries the first 80 bytes of the provider's response.
- `db.py:187-197` (`quality_rows`) stores `orjson.dumps(detail)` with no `mask()`, while `error_text` *is* masked at `db.py:397`.
- `OpsController.java:183` returns `detail::text`, and `apps/web/app/ops/page.tsx:380` renders it in the "detail (raw)" column.

**Impact:** This contradicts the rule in `masking.py:1` that all error text stored in DB or shown on ops screens passes through `mask()`. A key would leak (ops-only, and at rest in the DB) only if KMA answers HTTP 200 with a non-gzip body that echoes the `authKey` in its first 80 bytes. That has not been observed.

**Fix:** Apply `mask()` to string values in `quality_rows`, or at each `quality.append` with error text.

### L-3 (Low): Redis passwords on the `redis-server` command line

**Evidence**

`infra/redis/start.sh:94-96`:
```sh
exec redis-server "${REDIS_CONF:-/etc/redis/redis.conf}" \
  --requirepass "$REDIS_PASSWORD" \
  --user wakeline_api on ">$REDIS_API_PASSWORD" $API_KEYS $COMMON \
```
The collector and ais users are passed the same way (lines 89, 97-99).

**Reasoning:**
- README §3 states "비밀번호는 명령행이 아니라 환경변수·stdin 으로" (passwords via env/stdin, not the command line).
- The script itself relies on Redis' `set-proc-title` to overwrite argv after start. That leaves a short window at boot where the passwords are visible in `/proc/<pid>/cmdline` and `ps` inside the container's PID namespace and the Docker VM.
- `docker inspect` does not show them, because the entrypoint is `sh /etc/redis/start.sh`.
- `infra/tests/collector_redis_test.sh:19` uses the same pattern, but only with throwaway test values.

**Fix:** Write an ACL file at start (umask 077, on a tmpfs) and use `aclfile`, or use `ACL SETUSER` through `redis-cli` with `REDISCLI_AUTH` after start.

### L-4 (Low): ops-user CLI accepts the password from an environment variable

**Evidence**

`WakelineApplication.java:98-100`:
```java
} else {
    password = env.get("WAKELINE_OPS_PASSWORD");
}
```
The Makefile (l.47-51) uses `--password-stdin`, and its comment says "환경변수로 넘기지 않고 stdin 한 줄로 (계약 §7, SEC-13)" (not via env vars; one line on stdin, per contract §7). The legacy path still exists. A value passed with `docker exec -e WAKELINE_OPS_PASSWORD=…` appears in argv, and with `-e NAME` it appears in the process environment.

**Fix:** Remove the fallback, or make it fail unless `--password-stdin` is given.

### L-5 (Low, known R-96): per-host limits and account lockout allow local DoS

**Evidence**
- `OpsSessionController.java:66, 81-85`: 10 login attempts per minute per IP, failing closed.
- `OpsUserService.java:19-20`: 5 failures lock the account for 15 minutes.
- `nginx.conf:34-37` and the WS limit of 5 per IP are keyed on `$binary_remote_addr`.
- Edge logs show every host client as the Docker gateway (10.77.0.1, per R-96).

**Impact:** Any local process can keep `admin` locked, or occupy the 5 WS slots and the login budget. The original R-96 was deferred.

**Fix:** Lock per (account, IP) or use exponential delay; add a CLI unlock; raise per-IP WS limits for the single-host model.

### L-6 (Low): RainViewer host and path trusted end to end

**Evidence**
- `jobs/weather.py:305-311`: `host = str(res.data["host"])` and `path` are published unvalidated, and stored by `db.insert_radar_frames`.
- `RadarStore`, then `/api/v1/radar/frames` and the WS `radar` message, carry them to the browser.
- `apps/web/lib/maplayers.ts:190` builds `${host}${path}/512/{z}/{x}/{y}/…`.

**Mitigation in place:** CSP `img-src` and `connect-src` allow only `https://tilecache.rainviewer.com` (`proxy.ts:15-16`).

**Fix:** Allow-list the host server-side (exact `https://tilecache.rainviewer.com`) and validate `path` against `^/v2/radar/[0-9a-f]+$`.

### L-7 (Low): Size cap measured after per-chunk decompression

**Evidence**
- `http.py:195-198` sums the length of `resp.aiter_bytes()` chunks against `http_max_bytes` (20 MiB, `config.py:107`).
- httpx 0.28.1 `GZipDecoder.decode` calls `decompress(data)` without `max_length` (`.venv/.../httpx/_decoders.py:95-97`).
- httpcore reads 64 KiB per call (`http11.py:44`).

**Impact:**
- One compressed chunk can expand to about 64 MiB before `ResponseTooLarge`.
- With up to 8 pooled connections, a hostile allow-listed provider could push the collector (512 MiB limit) toward OOM, which causes a restart.
- KMA files are protected separately by `gz.gunzip_bounded` (64 MiB).
- AIS frames are capped at 1 MiB after decompression.

**Fix:** Send `Accept-Encoding: identity` for providers that do not need compression, or stream through a bounded `zlib.decompressobj` with a `max_length` of your own.

### L-8 (Low): Supply-chain hygiene

- `apps/collector/Dockerfile:8-11` copies `uv.lock*`, which is optional because of the glob, and runs `uv sync --no-dev` without `--locked` or `--frozen`. A missing or stale lock re-resolves silently inside the build. CI uses `--locked`; the image build does not.
- Gradle has no `gradle/verification-metadata.xml` and no lockfile. Versions are fixed by the BOMs, but artifacts are not checksum-verified. The wrapper itself is pinned (`distributionSha256Sum`).
- `infra/compose.yml:27-29` builds collector and ais with `context: ..` (the repo root), and there is no root `.dockerignore`. BuildKit only transfers the paths named in COPY, so `.env` and `backups/` are not sent today. A future `COPY . .` would include them.
- The build-stage `ghcr.io/astral-sh/uv:0.8` is an old minor version (build-time only).

### L-9 (Low): Version lag

- Next.js is pinned at `16.3.6`; the latest is **16.3.8 (2026-09-30)** per endoflife.date/nextjs. The vendor advisory list (github.com/vercel/next.js/security/advisories) shows several 2026 advisories. I did not map affected ranges, because that is outside the allowed EOL/support-page scope.
  - Exposure is reduced: `images.unoptimized: true`, and there is no `next/og` or `'use server'`. `proxy.ts` only sets CSP, so a middleware bypass would at worst drop CSP.
  - Run `npm audit` and update.
- ESLint `9.39.5` (dev-only): v9 maintenance ended **2026-08-06** (endoflife.date/eslint).

### 2.3 Informational and hardening notes

- **I-1** `StatusService.java:109` returns the whole collector hash `wakeline:active` publicly in `/api/v1/status` and the WS `status`. There is no field allow-list, unlike `radar_kr` (l.152-175). The values are masked today, but any future field written there becomes public automatically.
- **I-2** `RateLimitFilter.java:46-49` builds the 429 JSON with an unescaped `req.getRequestURI()`. This is not exploitable, because Tomcat rejects raw `"` and `\` in the request target. Use `ProblemJson.body`.
- **I-3** `RateLimitFilter` (`@Order(10)`) runs *after* the Spring Security chain (order −100). Anonymous probes of `/api/v1/ops/**` get 404 from Security and are not counted by the api limiter; the edge `limit_req` still applies.
- **I-4** The custom login (`OpsSessionController.java:99-112`) rotates the session ID but not the CSRF token, because `CsrfAuthenticationStrategy` is not invoked. This matters together with cookie tossing (M-1).
- **I-5** Only the Redis log sink masks api logs (`LogSink.java:162`, `LogMasker`). The console appender that feeds docker logs does not. The api holds no provider keys, and I found no password-bearing messages.
- **I-6** `infra/db/init/01-roles.sh:5-7` interpolates role passwords into single-quoted SQL literals passed via stdin. This is safe for the `token_urlsafe(24)` values from `make init`; a hand-edited value containing `'` would break or inject.
- **I-7** The `db` container keeps all three service-role passwords in its environment after init (`compose.yml:300-303`). This is the known partial R-80.
- **I-8** `Makefile:159` `print-%` echoes any make or environment variable. It could print secrets that are exported in the shell or in CI.
- **I-9** `tools/db-restore.sh` runs `pg_restore` as superuser. Only restore dumps you trust. Backups are 0600 in a 0700, gitignored directory and contain the ops password hashes and audit IPs.
- **I-10** Anonymous local processes can write arbitrary text into the `/logs` viewer through `POST /api/v1/client-errors`. The input is bounded (8 KiB; 10 per minute per IP and 120 per minute globally), masked, kept in a separate stream (`MAXLEN ~1000`) and flagged `untrusted`.
- **I-11** Anonymous WS clients can spend the adsb.fi and adsbdb daily budgets through demand leases and route lookups. This is bounded by design (ADR-013/016).

---

## 3. Endpoint and authorization inventory

`SecurityConfig.java:47-50`:
- `POST /api/v1/ops/session` is `permitAll`.
- Everything else under `/api/v1/ops/**` requires `hasRole("OPS")`; anonymous requests get **404**.
- All other paths are `permitAll`.
- Path decisions use the decoded `PathPattern` (`ApiPaths`), so `%6Fps` cannot bypass them.
- CSRF applies to non-GET `/api/v1/ops/**`. Login is exempt unless a session cookie is present.

**Public, no session, no CSRF.** All of these sit behind the edge limit (10 r/s, burst 30) and the api Redis limit (120 per minute per IP, fail-open):

| Method & path | Notes |
|---|---|
| GET `/healthz` | edge `location = /healthz`; no `limit_req`; minimal data |
| GET `/api/v1/aircraft?bbox&detail`, `/aircraft/search?q` (2-10 chars `[A-Z0-9-]`), `/aircraft/{hex}`, `/aircraft/{hex}/track` (≤ 24 h, ≤ 5,000 points) | hex `^[0-9a-f]{6}$` |
| GET `/api/v1/replay?at&bbox` (≤ 31 d, bbox ≤ 2,500 sq°), `/stats/sigmet`, `/stats/traffic`, `/stats/alerts` (≤ 92 d), `/status` | |
| GET `/api/v1/ships?bbox`, `/ships/search?q&limit`, `/ships/{mmsi}`, `/ships/{mmsi}/track` (≤ 24 h), `/ais/gaps`, `/ships/coverage`, `/traffic/grid` | `ShipQuery` ≤ 40 chars, limit bounded |
| GET `/api/v1/sigmets`, `/sigmets/{id}`, `/alerts`, `/alerts/history` (≤ 30 d, limit ≤ 200), `/radar/frames`, `/radar/kr`, `/radar/kr/{tm}.png` (`^\d{12}$`), `/airports`, `/airports/{icao}/wx` (`^[A-Z0-9]{4}$`) | |
| GET `/api/v1/openapi` | springdoc; ops paths excluded; Swagger UI disabled |
| **POST** `/api/v1/client-errors` | Only public write endpoint. JSON only (`consumes`, otherwise 415). 8 KiB. 10 per minute per IP plus 120 per minute globally, fail-closed (503). Masked; separate stream |
| **WS** `/ws/v1` | Public. Origin allow-list (`OriginAllowList`, 403 otherwise). 4 KB per message. 20 messages per 10 s. `hello` within 5 s. 5 per IP and 200 in total; edge 5 r/s and 10 connections per IP. No ops or log data in the server message types (`schemas/ws/server.v1.json`) |

**Ops: session cookie `WAKELINE_SESSION` plus ROLE_OPS; non-GET requires CSRF; anonymous gets 404**

| Method & path | Notes |
|---|---|
| POST `/api/v1/ops/session` | Login. 10 per minute per IP (fail-closed), lockout 5 per 15 min, BCrypt(12) with a dummy-hash timing guard, `changeSessionId()`, audit row written *before* the session |
| GET / DELETE `/api/v1/ops/session` | Who am I / logout (logout invalidates even if the audit write fails) |
| POST `/api/v1/ops/stats/aggregate?day` | **No body: reachable by M-1** |
| GET `/api/v1/ops/providers`; **POST `/api/v1/ops/providers/{name}/{action}`** | Name allow-list; **no body: reachable by M-1** |
| GET `/api/v1/ops/runs`, `/quality`, `/dlq`, `/settings`, `/audit`, `/pipeline` | Read-only |
| PUT `/api/v1/ops/settings/{key}` | Key allow-list, per-key validation, `If-Match` required, change and audit in one transaction |
| GET `/api/v1/ops/logs`, `/logs/groups`, `/logs/{id}` | Service, level, fingerprint and request-id filters validated |
| POST (JSON) / GET / DELETE `/api/v1/ops/resolutions[/{id}]` | |

**Management (no auth; internal network only; edge returns 404 for `/actuator`):** port 9000 serves `/actuator/health` (with liveness, readiness and ingest groups), `/actuator/prometheus` and `/actuator/info`. `show-details: never`. Any container on the `wakeline` network (web, collector, ais, edge) can read the metrics.

**Web (Next.js):** `/`, `/replay`, `/stats`, `/ops`, `/logs`, `/about`, `/guide`, `/airports/[icao]` and `/health` are public shells. Data is fetched client-side with `credentials: "same-origin"`. There are no server-side fetches, Server Actions, `next/og` or image optimization.

---

## 4. Checked and found safe (coverage)

**SQL injection**
- Every `JdbcClient` call uses named parameters, across 22 files and every `db.sql(...)` call.
- Dynamic SQL (`IngestRunRepository`, `ShipRepository.search`, `AlertRepository.history`, the `MaintenanceJobs` partition calls, `JdbcCoverageSource`, `ProviderSwitchService`) concatenates only constant fragments. `ORDER BY` and `LIMIT` take constants or bound parameters.
- Collector asyncpg uses static SQL with positional parameters; there are no f-string SQL statements.
- PL/pgSQL `format('%I','%L')`.
- `SECURITY DEFINER` functions use `SET search_path = public, pg_temp`. `CREATE` on `public` is revoked from the service roles, and default privileges were removed in V9.
- `audit_log` is INSERT/SELECT only for the api role.
- `tools/db_rotate_passwords.py` sends only SCRAM verifiers through psql stdin.

**Redis**
- The Lua scripts (`RateLimiter`, `SingleInstanceGuard`, `RedisDemandLeases`, collector `budget.RESERVE_LUA`) are static, and all variable data goes in KEYS and ARGV.
- Keys are built from validated values (hex, tm `\d{12}`, cell regex).
- ACL users follow least privilege: producers get allow-listed commands, `%W~wakeline:logs`, no SCAN, no CLIENT TRACKING. `rename-command` disables CONFIG, FLUSH*, DEBUG and SHUTDOWN.

**Command injection:** There is none in runtime code. The tools use argv arrays (`spawn`, `spawnSync`, `subprocess.run([...])`); there is no `shell=True`, `eval` or `ProcessBuilder`.

**Unsafe deserialization**
- Spring Session JDK deserialization uses an `ObjectInputFilter` allow-list with depth, reference, byte and array caps (`SessionSerializationConfig`).
- There is no Jackson default typing, `XMLDecoder`, `pickle` or `yaml.load`.

**XXE:** Only ElementTree is used; it does not resolve external entities. `marine_grid` uses a strict UTF-8 decode plus a DOCTYPE/ENTITY scan and a size cap. The `portcalls` gap is L-1.

**Path traversal**
- Raw-archive paths use code constants plus timestamps (`raw_store.py:37-44`).
- The guide and README export scripts validate names (`FILE_RE`, `hashedName`) and refuse non-local base URLs or URLs carrying `user:pw@`.

**SSRF (collector)**
- The host allow-list (`http.py:30-42`) requires HTTPS and does not follow redirects.
- URL parts are validated: callsign `^[A-Z0-9]{3,8}$`, hex `^[0-9a-f]{6}$`, grid id regex, integer bbox side ≤ 64 km, tm `\d{12}`, fixed base-URL patterns.
- The AIS URL must be `wss://`.

**SSRF (browser):** CSP restricts tile and connect origins; see L-6.

**XSS / HTML injection (web)**
- There is no `dangerouslySetInnerHTML`, `innerHTML` or `setHTML`.
- MapLibre popups use `setDOMContent(renderTip())`, which uses `textContent` (`lib/tooltip.ts:187-217`).
- The attribution HTML is built from constants with escaping.
- `href` values come only from constants or `encodeURIComponent`.
- CSP has a per-request nonce, `strict-dynamic`, `object-src 'none'`, `frame-ancestors 'none'` and `base-uri 'self'`.
- Raw METAR, TAF and log text renders as React text.

**Open redirects:** None. There are no redirect endpoints, and Next.js `rewrites` apply only in dev.

**Header and log injection**
- `X-Request-Id` is regenerated unless it comes from the edge and matches `[0-9A-Za-z-]{8,64}`; the edge overwrites XFF and `X-Request-Id`.
- Tomcat rejects raw CR/LF and quotes in the request target.
- `ProblemJson.str` escapes control characters.
- The log sink is structured JSON.

**Authentication and sessions**
- 8 h absolute lifetime (`OpsSessionLifetimeFilter`).
- A credential tag binds the session to the password hash, so sessions end after a password change; the filter returns 503 if it cannot check.
- Sessions are revoked on password change (`OpsSessionRegistry`).
- `UserDetailsServiceAutoConfiguration` is excluded, so no default `user` password is generated.
- There is no `formLogin`, `httpBasic` or `HiddenHttpMethodFilter`.
- The firewall rejects `;`, `//`, `/./` and `%2F` (400 problem+json).

**DNS rebinding:** The edge `server_name` allow-list returns 421 for other hosts; the WS checks an explicit Origin list; there is no CORS anywhere.

**Error responses**
- RFC 9457 bodies without stack traces or exception messages (`ProblemAdvice`, `ProblemErrorReportValve`).
- `include-message` and `include-stacktrace` are `never`.
- `server_tokens off`; `poweredByHeader: false`.

**Request and response size limits**
- Edge `client_max_body_size 1m`; headers 16 KB; form posts 64 KB.
- WS: 4 KB text, binary frames refused.
- Client errors: 8 KiB, read with `readNBytes`.
- Collector responses: 20 MiB (see L-7).
- Decompression: KMA gzip ≤ 64 MiB (`gz.gunzip_bounded`; `read_header` decompresses only 1,024 bytes); api stream payload gunzip ≤ 32 MiB (`StreamConsumer.java:829-836`); AIS ≤ 1 MiB after permessage-deflate (`max_size`).
- Pillow is only used to *encode* PNGs (`Image.fromarray`), never to decode untrusted images. The numpy `frombuffer` call sits behind header and size checks (`kma_grid.py:121-133`).

**Secrets**
- I ran manual regex scans over all tracked files (AWS, GitHub, Slack, Google, PEM, JWT and `key=value` shapes). No real secret was found:
  - JWT-shaped strings decode to the synthetic `{"sub":"1234567890"}`.
  - The `.gitleaksignore` entries are `test…` placeholders.
  - Documentation masks keys as `**`.
  - `.env.example` has empty secret values.
- `.env` is 0600 and written atomically by `init_env.py`.
- Keys are injected only into the containers that use them, and the isolated stacks blank them.
- `NEXT_PUBLIC_*` variables are banned at build time.
- ops-user reads the password from stdin; DB rotation sends verifiers on stdin; guide captures read credentials from a 0600 file.
- Scanner containers run with `--network none` and without `docker.sock`.

**Key-bearing URL → log path analysis (collector)**
- The `httpx` and `httpcore` loggers are set to WARNING (`main.py:62-63`), so request-line INFO logs with full URLs never appear.
- The `websockets` logger is set to WARNING (`ais/client.py`), so subscription frames with `APIKey` are never logged.
- `MaskFilter` is installed on all root handlers, both stdout and the Redis sink (`main.py:85-88`, `ais/main.py:77-78`). It masks messages, arguments and tracebacks by shape (serviceKey=, authKey=, api_key=, `?key=`, Bearer, `Authorization:`, `client_secret=`, JSON `"authKey":`, URL userinfo, JWT). It also substitutes the actual KMA key, OpenSky secret, Redis and DB passwords, and four encodings of the data.go.kr key. The aisstream key is registered in the ais process.
- `describe_error()` masks every status-hash and `ingest_run` error text; `errors.py` adds only the host, never the URL.
- `/logs` reads only `wakeline:logs` and `wakeline:logs:client`. Entries are masked when produced and masked again on read (`LogReader.java:480`).
- Residual paths: L-2 (`quality_event`), I-5 (api console), and interpreter-level tracebacks printed outside `logging` (none observed carrying keys).

**Containers and network**
- All containers run non-root with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, and memory and PID limits.
- Images are pinned by digest.
- Only collector and ais can reach the internet. web, api, db and redis sit on an `internal: true` network.
- The DB superuser is limited to the local socket.
- Backups are 0600 in a 0700, gitignored directory.

**CI configuration as written:** Actions are SHA-pinned, `persist-credentials: false` is set, default permissions are `contents: read`, and there is no `pull_request_target`. It does not run; see M-2.

---

## 5. Pinned versions and support status (as of 2026-10-01)

| Component | Pinned (where) | Support status (source, page date as shown) | Flag |
|---|---|---|---|
| Eclipse Temurin JDK/JRE **25** | `apps/api/Dockerfile:4, 12` (digest); CI `setup-java 25` | 25 LTS supported until **2031-09-30**; latest 25.0.4.1+1 — https://endoflife.date/eclipse-temurin (updated 2026-09-30) | OK |
| Spring Boot **4.1.1** | `apps/api/build.gradle.kts:4` | 4.1 OSS until **2027-07-31**; latest 4.1.1 — https://endoflife.date/spring-boot (updated 2026-08-21) | OK |
| Spring Framework **7.0.9** (Boot BOM; Gradle cache) | — | 7.0 OSS until **2027-07-31**; latest 7.0.9 — https://endoflife.date/spring-framework (updated 2026-09-24) | OK |
| Spring Security **7.1.1** | — | 7.1 OSS until **2027-07-31**; latest 7.1.1 — https://endoflife.date/spring-security (page date not shown) | OK |
| Spring Session Data Redis 4.1.1 | — | follows Boot 4.1 | OK |
| Apache Tomcat **11.0.26** (forced constraint) | `build.gradle.kts:19-34` | 11.0 actively supported; latest 11.0.26 (2026-09-09) — https://endoflife.date/tomcat (page date not shown) | OK |
| Jackson 3.1.7 / 2.22.3 (CVE bump); springdoc 3.1.1; networknt json-schema-validator 1.5.8; JTS 1.20.0; pgjdbc 42.7.13; Flyway 12.4.0; Lettuce 7.5.2; HikariCP 7.0.2; Logback 1.5.38 | `build.gradle.kts`; Gradle cache | not tracked on endoflife.date — not assessed | — |
| Gradle **9.7.1** (wrapper sha256-pinned) | `gradle-wrapper.properties` | Gradle 9 active; latest 9.8.0 — https://endoflife.date/gradle (updated 2026-09-26) | OK |
| Node.js **24** (`node:24-alpine` digest; docs: 24.21.0) | `apps/web/Dockerfile:4, 9, 16`; CI node 24 | Active LTS ends **2026-10-20**, security until **2028-04-30** — https://endoflife.date/nodejs (updated 2026-09-24) | Info: enters maintenance in 19 days |
| Next.js **16.3.6** (exact) | `apps/web/package.json`, lock | 16 is supported; latest **16.3.8 (2026-09-30)**; Next 15 security ends 2026-10-21 — https://endoflife.date/nextjs (updated 2026-10-01) | **Low (L-9)**: two patches behind |
| React / react-dom **19.3.0** | `package.json` | 19 active; latest 19.3.0 — https://endoflife.date/react (updated 2026-09-24) | OK |
| maplibre-gl 6.11.2; zustand 5.0.15; sharp 0.35.4 (via next) | lock | not assessed | — |
| ESLint **9.39.5** (dev) | lock | v9 maintenance ended **2026-08-06** — https://endoflife.date/eslint (updated 2026-09-23) | **Low (L-9)**: EOL (dev only) |
| Playwright 1.63.0, Vitest 5.0.2, Vite 8.3.1, TypeScript 5.9.3, Tailwind 4.3.3 (dev) | lock | not assessed | — |
| Python **3.13** (`python:3.13-slim` digest, Debian 13) | `apps/collector/Dockerfile:4, 13`; `requires-python >=3.13` | Bugfix support ended **2026-10-01 (today)**; security until **2029-10-31**; latest 3.13.16 — https://endoflife.date/python (updated 2026-10-01) | Info: security-only from now; plan 3.14 |
| numpy 2.5.3 | `uv.lock` | 2.5 supported until 2028-06-22 — https://endoflife.date/numpy (updated 2026-09-07) | OK |
| httpx 0.28.1, redis-py 8.1.0, asyncpg 0.31.0, pydantic 2.13.5, pillow 12.3.0, pyproj 3.8.0, shapely 2.1.2, orjson 3.12.0, websockets 17.1 (`==`), jsonschema 4.26.0 | `uv.lock` | not on endoflife.date (pillow page 404) — not assessed | — |
| uv **0.8** (build stage) | `apps/collector/Dockerfile:5` | not tracked; old minor, build-only | Info |
| PostgreSQL **18** (`postgres:18-trixie` digest; docs: 18.6) | `infra/db/Dockerfile:6` | 18 supported until **2030-11-14**; latest 18.6 — https://endoflife.date/postgresql (updated 2026-08-13) | OK |
| PostGIS **3.6.x** (docs: 3.6.4) | `infra/db/Dockerfile:14` | Policy: each minor supported for 2–4 years after release — https://postgis.net/eol_policy/ (no date shown) | OK |
| Debian **13** (trixie) base (db, python) | — | Security until **2028-08-09**, LTS until 2030-06-30 — https://endoflife.date/debian | OK |
| Redis **8** (`redis:8-alpine` digest; ADR-011 records 8.10.2) | `infra/compose.yml:258` | 8.10 is the latest stable and supported; 8.10.2 is the latest — https://endoflife.date/redis (updated 2026-09-18) | OK. Confirm the digest is 8.10.x; if it were 8.0, security support ends 2026-12-01 |
| nginx **1.30** (`nginxinc/nginx-unprivileged:1.30-alpine` digest; docs: 1.30.5) | `infra/compose.yml:34` | 1.30 stable supported; latest 1.30.5; stable branches retire each April — https://endoflife.date/nginx (updated 2026-09-16) | Info: move to 1.32 around April 2027 (~6.5 months) |
| Alpine 3.23 / 3.24 (node, nginx, redis bases) | — | 3.23 until 2027-11-01, 3.24 until 2028-06-01 — https://endoflife.date/alpine-linux (updated 2026-09-18) | OK |
| k6 2.3.0 (bench); Trivy 0.74.0, gitleaks 8.30.1, semgrep 1.177.0 (scanners) | `Makefile:9`; `tools/scan_lib.sh:13-15` | not assessed (tools, not deployed) | — |

## 6. Dependency-audit coverage and gaps

**Coverage as configured** in `.github/workflows/ci.yml`:

| Tool | Scope |
|---|---|
| `npm audit --audit-level=high` | web, all dependencies including dev |
| `pip-audit` 2.10.1 | collector *runtime* dependencies, hash-pinned export from `uv.lock` |
| Trivy (HIGH/CRITICAL, `ignore-unfixed`) | own images api, collector, web and db; the api image scan covers the Java JARs in the fat jar. Third-party edge and redis are blocking; k6 is report-only |
| CodeQL | default suite for java-kotlin, javascript-typescript and python |
| gitleaks | full history |
| Dependabot | npm, uv, gradle, docker, docker-compose and github-actions, with a 7-day cooldown |

**Gaps**
1. Nothing in that table runs, because there is no remote (M-2). Dependabot alerts and security updates are unavailable.
2. There is no dedicated Gradle/Java dependency audit (OWASP dependency-check or osv-scanner on the Gradle graph):
   - Java libraries are seen only through the Trivy image scan, which reports only fixable HIGH and CRITICAL.
   - Build-time Gradle plugins (Boot plugin, foojay resolver) and test dependencies (Testcontainers) are never scanned.
   - There is no Gradle dependency verification.
3. pip-audit skips dev dependencies; npm audit fails only at high and above.
4. Trivy `ignore-unfixed` with HIGH/CRITICAL only means MEDIUM findings (36 in the api image on 2026-09-28) are not tracked.
5. There is no Dockerfile or compose misconfiguration scanner (Trivy config, hadolint); the custom policy tests cover part of this.
6. There is no GitHub Actions linter (zizmor, actionlint).
7. CodeQL is not running the `security-extended` suite.
8. The local `make security` gate covers gitleaks and Trivy only. npm audit, pip-audit and semgrep exist only in the manual `perf/review_measure.sh`, last run 2026-09-28.

## 7. Limitations

- No dynamic testing. M-1 and L-7 are derived from code and bytecode and should be reproduced on the 8701 fixture stack.
- I did not map CVE advisories to exact versions beyond the vendor EOL and support pages (scope restriction). Run `npm audit`, `pip-audit` and a Trivy/OSV scan now.
- I did not check the Redis, Python and Temurin patch versions inside the pinned digests. The Redis, PostgreSQL and nginx versions above come from the project docs.
