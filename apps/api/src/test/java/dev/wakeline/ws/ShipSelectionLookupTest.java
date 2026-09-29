package dev.wakeline.ws;

import dev.wakeline.domain.ShipStatic;
import dev.wakeline.persist.StoredStaticReader;
import dev.wakeline.portcalls.PortCallFixtures;
import dev.wakeline.portcalls.PortCallIndex;
import dev.wakeline.portcalls.PortCallReader;
import dev.wakeline.portcalls.PortCallsInfo;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;

import static dev.wakeline.ws.ShipFanoutTest.BUSAN;
import static dev.wakeline.ws.ShipFanoutTest.pos;
import static dev.wakeline.ws.WsTestKit.ac;
import static dev.wakeline.ws.WsTestKit.ofType;
import static dev.wakeline.ws.WsTestKit.types;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 선택 선박의 DB 조회(저장 정적 보고 · 입출항 색인)를 세션 우편함 밖에서(VERIFICATION #51 '남은 것' · 계약 v5 §G18 · ADR-025).
 * <p>관찰(코드, 고치기 전): ShipFanout.runSelected 는 세션 우편함(SerialOutbox — 한 번에 하나)에서 돌고 StoredStaticReader.lookup · PortCallReader 를 그
 * 자리에서 불렀다(공유 Hikari 풀 — 연결 대기 5 s + 공개 조회 문장 3 s). 풀에 연결이 없는 동안 선택 하나가 그 세션의 항공기 · 선박 diff · pong · heartbeat 를
 * 최대 약 8 s 붙잡고, 실패 기억(15 s)이 끝날 때마다 되풀이됐다.
 * <p>고침: 우편함은 캐시만 보고, 읽어야 하면 조회 실행기(스레드 = 읽기 풀 연결 수 · 대기열 256)에 맡긴다. 결과는 우편함으로 돌아와 세션의 지금 물음과 같을
 * 때만 보낸다. 늦어도 마감(운영 5 s)에 답한다 — 끝나지 않은 부분은 읽지 못함(stored_unavailable · port_calls error). 이 시험은 운영처럼 따로 도는
 * 실행기(가상 스레드 · 작은 스레드 풀)를 넣는다(WsTestKit 기본은 바로 실행 — 다른 시험의 순서를 그대로 두려고).
 */
class ShipSelectionLookupTest {
    static final Instant T = ShipFanoutTest.T;
    static final String MMSI = "440000061", OTHER = "440000062", THIRD = "440000063";
    static final String NOT_RECEIVED = "no_call_sign/not_received";

    static void await(BooleanSupplier cond) throws InterruptedException {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!cond.getAsBoolean()) {
            if (System.nanoTime() > end) throw new AssertionError("timed out");
            Thread.sleep(5);
        }
    }

    /** 저장 정적 보고 원천(가짜 DB): hold 가 있으면 풀릴 때까지 기다린다 — 풀 연결 대기 · 잠긴 표를 흉내 낸다. 읽은 MMSI 를 적는다. */
    static final class BlockingStored implements StoredStaticReader.Source {
        final Map<String, ShipStatic> rows = new ConcurrentHashMap<>();
        final List<String> reads = new CopyOnWriteArrayList<>();
        volatile CountDownLatch hold;

        @Override public ShipStatic find(String mmsi) {
            reads.add(mmsi);
            CountDownLatch h = hold;
            if (h != null) {
                try {
                    if (!h.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("not released");
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                }
            }
            return rows.get(mmsi);
        }
    }

    static ShipStatic stored(String mmsi, String callSign) {
        return new ShipStatic(mmsi, "STORED " + mmsi, callSign, null, 70, null, null, null, null, null, null, null, null, null, null,
                T.minusSeconds(5 * 3600), "aisstream");
    }

    /** 운영과 같은 모양의 조회 묶음(실행기 · 마감)을 넣고, 저장 정적 보고 원천을 단다. */
    static StoredStaticReader wire(WsTestKit k, java.util.concurrent.Executor ex, long deadlineMs, BlockingStored db, AtomicLong clock) {
        k.shipFanout.useLookups(new ShipLookups(ex, deadlineMs, k.meters));
        StoredStaticReader reader = new StoredStaticReader(db, clock::get, k.meters);
        k.shipFanout.setStoredStaticSource(ShipLookups.stored(reader));
        return reader;
    }

    static FakeWsSession ready(WsTestKit k, String id) throws Exception {
        FakeWsSession f = ShipFanoutTest.session(k, id, BUSAN, true);
        WsSession s = k.handler.session(id);
        await(s::idle);
        return f;
    }

    static String calls(JsonNode sel) {
        return sel.path("port_calls").path("status").asString() + "/" + sel.path("port_calls").path("call_sign_state").asString();
    }

    static double outcome(WsTestKit k, String outcome) {
        return k.meters.counter("wakeline_ws_ship_lookups_total", "outcome", outcome).count();
    }

    /**
     * 고친 뒤(재현을 뒤집음): 저장 정적 보고 읽기가 DB 를 기다리는 동안에도 그 세션의 pong · 항공기 diff · 선박 diff 는 제때 간다. ship_selected 는 읽기가
     * 끝나면 — 그때의 최신 선박 상태와 함께 — 나간다. 같은 물음의 다시 계산(선박 이동)은 조회를 새로 맡기지 않는다.
     */
    @Test void whileTheStoredStaticReadWaitsOnTheDb_theSessionsOtherTrafficStillFlows() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = ShipLookups.boundedExecutor(2);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 35, 129, 30000, now, "adsb_lol"));
            ShipFanoutTest.publish(k, List.of(pos(MMSI, 35.1, 129.1, T), pos(OTHER, 35.2, 129.2, T)), List.of()); // 위치만(메모리에 정적 정보 없음)
            BlockingStored db = new BlockingStored();
            db.rows.put(MMSI, stored(MMSI, "D7SL"));
            wire(k, lookups, 5_000, db, new AtomicLong(System.currentTimeMillis()));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");
            assertThat(ofType(f, "ships_snapshot")).isNotEmpty();

            db.hold = new CountDownLatch(1);
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            await(() -> db.reads.size() == 1); // 읽기가 시작돼 DB 를 기다린다
            long t0 = System.nanoTime();
            k.msg(f, "{\"type\":\"ping\"}");
            await(() -> !ofType(f, "pong").isEmpty());
            assertThat((System.nanoTime() - t0) / 1_000_000).as("pong does not wait for the read").isLessThan(1_000);
            k.publish("region", now.plusSeconds(10), ac("aaa001", 35.3, 129, 30000, now.plusSeconds(10), "adsb_lol"));
            await(() -> !ofType(f, "diff").isEmpty());
            ShipFanoutTest.publish(k, List.of(pos(OTHER, 35.4, 129.2, T.plusSeconds(10))), List.of());
            await(() -> !ofType(f, "ships_diff").isEmpty());
            // 선택 선박이 움직여도(같은 물음) 새 조회를 맡기지 않는다 — 결과가 오면 그때의 상태로 한 번
            ShipFanoutTest.publish(k, List.of(pos(MMSI, 35.15, 129.1, T.plusSeconds(10))), List.of());
            await(s::idle);
            assertThat(ofType(f, "ship_selected")).as("pending — nothing yet").isEmpty();
            assertThat(s.shipLookup).isNotNull();
            assertThat(db.reads).hasSize(1);

            db.hold.countDown();
            await(() -> !ofType(f, "ship_selected").isEmpty() && s.idle());
            List<String> order = types(f);
            assertThat(order.indexOf("pong")).isLessThan(order.indexOf("ship_selected"));
            assertThat(ofType(f, "ship_selected")).hasSize(1);
            JsonNode sel = ofType(f, "ship_selected").getLast();
            assertThat(sel.path("static_source").asString()).isEqualTo("stored");
            assertThat(sel.path("static").path("call_sign").asString()).isEqualTo("D7SL");
            assertThat(sel.path("state").path("lat").asDouble()).as("the state current when the result arrived").isEqualTo(35.15);
            assertThat(s.shipLookup).isNull();
            assertThat(outcome(k, "ok")).isEqualTo(1.0);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * DB 가 끝내 답하지 않으면 마감에 읽지 못함으로 답한다: static null · stored_unavailable · port_calls no_call_sign/not_received(계약 v5 §G17 의 실패 모양).
     * 그동안 pong 은 간다. 읽기가 나중에 끝나 캐시를 채우면 다음 다시 보기가 저장값을 보낸다(실패를 붙잡아 두지 않는다).
     */
    @Test void aDbThatDoesNotAnswer_theFallbackArrivesAtTheDeadline_andTheLateResultComesWithTheNextRecheck() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = ShipLookups.boundedExecutor(2);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            ShipFanoutTest.publish(k, List.of(pos(MMSI, 35.1, 129.1, T)), List.of());
            BlockingStored db = new BlockingStored();
            db.rows.put(MMSI, stored(MMSI, "D7SL"));
            StoredStaticReader reader = wire(k, lookups, 300, db, new AtomicLong(System.currentTimeMillis()));
            PortCallFixtures.FakeSource index = new PortCallFixtures.FakeSource();
            k.shipFanout.setPortCallSource(ShipLookups.portCalls(new PortCallReader(index, List::of, System::currentTimeMillis)));
            FakeWsSession f = ready(k, "s");
            db.hold = new CountDownLatch(1);
            long t0 = System.nanoTime();
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            k.msg(f, "{\"type\":\"ping\"}");
            await(() -> !ofType(f, "ship_selected").isEmpty());
            long ms = (System.nanoTime() - t0) / 1_000_000;
            assertThat(ms).as("answered at the 300 ms deadline, not when the DB answers").isBetween(250L, 2_000L);
            JsonNode sel = ofType(f, "ship_selected").getLast();
            assertThat(sel.path("state").path("lat").asDouble()).isEqualTo(35.1);
            assertThat(sel.get("static").isNull()).isTrue();
            assertThat(sel.path("static_source").asString()).isEqualTo("stored_unavailable");
            assertThat(calls(sel)).isEqualTo(NOT_RECEIVED);
            assertThat(types(f).indexOf("pong")).isLessThan(types(f).indexOf("ship_selected"));
            assertThat(outcome(k, "deadline")).isEqualTo(1.0);

            db.hold.countDown(); // 늦게 끝난 읽기가 캐시를 채운다
            await(() -> reader.cached(MMSI) != null);
            k.shipFanout.refreshSelected();
            await(() -> ofType(f, "ship_selected").size() == 2);
            JsonNode late = ofType(f, "ship_selected").getLast();
            assertThat(late.path("static_source").asString()).isEqualTo("stored");
            assertThat(late.path("static").path("call_sign").asString()).isEqualTo("D7SL");
            assertThat(late.path("port_calls").path("call_sign").asString()).as("port calls with the stored call sign").isEqualTo("D7SL");
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 입출항 읽기도 우편함 밖: 메모리 정적 정보(live)가 있어도 호출부호의 색인 읽기가 막히면 pong 은 가고, 마감에 port_calls error(색인을 읽지 못함 — '기록
     * 없음' 이 아니다)로 답한다. 읽기가 끝나면 다음 다시 보기가 실제 값(ok)을 보낸다.
     */
    @Test void aPortCallReadThatWaits_isOffTheMailboxToo_errorAtTheDeadline_thenTheRealValue() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = ShipLookups.boundedExecutor(2);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            Instant now = Instant.parse("2026-09-29T13:00:00Z");
            AtomicLong clock = new AtomicLong(now.toEpochMilli());
            ShipFanoutTest.publish(k, List.of(pos(MMSI, 35.1, 129.1, T)), List.of(ShipFanoutTest.stat(MMSI, "LIVE ONE", 70))); // 호출부호 D7AB
            k.shipFanout.useLookups(new ShipLookups(lookups, 300, k.meters));
            PortCallFixtures.FakeSource index = new PortCallFixtures.FakeSource();
            index.coverage = PortCallFixtures.fullCoverage(LocalDate.parse("2026-08-20"), LocalDate.parse("2026-09-29"), now);
            PortCallIndex.Row row = PortCallFixtures.row(now);
            index.rows.put("D7AB", List.of(new PortCallIndex.Row(row.portAuthorityCode(), row.portAuthority(), "D7AB", row.listedDate(), row.reportedName(),
                    row.nationality(), row.kind(), row.purpose(), row.firstPortCode(), row.firstPortName(), row.prevPortCode(), row.prevPortName(),
                    row.nextPortCode(), row.nextPortName(), row.destPortCode(), row.destPortName(), row.entryAt(), row.entryRevision(), row.exitAt(),
                    row.exitRevision(), row.berth(), row.fetchedAt())));
            PortCallReader reader = new PortCallReader(index, List::of, clock::get);
            k.shipFanout.setPortCallSource(ShipLookups.portCalls(reader));
            FakeWsSession f = ready(k, "s");
            index.hold = new CountDownLatch(1);
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            k.msg(f, "{\"type\":\"ping\"}");
            await(() -> !ofType(f, "pong").isEmpty());
            await(() -> !ofType(f, "ship_selected").isEmpty());
            JsonNode sel = ofType(f, "ship_selected").getLast();
            assertThat(sel.path("static_source").asString()).isEqualTo("live");
            assertThat(sel.path("port_calls").path("status").asString()).isEqualTo(PortCallsInfo.ERROR);
            assertThat(sel.path("port_calls").path("call_sign").asString()).isEqualTo("D7AB");
            assertThat(types(f).indexOf("pong")).isLessThan(types(f).indexOf("ship_selected"));

            index.hold.countDown();
            await(() -> reader.cachedForStatic(ShipFanoutTest.stat(MMSI, "LIVE ONE", 70)) != null);
            k.shipFanout.refreshSelected();
            await(() -> ofType(f, "ship_selected").size() == 2);
            assertThat(ofType(f, "ship_selected").getLast().path("port_calls").path("status").asString()).isEqualTo(PortCallsInfo.OK);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 늦게 온 결과는 버린다(세대 확인): 조회 중에 다른 선박을 고르면 앞 선박의 결과는 보내지 않는다 — 지금 선택만. 선택을 풀어도 마찬가지. 버린 조회는 센다.
     */
    @Test void aResultForAnOlderSelection_isDropped() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = ShipLookups.boundedExecutor(2);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            ShipFanoutTest.publish(k, List.of(pos(MMSI, 35.1, 129.1, T), pos(OTHER, 35.2, 129.2, T), pos(THIRD, 35.3, 129.3, T)),
                    List.of(ShipFanoutTest.stat(OTHER, "LIVE OTHER", 70)));
            BlockingStored db = new BlockingStored();
            db.rows.put(MMSI, stored(MMSI, "D7SL"));
            db.rows.put(THIRD, stored(THIRD, "D7TH"));
            wire(k, lookups, 5_000, db, new AtomicLong(System.currentTimeMillis()));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");
            CountDownLatch first = new CountDownLatch(1);
            db.hold = first;
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            await(() -> db.reads.size() == 1);
            db.hold = null;
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"" + OTHER + "\"}"); // 메모리 정적 정보 — 바로 답한다
            await(() -> ofType(f, "ship_selected").size() == 1);
            assertThat(ofType(f, "ship_selected").getLast().path("mmsi").asString()).isEqualTo(OTHER);
            first.countDown(); // 앞 선택의 읽기가 이제 끝난다
            await(() -> k.meters.counter("wakeline_ws_ship_lookups_total", "outcome", "ok").count() == 1.0);
            await(s::idle);
            Thread.sleep(100);
            assertThat(ofType(f, "ship_selected")).as("the older selection's result is not sent").hasSize(1);
            assertThat(k.meters.counter("wakeline_ws_ship_lookup_dropped_total").count()).isGreaterThanOrEqualTo(1.0);

            // 선택 해제도 같다: 조회 중에 null → 결과가 와도 보내지 않는다
            CountDownLatch second = new CountDownLatch(1);
            db.hold = second;
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"" + THIRD + "\"}");
            await(() -> db.reads.contains(THIRD));
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":null}");
            await(s::idle);
            assertThat(s.shipLookup).isNull();
            second.countDown();
            await(() -> k.meters.counter("wakeline_ws_ship_lookups_total", "outcome", "ok").count() == 2.0);
            await(s::idle);
            Thread.sleep(100);
            assertThat(ofType(f, "ship_selected")).hasSize(1);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 실행기 포화: 스레드 · 대기열이 모두 차 있으면 그 읽기는 하지 않고 곧바로 읽지 못함(stored_unavailable)으로 답하고 센다(outcome=rejected) — 조용히 버리거나
     * 기다리지 않는다. 거절은 기억하지 않는다(다음 다시 계산이 다시 읽는다).
     */
    @Test void aSaturatedLookupExecutor_answersUnavailableAtOnce_andCountsIt() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor tiny = new ThreadPoolExecutor(1, 1, 60, TimeUnit.SECONDS, new ArrayBlockingQueue<>(1));
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            ShipFanoutTest.publish(k, List.of(pos(MMSI, 35.1, 129.1, T), pos(OTHER, 35.2, 129.2, T), pos(THIRD, 35.3, 129.3, T)), List.of());
            BlockingStored db = new BlockingStored();
            db.rows.put(THIRD, stored(THIRD, "D7TH"));
            db.hold = new CountDownLatch(1);
            wire(k, tiny, 5_000, db, new AtomicLong(System.currentTimeMillis()));
            k.shipFanout.setPortCallSource(ShipLookups.portCalls(new PortCallReader(new PortCallFixtures.FakeSource(), List::of, System::currentTimeMillis)));
            FakeWsSession a = ready(k, "a"), b = ready(k, "b"), c = ready(k, "c");
            k.msg(a, "{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");   // 스레드를 잡는다
            await(() -> db.reads.size() == 1);
            k.msg(b, "{\"type\":\"select_ship\",\"mmsi\":\"" + OTHER + "\"}");  // 대기열 하나를 채운다
            await(() -> tiny.getQueue().size() == 1);
            long t0 = System.nanoTime();
            k.msg(c, "{\"type\":\"select_ship\",\"mmsi\":\"" + THIRD + "\"}");  // 거절
            await(() -> !ofType(c, "ship_selected").isEmpty());
            assertThat((System.nanoTime() - t0) / 1_000_000).as("no wait on a full executor").isLessThan(1_000);
            JsonNode sel = ofType(c, "ship_selected").getLast();
            assertThat(sel.path("static_source").asString()).isEqualTo("stored_unavailable");
            assertThat(calls(sel)).isEqualTo(NOT_RECEIVED);
            assertThat(outcome(k, "rejected")).isEqualTo(1.0);
            assertThat(db.reads).doesNotContain(THIRD);

            db.hold.countDown();
            await(() -> !ofType(a, "ship_selected").isEmpty() && !ofType(b, "ship_selected").isEmpty());
            k.shipFanout.refreshSelected(); // 거절은 기억하지 않는다 — 다시 읽어 저장값을 보낸다
            await(() -> ofType(c, "ship_selected").size() == 2);
            assertThat(ofType(c, "ship_selected").getLast().path("static_source").asString()).isEqualTo("stored");
        } finally {
            tiny.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 같은 MMSI 를 여러 세션이 동시에 고르면 DB 는 한 번 읽는다(StoredStaticReader — 진행 중인 읽기를 함께 쓴다). 캐시 동안 다시 고르면 조회 실행기를 거치지
     * 않고 우편함에서 바로 답한다(조회 수가 늘지 않는다).
     */
    @Test void concurrentSelectionsOfOneShip_readTheDbOnce_andTheCacheAnswersInTheMailbox() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = ShipLookups.boundedExecutor(4);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            ShipFanoutTest.publish(k, List.of(pos(MMSI, 35.1, 129.1, T)), List.of());
            BlockingStored db = new BlockingStored();
            db.rows.put(MMSI, stored(MMSI, "D7SL"));
            db.hold = new CountDownLatch(1);
            wire(k, lookups, 5_000, db, new AtomicLong(System.currentTimeMillis()));
            FakeWsSession a = ready(k, "a"), b = ready(k, "b"), c = ready(k, "c");
            for (FakeWsSession f : List.of(a, b, c)) k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            await(() -> lookups.getActiveCount() == 3); // 세 조회가 모두 떠 있다(하나는 읽고 둘은 그 읽기를 기다린다)
            db.hold.countDown();
            await(() -> List.of(a, b, c).stream().allMatch(f -> !ofType(f, "ship_selected").isEmpty()));
            assertThat(db.reads).as("one DB read for three concurrent selections").hasSize(1);
            for (FakeWsSession f : List.of(a, b, c))
                assertThat(ofType(f, "ship_selected").getLast().path("static_source").asString()).isEqualTo("stored");
            double loads = outcome(k, "ok");

            FakeWsSession d = ready(k, "d");
            k.msg(d, "{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            await(() -> !ofType(d, "ship_selected").isEmpty());
            assertThat(ofType(d, "ship_selected").getLast().path("static").path("call_sign").asString()).isEqualTo("D7SL");
            assertThat(outcome(k, "ok")).as("answered from the cache — no lookup").isEqualTo(loads);
            assertThat(db.reads).hasSize(1);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    // ---- ShipLookups 단위 ----

    /** 읽는 쪽이 예외로 끝나면(읽는 쪽은 삼키게 돼 있다 — 결함) 읽지 못함으로 답하고 outcome=error 로 센다. 실행기가 닫혀 거절되면 rejected. */
    @Test void aThrowingSource_isAnsweredAsUnavailable_andCounted() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipLookups l = new ShipLookups(Runnable::run, 1_000, meters);
        l.setStored(ShipLookups.Source.of(m -> null, m -> { throw new IllegalStateException("defect"); }));
        CompletableFuture<ShipLookups.Resolved> f = l.load(MMSI, null);
        assertThat(f).isDone();
        assertThat(f.join().sel()).isEqualTo(ShipLookups.UNAVAILABLE);
        assertThat(f.join().calls()).as("no port-call reader wired").isNull();
        assertThat(meters.counter("wakeline_ws_ship_lookups_total", "outcome", "error").count()).isEqualTo(1.0);

        ShipLookups closed = new ShipLookups(r -> { throw new RejectedExecutionException("shut down"); }, 1_000, meters);
        closed.setStored(ShipLookups.Source.of(m -> null, m -> StoredStaticReader.Lookup.NONE));
        closed.setPortCalls(ShipLookups.Source.of(st -> null, st -> PortCallsInfo.noCallSign(PortCallsInfo.NOT_RECEIVED)));
        ShipLookups.Resolved r = closed.load(MMSI, null).join();
        assertThat(r.sel()).isEqualTo(ShipLookups.UNAVAILABLE);
        assertThat(r.calls()).as("unread and nothing cached for a null static").isNull();
        assertThat(meters.counter("wakeline_ws_ship_lookups_total", "outcome", "rejected").count()).isEqualTo(1.0);
        // 호출부호가 있는 정적 정보의 입출항 읽기가 거절되면 error(색인을 읽지 못함)
        ShipLookups.Resolved live = closed.load(MMSI, ShipFanoutTest.stat(MMSI, "LIVE", 70)).join();
        assertThat(live.sel().source()).isEqualTo("live");
        assertThat(live.calls()).isEqualTo(PortCallsInfo.error("D7AB"));
    }

    /** 캐시만으로 답하기: 읽는 쪽이 없으면 출처 모름(null) · 입출항 null, 캐시에 없으면 null(읽어야 한다). */
    @Test void cachedAnswers_withoutIo() {
        ShipLookups l = new ShipLookups(Runnable::run, 1_000, new SimpleMeterRegistry());
        assertThat(l.cached(MMSI, null)).isEqualTo(new ShipLookups.Resolved(ShipLookups.UNKNOWN, null));
        l.setStored(ShipLookups.Source.of(m -> null, m -> StoredStaticReader.Lookup.NONE));
        assertThat(l.cached(MMSI, null)).as("the stored part needs a read").isNull();
        l.setStored(ShipLookups.Source.memory(m -> StoredStaticReader.Lookup.NONE));
        l.setPortCalls(ShipLookups.Source.of(st -> st == null ? PortCallsInfo.noCallSign(PortCallsInfo.NOT_RECEIVED) : null, st -> null));
        assertThat(l.cached(MMSI, null).sel().source()).isEqualTo("none");
        assertThat(l.cached(MMSI, ShipFanoutTest.stat(MMSI, "LIVE", 70))).as("the port-call part needs a read").isNull();
        assertThat(ShipLookups.selected(null)).isSameAs(ShipLookups.UNKNOWN);
        assertThat(l.deadlineMs()).isEqualTo(1_000);
    }

    /** 운영 실행기: 스레드 수 · 대기열 상한 · 넘치면 거절 · 데몬 이름 · 대기열 길이 지표. 닫으면 멈춘다. */
    @Test void theBoundedExecutor_isSmallAndRejectsWhenFull() throws Exception {
        ThreadPoolExecutor ex = ShipLookups.boundedExecutor(3);
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        ShipLookups l = new ShipLookups(ex, 1_000, meters);
        assertThat(ex.getMaximumPoolSize()).isEqualTo(3);
        assertThat(ex.getQueue().remainingCapacity()).isEqualTo(ShipLookups.QUEUE_MAX);
        assertThat(ex.getRejectedExecutionHandler()).isInstanceOf(ThreadPoolExecutor.AbortPolicy.class);
        String[] name = new String[1];
        boolean[] daemon = new boolean[1];
        CountDownLatch ran = new CountDownLatch(1);
        ex.execute(() -> { name[0] = Thread.currentThread().getName(); daemon[0] = Thread.currentThread().isDaemon(); ran.countDown(); });
        assertThat(ran.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(name[0]).startsWith("ship-lookup-");
        assertThat(daemon[0]).isTrue();
        assertThat(meters.get("wakeline_ws_ship_lookup_queue").gauge().value()).isZero();
        l.close();
        assertThat(ex.isShutdown()).isTrue();
    }
}
