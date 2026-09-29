package dev.wakeline.ops;

import dev.wakeline.DbTestSupport;
import dev.wakeline.config.Problem;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.mock.web.MockHttpServletRequest;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 해결 표시(계약 v5 §G13)를 실제 PostgreSQL · api 계정(wakeline_api)으로: 해결 · 되돌림과 감사 행(RESOLVE · UNRESOLVE)이 한 트랜잭션
 * (감사가 실패하면 해결도 없다), 되돌림은 행을 지우지 않는다, 이미 되돌린 행 · 없는 id 는 404, 활성 목록은 최신 순, upto 는 μs 까지 그대로.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class ResolutionDbTest {
    static final String FP = "fedcba9876543210";

    JdbcClient admin;
    AuditService audit;
    ResolutionService svc;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        admin = DbTestSupport.admin();
        audit = new AuditService(DbTestSupport.apiClient(), DbTestSupport.JSON, OpsDbTest.PROPS);
        svc = new ResolutionService(new ResolutionRepository(DbTestSupport.apiClient()), DbTestSupport.apiTx());
    }

    ResolutionService.AuditHook hook(String action) {
        var req = new MockHttpServletRequest("POST", "/api/v1/ops/resolutions");
        req.setRemoteAddr("127.0.0.1");
        return (target, before, after) -> audit.record(req, null, action, target, before, after);
    }

    long count(String sql) { return admin.sql(sql).query(Long.class).single(); }

    @Test
    void resolveAndItsAuditRowCommitTogetherOrNotAtAll() {
        Instant upto = Instant.parse("2026-09-29T04:00:00.123456Z");
        assertThatThrownBy(() -> svc.create(new ResolutionService.Draft("log_group", FP, upto, null), "ops",
                (t, b, a) -> { throw new IllegalStateException("audit down"); })).hasMessageContaining("audit down");
        assertThat(count("SELECT count(*) FROM ops_resolution")).as("no resolution without its audit row").isZero();

        Resolution r = svc.create(new ResolutionService.Draft("log_group", FP, upto, "fixed by restart"), "ops", hook("RESOLVE"));
        assertThat(r.id()).isPositive();
        assertThat(r.upto()).as("microseconds round-trip").isEqualTo(upto);
        assertThat(r.resolvedAt()).isCloseTo(Instant.now(), org.assertj.core.api.Assertions.within(60, ChronoUnit.SECONDS));
        assertThat(r).extracting(Resolution::kind, Resolution::key, Resolution::resolvedBy, Resolution::note)
                .containsExactly("log_group", FP, "ops", "fixed by restart");
        Map<String, Object> a = admin.sql("SELECT action, target, before IS NULL no_before, (after->>'id')::bigint id, after->>'upto' upto, after->>'resolved_by' by "
                + "FROM audit_log").query().singleRow();
        assertThat(a).containsEntry("action", "RESOLVE").containsEntry("target", "log_group:" + FP).containsEntry("no_before", true)
                .containsEntry("id", r.id()).containsEntry("by", "ops");
        assertThat(Instant.parse(String.valueOf(a.get("upto")))).isEqualTo(upto);
        assertThat(svc.active().logGroup(FP)).isEqualTo(r);
    }

    @Test
    void revokeKeepsTheRowAndWritesUnresolveInTheSameTransaction_onlyOnce() {
        Resolution r = svc.create(new ResolutionService.Draft("provider_error", "awc", Instant.now().truncatedTo(ChronoUnit.MICROS), null), "ops",
                hook("RESOLVE"));
        assertThatThrownBy(() -> svc.revoke(r.id(), "ops2", (t, b, a) -> { throw new IllegalStateException("audit down"); }))
                .hasMessageContaining("audit down");
        assertThat(count("SELECT count(*) FROM ops_resolution WHERE revoked_at IS NULL")).as("revoke rolled back with its audit").isEqualTo(1);

        svc.revoke(r.id(), "ops2", hook("UNRESOLVE"));
        Map<String, Object> row = admin.sql("SELECT revoked_at IS NOT NULL revoked, revoked_by, note FROM ops_resolution WHERE id = :id").param("id", r.id())
                .query().singleRow();
        assertThat(row).containsEntry("revoked", true).containsEntry("revoked_by", "ops2");
        Map<String, Object> a = admin.sql("SELECT target, (before->>'id')::bigint id, after->>'revoked_by' by, after->>'revoked_at' revoked_at FROM audit_log "
                + "WHERE action = 'UNRESOLVE'").query().singleRow();
        assertThat(a).containsEntry("target", "provider_error:awc").containsEntry("id", r.id()).containsEntry("by", "ops2");
        assertThat(a.get("revoked_at")).isNotNull();
        assertThat(svc.active().provider("awc")).isNull();

        // 이미 되돌린 행 · 없는 id: 404, 감사 없음
        for (long id : new long[]{r.id(), 424242}) {
            assertThatThrownBy(() -> svc.revoke(id, "ops", hook("UNRESOLVE"))).isInstanceOfSatisfying(Problem.class,
                    p -> assertThat(p.status().value()).isEqualTo(404));
        }
        assertThat(count("SELECT count(*) FROM audit_log WHERE action = 'UNRESOLVE'")).isEqualTo(1);
        assertThat(count("SELECT count(*) FROM ops_resolution")).as("nothing is deleted").isEqualTo(1);
    }

    @Test
    void activeListsUnrevokedResolutionsNewestFirst() {
        Instant t = Instant.now().truncatedTo(ChronoUnit.MICROS);
        Resolution a = svc.create(new ResolutionService.Draft("log_group", FP, t.minusSeconds(60), null), "ops", hook("RESOLVE"));
        Resolution b = svc.create(new ResolutionService.Draft("provider_error", "adsb_fi", t.minusSeconds(30), "n"), "ops", hook("RESOLVE"));
        Resolution c = svc.create(new ResolutionService.Draft("log_group", FP, t.minusSeconds(3600), null), "ops", hook("RESOLVE"));
        svc.revoke(b.id(), "ops", hook("UNRESOLVE"));
        Resolutions now = svc.active();
        assertThat(now.state()).isEqualTo(Resolutions.State.OK);
        assertThat(now.items()).extracting(Resolution::id).containsExactly(c.id(), a.id());
        assertThat(now.logGroup(FP)).as("the latest upto wins, not the newest row").isEqualTo(a);
        assertThat(List.of(now.items().get(0).note() == null, now.items().get(1).note() == null)).containsOnly(true);
    }
}
