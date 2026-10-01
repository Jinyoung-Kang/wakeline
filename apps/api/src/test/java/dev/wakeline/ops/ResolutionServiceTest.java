package dev.wakeline.ops;

import dev.wakeline.platform.web.Problem;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 해결 표시(계약 v5 §G14) — DB 없이: 요청 본문 규칙(400 BAD_RESOLUTION), 유효 해결(같은 key 는 upto 가 가장 늦은 행), 활성 해결 캐시
 * (5 s 이하 · 쓰기 뒤 바로 버림 · 쓰기와 겹친 읽기가 옛 값을 캐시에 남기지 않음), DB 를 읽지 못할 때(마지막으로 읽은 값 = stale,
 * 한 번도 못 읽었으면 unavailable — 아무것도 가리지 않는다, 30 s 뒤 다시), 다시 읽는 동안 다른 요청은 지난 값(쓰기 뒤는 기다림).
 * 트랜잭션 · 감사 · 권한은 ResolutionDbTest · OpsResolutionsIT.
 */
class ResolutionServiceTest {
    static final Instant NOW = Instant.parse("2026-09-29T05:00:00.123456789Z");
    static final String FP = "0123456789abcdef";
    static final JsonMapper JSON = JsonMapper.builder().build();

    /** 트랜잭션 없는 관리자(단위 시험 — 콜백만 부른다). */
    static final PlatformTransactionManager NO_TX = new PlatformTransactionManager() {
        @Override public TransactionStatus getTransaction(TransactionDefinition d) { return new SimpleTransactionStatus(); }
        @Override public void commit(TransactionStatus s) { }
        @Override public void rollback(TransactionStatus s) { }
    };

    /** 메모리 저장소: active() 호출 수를 세고, fail 이 켜지면 DB 장애처럼 던진다. */
    static final class FakeRepo extends ResolutionRepository {
        final List<Resolution> rows = new ArrayList<>();
        final List<Long> revoked = new ArrayList<>();
        final AtomicInteger reads = new AtomicInteger();
        volatile boolean fail;
        Runnable duringRead = () -> { };
        long nextId = 1;

        FakeRepo() { super(null); }

        @Override
        public List<Resolution> active() {
            reads.incrementAndGet();
            if (fail) throw new org.springframework.dao.DataAccessResourceFailureException("db down");
            List<Resolution> snapshot = new ArrayList<>();
            for (Resolution r : rows) if (!revoked.contains(r.id())) snapshot.addFirst(r);
            duringRead.run();
            return snapshot;
        }

        @Override
        public Resolution insert(String kind, String key, Instant upto, String by, String note) {
            Resolution r = new Resolution(nextId++, kind, key, upto, NOW, by, note);
            rows.add(r);
            return r;
        }

        @Override
        public Revoked revoke(long id, String by) {
            for (Resolution r : rows) if (r.id() == id && !revoked.contains(id)) { revoked.add(id); return new Revoked(r, NOW, by); }
            return null;
        }
    }

    final FakeRepo repo = new FakeRepo();
    final AtomicLong nanos = new AtomicLong(1_000_000_000L);
    final AtomicReference<Instant> clock = new AtomicReference<>(NOW);
    final ResolutionService svc = new ResolutionService(repo, new TransactionTemplate(NO_TX), clock::get, nanos::get);

    static JsonNode body(String json) { return JSON.readTree(json); }

    void advance(Duration d) { nanos.addAndGet(d.toNanos()); }

    static void assertBad(Runnable r, String detailPart) {
        assertThatThrownBy(r::run).isInstanceOfSatisfying(Problem.class, p -> {
            assertThat(p.status().value()).isEqualTo(400);
            assertThat(p.code()).isEqualTo("BAD_RESOLUTION");
            assertThat(p.getMessage()).contains(detailPart);
        });
    }

    // ---------------------------------------------------------------- 요청 본문

