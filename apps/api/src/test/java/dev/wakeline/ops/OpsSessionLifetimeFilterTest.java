package dev.wakeline.ops;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import dev.wakeline.logs.LogEvents;
import dev.wakeline.platform.support.LogMasker;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.platform.web.RequestIdFilter;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.jdbc.BadSqlGrammarException;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;

import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** R-54 절대 수명 필터: 로그인 시각(없으면 세션 생성 시각) 기준, /api/v1/ops/** 에만, 경계값 포함. 실제 Redis 세션 경로는 SecurityIT. */
class OpsSessionLifetimeFilterTest {
    static final Instant NOW = Instant.parse("2026-09-28T12:00:00Z");
    static final OpsSessionLifetimeFilter FILTER = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC));

    static MockHttpServletRequest request(String uri, MockHttpSession session) {
        MockHttpServletRequest r = new MockHttpServletRequest("GET", uri);
        r.setRequestURI(uri);
        if (session != null) r.setSession(session);
        return r;
    }

    static MockHttpSession sessionLoggedInAgo(Duration ago) {
        MockHttpSession s = new MockHttpSession();
        s.setAttribute(OpsSessionLifetimeFilter.AUTH_AT, NOW.minus(ago).toEpochMilli());
        return s;
    }

    /** DB 장애 중 JdbcClient 가 던지는 것 — 풀 대기 초과(Hikari)를 Spring 이 감싼 예외. */
    static CannotGetJdbcConnectionException poolTimeout() {
        return new CannotGetJdbcConnectionException("Failed to obtain JDBC Connection",
                new SQLTransientConnectionException("HikariPool-1 - Connection is not available, request timed out after 3000ms."));
    }

    /** 5분 전에 로그인한 운영자 uid 의 세션(id 를 정해 로그에 실리지 않는지 볼 수 있게). tag 가 null 이면 자격 표식이 없다. */
    static MockHttpSession loggedIn(String sessionId, int uid, String tag) {
        MockHttpSession s = new MockHttpSession(null, sessionId);
        s.setAttribute(OpsSessionLifetimeFilter.AUTH_AT, NOW.minus(Duration.ofMinutes(5)).toEpochMilli());
        s.setAttribute(OpsSessionLifetimeFilter.USER_ID, uid);
        if (tag != null) s.setAttribute(OpsSessionLifetimeFilter.CREDENTIAL, tag);
        return s;
    }

    static MockHttpServletRequest request(String uri, MockHttpSession session, String requestId) {
        MockHttpServletRequest r = request(uri, session);
        r.setAttribute(RequestIdFilter.ATTR, requestId);
        return r;
    }

    static List<String> lines(CapturedOutput out, String... parts) {
        return out.getAll().lines().filter(l -> java.util.Arrays.stream(parts).allMatch(l::contains)).toList();
    }

    @Test
    void sessionOlderThanMaxAgeIsInvalidatedAndTheRequestContinuesAnonymously() throws Exception {
        MockHttpSession s = sessionLoggedInAgo(Duration.ofHours(8));
        MockFilterChain chain = new MockFilterChain();
        FILTER.doFilter(request("/api/v1/ops/providers", s), new MockHttpServletResponse(), chain);
        assertThat(s.isInvalid()).isTrue();
        assertThat(chain.getRequest()).as("the chain still runs (security answers 404)").isNotNull();
    }

    @Test
    void youngerSessionIsKept() throws Exception {
        MockHttpSession s = sessionLoggedInAgo(Duration.ofHours(8).minusMillis(1));
        FILTER.doFilter(request("/api/v1/ops/providers", s), new MockHttpServletResponse(), new MockFilterChain());
        assertThat(s.isInvalid()).isFalse();
    }

    @Test
    void withoutLoginTimeTheCreationTimeCounts() {
        MockHttpSession s = new MockHttpSession(); // 생성 시각 = 지금(실제 시계) — 고정 시계보다 한참 뒤
        assertThat(FILTER.expired(s, s.getCreationTime() + Duration.ofHours(8).toMillis())).isTrue();
        assertThat(FILTER.expired(s, s.getCreationTime() + Duration.ofHours(7).toMillis())).isFalse();
        s.setAttribute(OpsSessionLifetimeFilter.AUTH_AT, "not-a-long"); // 형식이 다르면 생성 시각
        assertThat(FILTER.expired(s, s.getCreationTime() + Duration.ofHours(8).toMillis())).isTrue();
    }

    @Test
    void onlyOpsPathsAreChecked() throws Exception {
        MockHttpSession s = sessionLoggedInAgo(Duration.ofDays(3));
        FILTER.doFilter(request("/api/v1/status", s), new MockHttpServletResponse(), new MockFilterChain());
        assertThat(s.isInvalid()).isFalse();
        // 세션 없는 요청(로그인 전)은 그대로 지나간다
        MockFilterChain chain = new MockFilterChain();
        FILTER.doFilter(request("/api/v1/ops/session", null), new MockHttpServletResponse(), chain);
        assertThat(chain.getRequest()).isNotNull();
    }

    /**
     * 보안 규칙(/api/v1/ops/**)은 디코딩한 경로로 맞추므로 %6Fps(= ops) 는 운영 경로로 인가된다. 이 필터가 원문 URI 앞부분만 보면 같은 요청에서
     * 수명 검사를 건너뛴다(R-54 후속) — 인가와 같은 규칙으로 판단해야 한다.
     */
    @Test
    void percentEncodedOpsPathIsCheckedLikeTheAuthorizationRule() throws Exception {
        for (String uri : new String[] {"/api/v1/%6Fps/providers", "/api/v1/o%70s/settings", "/api/v%31/ops/audit"}) {
            MockHttpSession s = sessionLoggedInAgo(Duration.ofHours(9));
            FILTER.doFilter(request(uri, s), new MockHttpServletResponse(), new MockFilterChain());
            assertThat(s.isInvalid()).as(uri).isTrue();
        }
    }

    /** R-95 후속: 자격 표식이 지금 값과 다르거나 없거나 사용자가 없으면 끝낸다. DB 를 읽지 못하면 세션은 두고 503. */
    @Test
    void sessionIsBoundToTheCredentialItWasCreatedWith() throws Exception {
        java.util.Map<Integer, String> current = new java.util.HashMap<>(java.util.Map.of(7, "tag-new"));
        OpsSessionLifetimeFilter f = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC),
                uid -> java.util.Optional.ofNullable(current.get(uid)));
        java.util.function.BiFunction<Integer, String, MockHttpSession> session = (uid, tag) -> {
            MockHttpSession s = sessionLoggedInAgo(Duration.ofMinutes(5));
            s.setAttribute(OpsSessionLifetimeFilter.USER_ID, uid);
            if (tag != null) s.setAttribute(OpsSessionLifetimeFilter.CREDENTIAL, tag);
            return s;
        };
        MockHttpSession same = session.apply(7, "tag-new"), changed = session.apply(7, "tag-old"), none = session.apply(7, null), gone = session.apply(8, "tag-x");
        for (MockHttpSession s : new MockHttpSession[] {same, changed, none, gone})
            f.doFilter(request("/api/v1/ops/providers", s), new MockHttpServletResponse(), new MockFilterChain());
        assertThat(same.isInvalid()).isFalse();
        assertThat(changed.isInvalid()).as("password changed").isTrue();
        assertThat(none.isInvalid()).as("session without a credential tag").isTrue();
        assertThat(gone.isInvalid()).as("user deleted").isTrue();

        OpsSessionLifetimeFilter down = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC),
                uid -> { throw poolTimeout(); });
        MockHttpSession kept = session.apply(7, "tag-new");
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        down.doFilter(request("/api/v1/ops/providers", kept), res, chain);
        assertThat(res.getStatus()).isEqualTo(503);
        assertThat(res.getHeader("Retry-After")).as("QA-101: contract §2 default").isEqualTo("10");
        MockHttpServletResponse list = new MockHttpServletResponse();
        down.doFilter(request("/api/v1/ops/resolutions", kept), list, new MockFilterChain());
        assertThat(list.getHeader("Retry-After")).as("QA-101: §G14 — the resolution read interval").isEqualTo("30");
        MockHttpServletRequest revoke = request("/api/v1/ops/resolutions/12", kept);
        revoke.setMethod("DELETE");
        MockHttpServletResponse write = new MockHttpServletResponse();
        down.doFilter(revoke, write, new MockFilterChain());
        assertThat(write.getHeader("Retry-After")).isEqualTo("10");
        assertThat(chain.getRequest()).as("not passed on unverified").isNull();
        assertThat(kept.isInvalid()).as("unknown is not a logout").isFalse();
    }

    /**
     * 리뷰 cto-2026-10 S3(B4): 로그아웃은 권한을 줄이는 요청이다 — 자격 확인(DB)을 하지 않는다. 예전에는 DB 장애 중 로그아웃이 503 으로 막혀 세션이 계속
     * 유효했다(OpsSessionController: 로그아웃은 실패하지 않게). 절대 수명은 그대로 본다(지난 세션은 끝내고 익명으로 — 컨트롤러가 204).
     */
    @Test
    void logoutReachesTheControllerWhenTheCredentialLookupFails() throws Exception {
        OpsSessionLifetimeFilter down = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC),
                uid -> { throw poolTimeout(); });
        MockHttpSession s = sessionLoggedInAgo(Duration.ofMinutes(5));
        s.setAttribute(OpsSessionLifetimeFilter.USER_ID, 7);
        s.setAttribute(OpsSessionLifetimeFilter.CREDENTIAL, "tag");
        MockHttpServletRequest logout = request("/api/v1/ops/session", s);
        logout.setMethod("DELETE");
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        down.doFilter(logout, res, chain);
        assertThat(res.getStatus()).as("not 503").isEqualTo(200);
        assertThat(chain.getRequest()).as("the controller invalidates the session").isNotNull();
        assertThat(s.isInvalid()).isFalse();
        // 다른 운영 요청은 그대로 503(모름 — 끝내지도 통과시키지도 않는다), 지난 세션의 로그아웃은 수명 검사가 끝낸다
        MockHttpServletResponse other = new MockHttpServletResponse();
        down.doFilter(request("/api/v1/ops/session", s), other, new MockFilterChain());
        assertThat(other.getStatus()).isEqualTo(503);
        MockHttpSession old = sessionLoggedInAgo(Duration.ofHours(9));
        old.setAttribute(OpsSessionLifetimeFilter.USER_ID, 7);
        MockHttpServletRequest lateLogout = request("/api/v1/ops/session", old);
        lateLogout.setMethod("DELETE");
        down.doFilter(lateLogout, new MockHttpServletResponse(), new MockFilterChain());
        assertThat(old.isInvalid()).isTrue();
    }

    /**
     * IM-24(리뷰 #8): 자격 확인(DB)을 지금 못 하면 503 + 그 요청 id 가 든 WARN 한 줄(스택 없음) — 화면에 보인 요청 id 로 로그를 찾을 수 있다. 예전에는
     * 아무것도 남기지 않았다. 줄은 저장소 장애 503 의 줄(ProblemAdvice)과 같은 모양이다: 원인 · request_id · path · 짧은 예외 요약.
     */
    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void anOutageOfTheCredentialLookupIs503WithOneWarnLine(CapturedOutput output) throws Exception {
        OpsSessionLifetimeFilter down = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC), uid -> { throw poolTimeout(); });
        MockHttpSession s = loggedIn("sess-outage-0001", 7, "tag-outage");
        MockHttpServletResponse res = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        down.doFilter(request("/api/v1/ops/providers", s, "rid-im24-outage"), res, chain);
        assertThat(res.getStatus()).isEqualTo(503);
        assertThat(res.getHeader("Retry-After")).isEqualTo("10");
        assertThat(chain.getRequest()).as("not passed on unverified").isNull();
        assertThat(s.isInvalid()).as("unknown is not a logout").isFalse();
        assertThat(lines(output, "rid-im24-outage")).singleElement().satisfies(l -> assertThat(l)
                .contains("WARN", "could not get a DB connection", "path=\"/api/v1/ops/providers\"", "→ 503",
                        "CannotGetJdbcConnectionException ← SQLTransientConnectionException: HikariPool-1")
                .doesNotContain("sess-outage-0001", "tag-outage"));
        assertThat(output.getAll()).as("an outage is not a bug — no stack").doesNotContain("\tat ");
    }

    /**
     * IM-24(리뷰 #8): 장애가 아닌 예외(권한 42501 의 BadSqlGrammarException · 코드 결함)는 503 '잠시 뒤 재시도' 로 숨기지 않고 500 + ERROR(스택)다
     * (공개 경로의 ProblemAdvice 규칙과 같다). 예전에는 어떤 RuntimeException 이든 로그 없는 503 이었다.
     * R5(개선 작업 독립 검토): 그 ERROR 줄과 본문이 요청 id 를 싣는다 — 예전에는 다시 던져 컨테이너가 남긴 줄에 요청 id 가 없었다(OpsCredentialDefectLogIT).
     */
    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aDefectInTheCredentialLookupIsAnswered500WithAnErrorLineCarryingTheRequestId(CapturedOutput output) throws Exception {
        RuntimeException[] defects = {
                new BadSqlGrammarException("credential", "SELECT password_hash FROM ops_user WHERE id = :id",
                        new SQLException("ERROR: permission denied for table ops_user", "42501")),
                new IllegalStateException("bug in the lookup")};
        for (RuntimeException defect : defects) {
            OpsSessionLifetimeFilter f = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC), uid -> { throw defect; });
            MockHttpSession s = loggedIn("sess-defect-0001", 7, "tag");
            MockHttpServletResponse res = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();
            f.doFilter(request("/api/v1/ops/providers", s, "rid-im24-defect"), res, chain);
            assertThat(res.getStatus()).as(defect.getClass().getSimpleName()).isEqualTo(500);
            assertThat(res.getContentAsString()).contains("\"code\":\"INTERNAL\"").contains("rid-im24-defect");
            assertThat(res.getHeader("Retry-After")).isNull();
            assertThat(chain.getRequest()).isNull();
            assertThat(s.isInvalid()).isFalse();
        }
        assertThat(lines(output, "→ 503")).as("no 503 line for a defect").isEmpty();
        assertThat(lines(output, "rid-im24-defect")).as("one ERROR line per defect, with the request id and path").hasSize(2)
                .allSatisfy(l -> assertThat(l).contains("ERROR", "unhandled error request_id=rid-im24-defect", "/api/v1/ops/providers"));
        assertThat(output.getAll()).as("a defect keeps its stack").contains("permission denied for table ops_user").contains("bug in the lookup").contains("\tat ");
    }

    /**
     * IM-24(리뷰 #11): 자격 표식이 다르거나(비밀번호 교체) 없거나 사용자가 없어 세션을 끝내면 WARN 한 줄 — 사유 · user_id · request_id · path. 비밀번호를
     * 바꾼 뒤 옛 쿠키가 쓰였는지 시스템 로그로 알 수 있다(예전에는 흔적이 없었다). 세션 id · 표식(비밀번호 해시에서 나온 값)은 싣지 않는다.
     * 절대 수명 만료 · 같은 표식은 정상 경로라 남기지 않는다.
     */
    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void endingASessionForItsCredentialLeavesOneWarnLineWithoutSecrets(CapturedOutput output) throws Exception {
        Map<Integer, String> current = Map.of(7, "tag-now-7f3a");
        OpsSessionLifetimeFilter f = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC),
                uid -> Optional.ofNullable(current.get(uid)));
        record Case(String rid, String sessionId, int uid, String tag, String reason) {}
        List<Case> ended = List.of(
                new Case("rid-im24-changed", "sess-changed-0001", 7, "tag-old-91c2", "credential changed since login"),
                new Case("rid-im24-untagged", "sess-untagged-0001", 7, null, "session carries no credential"),
                new Case("rid-im24-gone", "sess-gone-0001", 8, "tag-gone-55d0", "user no longer exists"));
        for (Case c : ended) {
            MockHttpSession s = loggedIn(c.sessionId(), c.uid(), c.tag());
            MockFilterChain chain = new MockFilterChain();
            f.doFilter(request("/api/v1/ops/providers", s, c.rid()), new MockHttpServletResponse(), chain);
            assertThat(s.isInvalid()).as(c.reason()).isTrue();
            assertThat(chain.getRequest()).as("continues anonymously (404)").isNotNull();
            assertThat(lines(output, c.rid())).as(c.reason()).singleElement().satisfies(l -> assertThat(l)
                    .contains("WARN", "ops session ended", c.reason(), "user_id=" + c.uid(), "path=\"/api/v1/ops/providers\"")
                    .doesNotContain(c.sessionId(), "tag-now-7f3a", "tag-old-91c2", "tag-gone-55d0"));
        }
        // 같은 표식(그대로 지나감) · 절대 수명 만료(정상 경로)는 남기지 않는다
        MockHttpSession same = loggedIn("sess-same-0001", 7, "tag-now-7f3a");
        f.doFilter(request("/api/v1/ops/providers", same, "rid-im24-same"), new MockHttpServletResponse(), new MockFilterChain());
        assertThat(same.isInvalid()).isFalse();
        MockHttpSession old = loggedIn("sess-expired-0001", 7, "tag-old-91c2");
        old.setAttribute(OpsSessionLifetimeFilter.AUTH_AT, NOW.minus(Duration.ofHours(9)).toEpochMilli());
        f.doFilter(request("/api/v1/ops/providers", old, "rid-im24-expired"), new MockHttpServletResponse(), new MockFilterChain());
        assertThat(old.isInvalid()).isTrue();
        assertThat(lines(output, "rid-im24-same")).isEmpty();
        assertThat(lines(output, "rid-im24-expired")).isEmpty();
    }

    /**
     * IM-25(리뷰 #9): 이 필터의 WARN 줄(세션 저장소 장애 · 자격 확인 장애 · 자격으로 끝낸 세션)은 경로 원문을 따옴표 안에 싣는다(path="…") — 보안 필터
     * 체인은 컨트롤러 매핑 전이라 경로 패턴이 없다. 로그 지문(LogEvents.template 이 따옴표 안을 '…' 로 바꾼다)이 운영 경로의 값(공급자 이름 · 동작 ·
     * 설정 키)마다 갈리지 않는다 — 예전에는 원문 경로가 따옴표 밖이라 한 장애가 경로마다 다른 묶음이 됐다. 지문은 싱크가 구하는 그대로.
     */
    @Test
    void theFiltersWarnLinesQuoteThePathSoOneCauseIsOneLogGroup() throws Exception {
        String[] paths = {"/api/v1/ops/providers/opensky/pause", "/api/v1/ops/settings/region_radius_nm"};
        String[] rids = {"0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"}; // 운영의 요청 id 모양(32자 16진)
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        Logger[] loggers = {(Logger) LoggerFactory.getLogger(OpsSessionLifetimeFilter.class), (Logger) LoggerFactory.getLogger(ProblemAdvice.class)};
        for (Logger l : loggers) l.addAppender(logs);
        try {
            OpsSessionLifetimeFilter lookupDown = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC), uid -> { throw poolTimeout(); });
            OpsSessionLifetimeFilter changed = new OpsSessionLifetimeFilter(Duration.ofHours(8), Clock.fixed(NOW, ZoneOffset.UTC), uid -> Optional.of("tag-now"));
            for (int i = 0; i < paths.length; i++) {
                String path = paths[i];
                MockHttpServletRequest storeDown = new MockHttpServletRequest("POST", path) {
                    @Override public jakarta.servlet.http.HttpSession getSession(boolean create) { throw new org.springframework.dao.QueryTimeoutException("Redis command timed out"); }
                };
                storeDown.setRequestURI(path);
                storeDown.setAttribute(RequestIdFilter.ATTR, rids[i]);
                FILTER.doFilter(storeDown, new MockHttpServletResponse(), new MockFilterChain());
                lookupDown.doFilter(request(path, loggedIn("sess-im25-a" + i, 7, "tag"), rids[i]), new MockHttpServletResponse(), new MockFilterChain());
                changed.doFilter(request(path, loggedIn("sess-im25-b" + i, 7, "tag-old"), rids[i]), new MockHttpServletResponse(), new MockFilterChain());
            }
            List<ILoggingEvent> warns = logs.list.stream().filter(e -> e.getLevel() == Level.WARN).toList();
            assertThat(warns).hasSize(6);
            for (int kind = 0; kind < 3; kind++) {
                ILoggingEvent first = warns.get(kind), second = warns.get(kind + 3);
                assertThat(sinkFingerprint(first)).as("%s / %s", first.getFormattedMessage(), second.getFormattedMessage()).isEqualTo(sinkFingerprint(second));
                assertThat(first.getFormattedMessage()).contains("path=\"/api/v1/ops/providers/opensky/pause\"");
                assertThat(second.getFormattedMessage()).contains("path=\"/api/v1/ops/settings/region_radius_nm\"");
            }
            assertThat(warns.get(0).getFormattedMessage()).startsWith("session store unavailable request_id=" + rids[0] + " path=\"");
            assertThat(warns.get(1).getFormattedMessage()).startsWith("could not get a DB connection request_id=" + rids[0] + " path=\"").doesNotContain("uri=");
            assertThat(warns.get(2).getFormattedMessage()).startsWith("ops session ended: credential changed since login user_id=7 request_id=" + rids[0] + " path=\"");
        } finally {
            for (Logger l : loggers) l.detachAppender(logs);
        }
    }

    /** 서버 로그 싱크(LogSink.accept)가 구하는 지문 그대로: 서비스 api · 로거 이름 · 예외 종류(없으면 null) · 가린 메시지. */
    static String sinkFingerprint(ILoggingEvent e) {
        return LogEvents.fingerprint("api", e.getLoggerName(), e.getThrowableProxy() == null ? null : e.getThrowableProxy().getClassName(),
                LogMasker.maskAll(e.getFormattedMessage()));
    }

    /** QA-102: 세션 저장소(Redis)를 읽지 못하면 운영 요청은 503 + Retry-After 10 — 넘기지 않는다(예전: 예외가 필터 밖으로 나가 500). */
    @Test
    void anOpsRequestWhoseSessionCannotBeReadIs503WithRetryAfter() throws Exception {
        for (RuntimeException down : new RuntimeException[] {new org.springframework.data.redis.RedisSystemException("Redis exception",
                new IllegalStateException("Currently not connected")), new org.springframework.dao.QueryTimeoutException("Redis command timed out")}) {
            MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/v1/ops/settings") {
                @Override public jakarta.servlet.http.HttpSession getSession(boolean create) { throw down; }
            };
            req.setRequestURI("/api/v1/ops/settings");
            MockHttpServletResponse res = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();
            FILTER.doFilter(req, res, chain);
            assertThat(res.getStatus()).isEqualTo(503);
            assertThat(res.getHeader("Retry-After")).isEqualTo("10");
            assertThat(res.getContentType()).isEqualTo("application/problem+json");
            assertThat(res.getContentAsString()).contains("\"code\":\"UNAVAILABLE\"");
            assertThat(chain.getRequest()).as("not passed on").isNull();
        }
    }

    @Test
    void maxAgeMustBePositive() {
        assertThatThrownBy(() -> new OpsSessionLifetimeFilter(Duration.ZERO, Clock.systemUTC())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new OpsSessionLifetimeFilter(Duration.ofHours(-1), Clock.systemUTC())).isInstanceOf(IllegalArgumentException.class);
    }
}