    @Test
    void aDraftNeedsAKnownKindAndAKeyOfThatKind_uptoDefaultsToNowInMicroseconds() {
        ResolutionService.Draft d = svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\"}"));
        assertThat(d).isEqualTo(new ResolutionService.Draft("log_group", FP, Instant.parse("2026-09-29T05:00:00.123456Z"), null));
        ResolutionService.Draft p = svc.parse(body("{\"kind\":\"provider_error\",\"key\":\"adsb_lol\",\"upto\":\"2026-09-29T13:59:00+09:00\","
                + "\"note\":\"  upstream fixed  \"}"));
        assertThat(p).isEqualTo(new ResolutionService.Draft("provider_error", "adsb_lol", Instant.parse("2026-09-29T04:59:00Z"), "upstream fixed"));
        assertThat(svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"upto\":null,\"note\":\"   \"}")))
                .isEqualTo(new ResolutionService.Draft("log_group", FP, Instant.parse("2026-09-29T05:00:00.123456Z"), null));
        // 지금 그 시각은 받는다(미래가 아니다)
        assertThat(svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"upto\":\"2026-09-29T05:00:00.123456Z\"}")).upto())
                .isEqualTo(Instant.parse("2026-09-29T05:00:00.123456Z"));
    }

    @Test
    void badDraftsAre400BadResolution() {
        assertBad(() -> svc.parse(body("[]")), "JSON object");
        assertBad(() -> svc.parse((JsonNode) null), "JSON object");
        // 본문 글자: 비었음 · JSON 아님 · 같은 키 두 번(어느 값인지 모호) · 뒤에 붙은 글자 · 너무 김
        assertBad(() -> svc.parse((String) null), "JSON object");
        assertBad(() -> svc.parse("  "), "JSON object");
        assertBad(() -> svc.parse("kind=log_group"), "JSON object");
        assertBad(() -> svc.parse("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"key\":\"ffffffffffffffff\"}"), "repeated");
        assertBad(() -> svc.parse("{\"kind\":\"log_group\",\"key\":\"" + FP + "\"} {}"), "JSON object");
        assertBad(() -> svc.parse("{\"note\":\"" + "x".repeat(5000) + "\"}"), "4096");
        assertThat(svc.parse("{\"kind\":\"log_group\",\"key\":\"" + FP + "\"}").key()).isEqualTo(FP);
        assertBad(() -> svc.parse(body("{\"key\":\"" + FP + "\"}")), "kind");
        assertBad(() -> svc.parse(body("{\"kind\":\"alert\",\"key\":\"x\"}")), "kind");
        assertBad(() -> svc.parse(body("{\"kind\":1,\"key\":\"x\"}")), "kind");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\"}")), "key");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"0123456789ABCDEF\"}")), "16 lowercase hex");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\" " + FP + "\"}")), "16 lowercase hex");
        assertBad(() -> svc.parse(body("{\"kind\":\"provider_error\",\"key\":\"aisstream-x\"}")), "provider");
        assertBad(() -> svc.parse(body("{\"kind\":\"provider_error\",\"key\":[\"awc\"]}")), "key");
        // 오타는 조용히 기본값(지금 — 더 많이 가린다)이 되지 않는다
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"up_to\":\"2026-09-29T00:00:00Z\"}")), "unknown field");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"upto\":\"2026-09-29T05:00:01Z\"}")), "future");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"upto\":\"2026-09-29T05:00:00\"}")), "offset");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"upto\":\"yesterday\"}")), "offset");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"upto\":1727586000}")), "offset");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"upto\":\"1999-12-31T23:59:59Z\"}")), "2000-01-01");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"note\":5}")), "note");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"note\":\"" + "가".repeat(201) + "\"}")), "200");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"note\":\"a\\u0000b\"}")), "control");
        assertBad(() -> svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"note\":\"line\\nbreak\"}")), "control");
        // 200 글자(코드 포인트 — 바이트가 아니다)는 받는다: 한글 · 이모지
        assertThat(svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\",\"note\":\"" + "가".repeat(199) + "\\ud83d\\ude00\"}")).note())
                .hasSize(201); // UTF-16 201 단위 = 코드 포인트 200
    }

    // ---------------------------------------------------------------- 유효 해결

    @Test
    void theEffectiveResolutionOfAKeyIsTheActiveOneWithTheLatestUpto() {
        Resolution early = new Resolution(1, "log_group", FP, NOW.minusSeconds(600), NOW.minusSeconds(600), "a", null);
        Resolution late = new Resolution(2, "log_group", FP, NOW.minusSeconds(60), NOW.minusSeconds(60), "b", null);
        Resolution backdated = new Resolution(3, "log_group", FP, NOW.minusSeconds(3600), NOW, "c", "older range, resolved later");
        Resolution tie = new Resolution(4, "provider_error", "awc", NOW, NOW, "d", null);
        Resolution tie2 = new Resolution(5, "provider_error", "awc", NOW, NOW, "e", null);
        Resolutions r = Resolutions.of(List.of(tie2, tie, backdated, late, early), Resolutions.State.OK);
        assertThat(r.logGroup(FP)).isEqualTo(late);
        assertThat(r.provider("awc").id()).as("same upto: the newer row").isEqualTo(5);
        assertThat(r.logGroup("ffffffffffffffff")).isNull();
        assertThat(r.provider(FP)).as("kinds do not mix").isNull();
        assertThat(r.logGroup(null)).isNull();
        assertThat(r.items()).containsExactly(tie2, tie, backdated, late, early);
        assertThat(r.state()).isEqualTo(Resolutions.State.OK);
        assertThat(Resolutions.State.STALE.label()).isEqualTo("stale");
        // 덮는가: upto 와 같은 시각 포함, 모름(null)은 덮지 않는다
        assertThat(late.covers(late.upto())).isTrue();
        assertThat(late.covers(late.upto().plusNanos(1000))).isFalse();
        assertThat(late.covers(null)).isFalse();
        assertThat(late.ref()).isEqualTo(new Resolution.Ref(2, late.upto(), "b"));
    }

    // ---------------------------------------------------------------- 캐시

    @Test
    void activeResolutionsAreCachedForAtMostFiveSecondsAndDroppedOnEveryWrite() {
        assertThat(svc.active().items()).isEmpty();
        assertThat(svc.active().items()).isEmpty();
        assertThat(repo.reads).as("second read within 5 s is cached").hasValue(1);
        advance(Duration.ofMillis(4_999));
        svc.active();
        assertThat(repo.reads).hasValue(1);
        advance(Duration.ofMillis(1));
        svc.active();
        assertThat(repo.reads).as("5 s after the read started: read again").hasValue(2);

        Resolution r = svc.create(svc.parse(body("{\"kind\":\"log_group\",\"key\":\"" + FP + "\"}")), "ops", (t, b, a) -> { });
        assertThat(svc.active().logGroup(FP)).as("read-your-writes: the cache is dropped on write").isEqualTo(r);
        assertThat(repo.reads).hasValue(3);
        svc.revoke(r.id(), "ops", (t, b, a) -> { });
        assertThat(svc.active().logGroup(FP)).isNull();
        assertThat(repo.reads).hasValue(4);
    }

    /** 읽기가 끝나기 전에 쓰기가 커밋되면(그 읽기는 옛 값일 수 있다) 그 결과는 캐시에 남지 않는다 — 다음 읽기가 다시 읽는다. */
    @Test
    void aReadThatOverlapsAWriteDoesNotLeaveItsOldSnapshotInTheCache() {
        repo.duringRead = () -> {
            repo.duringRead = () -> { };
            repo.insert("log_group", FP, NOW, "ops", null); // 다른 요청의 쓰기가 이 읽기 도중에 커밋되고 캐시를 버렸다
            svc.invalidate();
        };
        assertThat(svc.active().logGroup(FP)).as("this read's own (older) snapshot").isNull();
        assertThat(svc.active().logGroup(FP)).as("not cached: read again").isNotNull();
        assertThat(repo.reads).hasValue(2);
    }

    @Test
    void whenTheDatabaseCannotBeReadTheLastSnapshotIsServedAsStale_orNothingIsHiddenIfThereIsNone() {
        repo.fail = true;
        Resolutions none = svc.active();
        assertThat(none.state()).isEqualTo(Resolutions.State.UNAVAILABLE);
        assertThat(none.items()).isEmpty();
        assertThat(none.logGroup(FP)).as("nothing is hidden when resolutions are unknown").isNull();
        svc.active();
        assertThat(repo.reads).as("a failed read is retried after 30 s, not on every request").hasValue(1);
        advance(Duration.ofSeconds(30));
        svc.active();
        assertThat(repo.reads).hasValue(2);

        repo.fail = false;
        advance(Duration.ofSeconds(30));
        repo.insert("log_group", FP, NOW, "ops", "x");
        Resolutions ok = svc.active();
        assertThat(ok.state()).isEqualTo(Resolutions.State.OK);
        assertThat(ok.logGroup(FP)).isNotNull();

        repo.fail = true;
        advance(Duration.ofSeconds(5));
        Resolutions stale = svc.active();
        assertThat(stale.state()).isEqualTo(Resolutions.State.STALE);
        assertThat(stale.logGroup(FP)).as("the last snapshot read from the database").isNotNull();
        assertThat(stale.items()).hasSize(1);
        // 쓰기(캐시 버림) 뒤에는 기다리지 않고 다시 읽어 본다
        svc.invalidate();
        svc.active();
        assertThat(repo.reads).hasValue(5);
    }

    /**
     * 다시 읽는 동안(느린 DB · 장애 — 연결 대기까지 수 초) 다른 요청은 그 읽기를 기다리지 않고 같은 세대의 지난 값을 바로 받는다(로그 조회는 Redis 만
     * 필요하다). 쓰기로 캐시가 버려졌으면(읽기-쓰기 일관) 지난 값을 주지 않고 새로 읽은 값을 기다린다.
     */
    @Test
    void whileOneRequestReReadsOtherRequestsGetTheLastValueWithoutWaiting_butNotAfterAWrite() throws Exception {
        repo.insert("log_group", FP, NOW, "ops", null);
        Resolutions first = svc.active();
        advance(Duration.ofSeconds(5)); // 만료 — 다음 요청이 다시 읽는다
        CountDownLatch inRead = new CountDownLatch(1), release = new CountDownLatch(1);
        repo.duringRead = () -> {
            repo.duringRead = () -> { };
            inRead.countDown();
            try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        };
        ExecutorService pool = Executors.newCachedThreadPool(); // 요청마다 제 스레드(공용 풀 크기에 기대지 않는다)
        CompletableFuture<Resolutions> loader = CompletableFuture.supplyAsync(svc::active, pool);
        CompletableFuture<Resolutions> afterWrite = null;
        try {
            assertThat(inRead.await(5, TimeUnit.SECONDS)).as("the re-read is in progress").isTrue();
            Resolutions other = CompletableFuture.supplyAsync(svc::active, pool).get(2, TimeUnit.SECONDS);
            assertThat(other).as("the previous value, at once").isSameAs(first);
            assertThat(repo.reads).as("no second read while one is in progress").hasValue(2);

            // 쓰기가 커밋되고 캐시를 버렸다: 그 뒤의 요청은 옛 값을 받지 않고 기다렸다가 새로 읽는다
            repo.insert("provider_error", "awc", NOW, "ops", null);
            svc.invalidate();
            afterWrite = CompletableFuture.supplyAsync(svc::active, pool);
            CompletableFuture<Resolutions> w = afterWrite;
            assertThatThrownBy(() -> w.get(300, TimeUnit.MILLISECONDS)).as("waits for a read that starts after the write")
                    .isInstanceOf(TimeoutException.class);
            release.countDown(); // 진행 중이던 읽기가 끝난다
            assertThat(loader.get(5, TimeUnit.SECONDS).provider("awc")).as("the in-progress read began before the write").isNull();
            assertThat(afterWrite.get(5, TimeUnit.SECONDS).provider("awc")).as("read-your-writes").isNotNull();
            assertThat(repo.reads).hasValue(3);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    // ---------------------------------------------------------------- 쓰기

    @Test
    void createAndRevokeCallTheAuditHookWithTheTargetInsideTheTransaction() {
        List<String> audit = new ArrayList<>();
        Resolution r = svc.create(new ResolutionService.Draft("provider_error", "awc", NOW, "n"), "ops",
                (target, before, after) -> audit.add(target + " " + before + " " + ((Resolution) after).id()));
        assertThat(r.resolvedBy()).isEqualTo("ops");
        svc.revoke(r.id(), "ops2", (target, before, after) -> audit.add(target + " " + ((Resolution) before).id() + " " + after));
        assertThat(audit).hasSize(2);
        assertThat(audit.get(0)).isEqualTo("provider_error:awc null 1");
        assertThat(audit.get(1)).startsWith("provider_error:awc 1 {").contains("revoked_by=ops2").contains("revoked_at=" + NOW);
        assertThatThrownBy(() -> svc.revoke(r.id(), "ops", (t, b, a) -> { })).isInstanceOfSatisfying(Problem.class,
                p -> assertThat(p.status().value()).isEqualTo(404));
        assertThatThrownBy(() -> svc.revoke(99, "ops", (t, b, a) -> { })).isInstanceOf(Problem.class);
    }

    /** 감사가 실패하면 예외가 그대로 올라가고(트랜잭션이 되돌린다 — ResolutionDbTest) 캐시도 버린다. */
    @Test
    void aFailingAuditPropagatesAndStillDropsTheCache() {
        svc.active();
        assertThatThrownBy(() -> svc.create(new ResolutionService.Draft("log_group", FP, NOW, null), "ops",
                (t, b, a) -> { throw new IllegalStateException("audit down"); })).hasMessageContaining("audit down");
        svc.active();
        assertThat(repo.reads).hasValue(2);
    }
}
