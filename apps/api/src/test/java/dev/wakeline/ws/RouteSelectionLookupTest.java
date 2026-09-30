package dev.wakeline.ws;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.route.RouteInfo;
import dev.wakeline.route.RouteInfoTest;
import dev.wakeline.route.RouteReader;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
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

import static dev.wakeline.ws.WsTestKit.ac;
import static dev.wakeline.ws.WsTestKit.ofType;
import static dev.wakeline.ws.WsTestKit.types;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 선택 항공기 노선(selected.route — 계약 v4 §A)의 Redis 읽기를 세션 우편함 밖에서(계약 v5 §G21 · ADR-025 개정 — §G18 이 남긴 일).
 * <p>관찰(코드, 고치기 전 — 이 파일의 첫 시험이 재현): WsHub.sendSelected 는 세션 우편함(SerialOutbox — 한 번에 하나)에서 돌며 RouteReader.forAircraft 로
 * Redis 를 그 자리에서 읽었다(명령 상한 spring.data.redis.timeout 3 s, 콜사인별 5 s 캐시). Redis 가 느리거나 닿지 않는 동안 선택 항공기 하나가 그 세션의
 * pong · 항공기 · 선박 diff · heartbeat 를 읽기 한 번마다 최대 약 3 s(연결을 새로 맺어야 하면 Lettuce 연결 상한이 더해진다) 붙잡고, 캐시가 지날 때마다(5 s)
 * 되풀이했다. 고치기 전 코드에서 첫 시험은 5 s 안에 pong · diff 를 받지 못했다(timed out).
 * <p>고침: 우편함은 캐시만 보고, 읽어야 하면 노선 조회 실행기(RouteLookups — 선박 조회와 같은 틀 SelectionLookups)에 맡긴 뒤 selected 를 곧바로 pending
 * ("노선 조회 중")으로 보낸다. 답은 늦어도 마감(운영: Redis 명령 상한)에 오고 — 읽지 못했으면 unavailable — SELECTED_ROUTE 작업이 다시 계산해 보낸다.
 * <p>이 시험은 운영처럼 따로 도는 실행기(가상 스레드 · 작은 스레드 풀)를 넣는다(WsTestKit 기본은 바로 실행 — 다른 시험의 순서를 그대로 두려고).
 */
class RouteSelectionLookupTest {
    static final String SYN736 = "wakeline:route:SYN736";

    static void await(BooleanSupplier cond) throws InterruptedException {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!cond.getAsBoolean()) {
            if (System.nanoTime() > end) throw new AssertionError("timed out");
            Thread.sleep(5);
        }
    }

    /** 가짜 Redis(수집기가 쓴 노선 캐시): hold 가 있으면 풀릴 때까지 GET 이 기다린다 — 느린 · 멈춘 Redis 를 흉내 낸다. 읽은 키를 적는다. */
    static final class BlockingRedis {
        final Map<String, String> values = new ConcurrentHashMap<>();
        final List<String> reads = new CopyOnWriteArrayList<>();
        volatile CountDownLatch hold;

        String get(String key) {
            reads.add(key);
            CountDownLatch h = hold;
            if (h != null) {
                try {
                    if (!h.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("not released");
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                }
            }
            return values.get(key);
        }
    }

    static AircraftState plane(String hex, String callsign, double lat, double lon, Instant seen) {
        return new AircraftState(hex, callsign, "HL0000", "A321", "A3", lat, lon, 36000, 450.0, 90.0, 0.0, false, null, seen, "adsb_fi", seen, 0, false);
    }

    /** 운영과 같은 모양의 노선 조회(실행기 · 마감)를 넣고, 가짜 Redis 를 읽는 RouteReader 를 단다. */
    static RouteReader wire(WsTestKit k, java.util.concurrent.Executor ex, long deadlineMs, BlockingRedis redis, AtomicLong clock) {
        k.hub.useRouteLookups(new RouteLookups(ex, deadlineMs, k.meters));
        RouteReader reader = new RouteReader(redis::get, RouteInfoTest.JSON, clock::get);
        k.hub.setRouteSource(RouteLookups.of(reader));
        return reader;
    }

    static double outcome(WsTestKit k, String outcome) {
        return k.meters.counter("wakeline_ws_route_lookups_total", "outcome", outcome).count();
    }

    static double dropped(WsTestKit k) { return k.meters.counter("wakeline_ws_route_lookup_dropped_total").count(); }

    static String route(JsonNode selected) { return selected.path("route").path("status").asString(); }

    static List<JsonNode> selectedOf(FakeWsSession f, String hex) {
        return ofType(f, "selected").stream().filter(n -> hex.equals(n.path("hex").asString())).toList();
    }

    static FakeWsSession ready(WsTestKit k, String id) throws Exception {
        FakeWsSession f = k.subscribed(id, "1.1.1." + Math.abs(id.hashCode() % 200));
        await(k.handler.session(id)::idle);
        return f;
    }

    /**
     * 재현을 뒤집음: Redis 읽기가 막힌 동안에도 그 세션의 pong · 항공기 diff · heartbeat 는 제때(각 1 s 안) 간다. selected 는 곧바로 pending("노선 조회
     * 중")으로 나가고, 읽기가 끝나면 found 로 다시 나간다. 같은 물음의 다시 계산(항공기 이동)은 읽기를 새로 올리지 않는다.
     */
    @Test void whileTheRouteReadWaitsOnRedis_theSessionsPongsAndDiffsStillFlow() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(2, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            redis.values.put(SYN736, RouteInfoTest.found("SYN736").toString());
            wire(k, lookups, 5_000, redis, new AtomicLong(1_000_000));
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 35, 129, 30000, now, "adsb_lol"), plane("bbb001", "SYN736", 36, 128, now));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");

            redis.hold = new CountDownLatch(1);
            long t0 = System.nanoTime();
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            await(() -> !ofType(f, "selected").isEmpty());
            assertThat((System.nanoTime() - t0) / 1_000_000).as("selected goes out at once").isLessThan(1_000);
            assertThat(route(ofType(f, "selected").getFirst())).as("not cached yet — the lookup is in progress").isEqualTo(RouteInfo.PENDING);
            assertThat(ofType(f, "selected").getFirst().path("route").path("callsign").asString()).isEqualTo("SYN736");
            await(() -> redis.reads.size() == 1); // 읽기가 Redis 를 기다린다

            for (int i = 1; i <= 3; i++) { // 세 번: pong · diff · heartbeat 모두 읽기를 기다리지 않는다(주기가 그대로)
                int pongs = ofType(f, "pong").size(), diffs = ofType(f, "diff").size(), pings = ofType(f, "ping").size();
                long ti = System.nanoTime();
                k.msg(f, "{\"type\":\"ping\"}");
                k.publish("region", now.plusSeconds(10L * i), ac("aaa001", 35 + 0.1 * i, 129, 30000, now.plusSeconds(10L * i), "adsb_lol"),
                        plane("bbb001", "SYN736", 36 + 0.1 * i, 128, now.plusSeconds(10L * i)));
                k.hub.heartbeat();
                await(() -> ofType(f, "pong").size() > pongs && ofType(f, "diff").size() > diffs && ofType(f, "ping").size() > pings);
                assertThat((System.nanoTime() - ti) / 1_000_000).as("round %d: pong, diff and heartbeat do not wait for the route read", i).isLessThan(1_000);
                k.msg(f, "{\"type\":\"pong\"}"); // heartbeat 에 답한다(답 없는 ping 수를 되돌린다)
            }
            assertThat(redis.reads).as("the moving aircraft (same question) starts no other read").hasSize(1);
            assertThat(s.routeLookup).isNotNull();
            assertThat(ofType(f, "selected")).allMatch(n -> RouteInfo.PENDING.equals(route(n)));

            redis.hold.countDown();
            await(() -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast())) && s.idle());
            JsonNode found = ofType(f, "selected").getLast();
            assertThat(found.path("route").path("origin").path("icao").asString()).isEqualTo("ZZAA");
            assertThat(found.path("state").path("lat").asDouble()).as("with the state current when the answer arrived").isEqualTo(36.3, org.assertj.core.data.Offset.offset(1e-9));
            List<String> order = types(f);
            assertThat(order.indexOf("pong")).isLessThan(order.lastIndexOf("selected"));
            assertThat(s.routeLookup).as("the read ended — the next recheck answers from the cache").isNull();
            assertThat(outcome(k, "ok")).isEqualTo(1.0);
            assertThat(k.meters.timer("wakeline_ws_route_lookup_seconds").count()).isEqualTo(1);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * Redis 가 끝내 답하지 않으면 마감에 unavailable("노선 조회 실패" — Redis 오류, 계약 v4 §A 에 이미 있는 값)로 답한다. 그동안 pong 은 간다. 읽기가 나중에
     * 끝나면 곧바로(다시 계산을 기다리지 않고) 실제 값을 보낸다 — 실패를 붙잡아 두지 않는다.
     */
    @Test void aRedisThatDoesNotAnswer_unavailableArrivesAtTheDeadline_andTheLateValueFollows() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(2, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            redis.values.put(SYN736, RouteInfoTest.found("SYN736").toString());
            RouteReader reader = wire(k, lookups, 300, redis, new AtomicLong(1_000_000));
            Instant now = Instant.now();
            k.publish("region", now, plane("bbb001", "SYN736", 36, 128, now));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");
            redis.hold = new CountDownLatch(1);
            long t0 = System.nanoTime();
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            k.msg(f, "{\"type\":\"ping\"}");
            await(() -> ofType(f, "selected").stream().anyMatch(n -> RouteInfo.UNAVAILABLE.equals(route(n))));
            long ms = (System.nanoTime() - t0) / 1_000_000;
            assertThat(ms).as("answered at the 300 ms deadline, not when Redis answers").isBetween(250L, 2_000L);
            assertThat(ofType(f, "selected").stream().map(RouteSelectionLookupTest::route).toList())
                    .containsExactly(RouteInfo.PENDING, RouteInfo.UNAVAILABLE);
            assertThat(types(f).indexOf("pong")).isLessThan(types(f).lastIndexOf("selected"));
            assertThat(outcome(k, "deadline")).isEqualTo(1.0);
            assertThat(s.routeLookup).as("answered, but the read still runs — the session keeps the lookup").isNotNull();

            redis.hold.countDown(); // 늦게 끝난 읽기가 캐시를 채우고, 끝남이 다시 계산을 부른다
            await(() -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast())) && s.idle());
            assertThat(reader.cached("SYN736")).isNotNull();
            assertThat(s.routeLookup).isNull();
            assertThat(redis.reads).hasSize(1);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 마감에 답한 뒤에도 그 읽기는 계속 돈다. 그동안 다시 계산(항공기 이동 넷)은 새 읽기를 올리지 않고 그 답(unavailable)과 최신 상태로 보낸다 — 읽기 하나 ·
     * 스레드 하나. 읽기가 끝나면 곧바로 실제 값.
     */
    @Test void afterADeadlineAnswer_rechecksWhileTheReadStillRuns_startNoOtherRead() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(4, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            redis.values.put(SYN736, RouteInfoTest.found("SYN736").toString());
            wire(k, lookups, 200, redis, new AtomicLong(1_000_000));
            Instant now = Instant.now();
            k.publish("region", now, plane("bbb001", "SYN736", 36, 128, now));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");
            redis.hold = new CountDownLatch(1);
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            await(() -> ofType(f, "selected").size() == 2); // pending → 마감(200 ms)의 unavailable
            for (int i = 1; i <= 4; i++) {
                k.publish("region", now.plusSeconds(10L * i), plane("bbb001", "SYN736", 36 + 0.01 * i, 128, now.plusSeconds(10L * i)));
                await(s::idle);
                Thread.sleep(50);
            }
            assertThat(redis.reads).as("one read of the callsign for one session").hasSize(1);
            assertThat(lookups.getActiveCount()).as("one lookup thread").isEqualTo(1);
            assertThat(lookups.getQueue()).isEmpty();
            List<JsonNode> sent = ofType(f, "selected");
            assertThat(sent).as("pending, the deadline answer, then one per aircraft move").hasSize(6);
            assertThat(route(sent.getLast())).isEqualTo(RouteInfo.UNAVAILABLE);
            assertThat(sent.getLast().path("state").path("lat").asDouble()).isEqualTo(36.04, org.assertj.core.data.Offset.offset(1e-9));
            assertThat(s.routeLookup).as("held until the read ends").isNotNull();

            redis.hold.countDown();
            await(() -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast())) && s.idle());
            assertThat(ofType(f, "selected")).hasSize(7);
            assertThat(redis.reads).hasSize(1);
            assertThat(s.routeLookup).isNull();
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 늦게 온 답은 버린다(세대 확인): 조회 중에 다른 항공기를 고르면 앞 항공기의 답은 보내지 않는다. 선택을 풀어도, 같은 항공기의 콜사인이 바뀌어도(물음이
     * 바뀜) 마찬가지다. 버린 조회는 센다.
     */
    @Test void anAnswerForAnOlderQuestion_isDropped() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(2, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            redis.values.put(SYN736, RouteInfoTest.found("SYN736").toString());
            redis.values.put("wakeline:route:SYN9", RouteInfoTest.cached("not_found", "SYN9").toString());
            RouteReader reader = wire(k, lookups, 5_000, redis, new AtomicLong(1_000_000));
            reader.forCallsign("SYN9"); // 다른 세션이 이미 읽어 캐시에 있다
            Instant now = Instant.now();
            k.publish("region", now, plane("bbb001", "SYN736", 36, 128, now), plane("bbb002", "SYN9", 37, 128, now));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");

            CountDownLatch first = new CountDownLatch(1);
            redis.hold = first;
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            await(() -> redis.reads.contains(SYN736));
            redis.hold = null;
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb002\"}"); // 캐시 — 바로 답한다
            await(() -> !selectedOf(f, "bbb002").isEmpty() && s.idle());
            assertThat(route(selectedOf(f, "bbb002").getLast())).isEqualTo(RouteInfo.NOT_FOUND);
            assertThat(dropped(k)).isEqualTo(1.0);
            first.countDown(); // 앞 선택의 읽기가 이제 끝난다
            await(() -> outcome(k, "ok") == 1.0);
            await(s::idle);
            Thread.sleep(100);
            assertThat(selectedOf(f, "bbb001")).as("only the pending answer — the older selection's result is not sent").hasSize(1);
            assertThat(route(ofType(f, "selected").getLast())).isEqualTo(RouteInfo.NOT_FOUND);

            // 선택 해제: 조회 중에 null → 답이 와도 보내지 않는다(답 작업이 조회를 버리고 센다)
            k.publish("region", now.plusSeconds(10), plane("bbb003", "SYN77", 38, 128, now));
            CountDownLatch second = new CountDownLatch(1);
            redis.hold = second;
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb003\"}");
            await(() -> redis.reads.contains("wakeline:route:SYN77") && s.idle());
            int before = ofType(f, "selected").size();
            k.msg(f, "{\"type\":\"select\",\"hex\":null}");
            second.countDown();
            await(() -> outcome(k, "ok") == 2.0);
            await(() -> s.idle() && s.routeLookup == null);
            Thread.sleep(100);
            assertThat(ofType(f, "selected")).hasSize(before);
            assertThat(dropped(k)).isEqualTo(2.0);

            // 콜사인이 바뀜(같은 항공기 — 물음이 바뀜): 앞 콜사인의 답은 쓰지 않고, 새 콜사인은 앞 읽기가 끝난 뒤 읽는다
            redis.values.put("wakeline:route:SYN56", RouteInfoTest.found("SYN56").toString());
            k.publish("region", now.plusSeconds(20), plane("bbb005", "SYN55", 39, 128, now.plusSeconds(20)));
            CountDownLatch third = new CountDownLatch(1);
            redis.hold = third;
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb005\"}");
            await(() -> redis.reads.contains("wakeline:route:SYN55") && s.idle());
            k.publish("region", now.plusSeconds(30), plane("bbb005", "SYN56", 39, 128, now.plusSeconds(30)));
            await(s::idle);
            JsonNode changed = ofType(f, "selected").getLast();
            assertThat(changed.path("route").path("callsign").asString()).isEqualTo("SYN56");
            assertThat(route(changed)).as("a new question — lookup in progress").isEqualTo(RouteInfo.PENDING);
            assertThat(redis.reads).as("the new callsign waits for the session's previous read").doesNotContain("wakeline:route:SYN56");
            assertThat(dropped(k)).isEqualTo(3.0);
            third.countDown();
            await(() -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast())) && s.idle());
            assertThat(ofType(f, "selected").getLast().path("route").path("callsign").asString()).isEqualTo("SYN56");
            assertThat(ofType(f, "selected").stream().filter(n -> "SYN55".equals(n.path("route").path("callsign").asString())).map(RouteSelectionLookupTest::route))
                    .as("the answer for the old callsign is never sent").containsOnly(RouteInfo.PENDING);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 실행기 포화: 스레드 · 대기열이 모두 차 있으면 그 읽기는 하지 않고 곧바로 unavailable 로 답하고 센다(outcome=rejected) — 조용히 버리거나 기다리지 않는다.
     * 거절은 기억하지 않는다(다음 다시 계산이 다시 읽는다).
     */
    @Test void aSaturatedLookupExecutor_answersUnavailableAtOnce_andCountsIt() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor tiny = new ThreadPoolExecutor(1, 1, 60, TimeUnit.SECONDS, new ArrayBlockingQueue<>(1));
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            redis.values.put("wakeline:route:SYN3", RouteInfoTest.found("SYN3").toString());
            redis.hold = new CountDownLatch(1);
            wire(k, tiny, 5_000, redis, new AtomicLong(1_000_000));
            Instant now = Instant.now();
            k.publish("region", now, plane("bbb001", "SYN1", 36, 128, now), plane("bbb002", "SYN2", 37, 128, now), plane("bbb003", "SYN3", 38, 128, now));
            FakeWsSession a = ready(k, "a"), b = ready(k, "b"), c = ready(k, "c");
            k.msg(a, "{\"type\":\"select\",\"hex\":\"bbb001\"}"); // 스레드를 잡는다
            await(() -> redis.reads.size() == 1);
            k.msg(b, "{\"type\":\"select\",\"hex\":\"bbb002\"}"); // 대기열 하나를 채운다
            await(() -> tiny.getQueue().size() == 1);
            long t0 = System.nanoTime();
            k.msg(c, "{\"type\":\"select\",\"hex\":\"bbb003\"}"); // 거절
            await(() -> !selectedOf(c, "bbb003").isEmpty());
            assertThat((System.nanoTime() - t0) / 1_000_000).as("no wait on a full executor").isLessThan(1_000);
            assertThat(selectedOf(c, "bbb003").stream().map(RouteSelectionLookupTest::route).toList())
                    .as("rejected — answered unavailable at once, never shown as pending").containsExactly(RouteInfo.UNAVAILABLE);
            assertThat(outcome(k, "rejected")).isEqualTo(1.0);
            assertThat(redis.reads).doesNotContain("wakeline:route:SYN3");

            redis.hold.countDown();
            await(() -> tiny.getActiveCount() == 0 && tiny.getQueue().isEmpty());
            k.publish("region", now.plusSeconds(10), plane("bbb003", "SYN3", 38.1, 128, now.plusSeconds(10))); // 거절은 기억하지 않는다 — 다시 읽는다
            await(() -> RouteInfo.FOUND.equals(route(selectedOf(c, "bbb003").getLast())));
            assertThat(redis.reads).contains("wakeline:route:SYN3");
        } finally {
            tiny.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 같은 항공기(콜사인)를 여러 세션이 동시에 고르면 Redis 는 한 번 읽고 조회 스레드도 하나다(RouteReader.loadAsync — 진행 중인 읽기의 future 에 이어
     * 붙는다). 캐시 동안 다시 고르면 조회 실행기를 거치지 않고 우편함에서 바로 답한다.
     */
    @Test void concurrentSelectionsOfOneAircraft_readRedisOnce_andTheCacheAnswersInTheMailbox() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(4, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            redis.values.put(SYN736, RouteInfoTest.found("SYN736").toString());
            redis.hold = new CountDownLatch(1);
            wire(k, lookups, 5_000, redis, new AtomicLong(1_000_000));
            Instant now = Instant.now();
            k.publish("region", now, plane("bbb001", "SYN736", 36, 128, now));
            FakeWsSession a = ready(k, "a"), b = ready(k, "b"), c = ready(k, "c");
            for (FakeWsSession f : List.of(a, b, c)) k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            for (String id : List.of("a", "b", "c")) await(() -> k.handler.session(id).routeLookup != null && k.handler.session(id).idle());
            await(() -> redis.reads.size() == 1);
            assertThat(lookups.getActiveCount()).as("one lookup thread for one Redis read").isEqualTo(1);
            assertThat(lookups.getQueue()).isEmpty();
            redis.hold.countDown();
            await(() -> List.of(a, b, c).stream().allMatch(f -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast()))));
            assertThat(redis.reads).as("one Redis read for three concurrent selections").hasSize(1);
            double loads = outcome(k, "ok");

            FakeWsSession d = ready(k, "d");
            k.msg(d, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            await(() -> !ofType(d, "selected").isEmpty());
            assertThat(ofType(d, "selected")).as("answered from the cache — no pending step").hasSize(1);
            assertThat(route(ofType(d, "selected").getLast())).isEqualTo(RouteInfo.FOUND);
            assertThat(outcome(k, "ok")).as("no lookup").isEqualTo(loads);
            assertThat(redis.reads).hasSize(1);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 한 세션이 읽기가 막힌 동안 항공기를 연달아 바꾼다: 다음 물음의 읽기는 앞 읽기가 끝난 뒤 시작하고 그사이 또 바뀐 물음은 읽지 않는다(outcome=skipped) —
     * 실행기에는 이 세션의 작업이 하나뿐. 바뀐 선택은 pending 만 보이고 그 답은 보내지 않는다. 앞 읽기가 끝나면 지금 선택만 읽는다.
     */
    @Test void oneSessionSwitchingAircraftWhileReadsWait_holdsOneLookupTaskAtMost() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(4, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            redis.values.put("wakeline:route:SYN4", RouteInfoTest.found("SYN4").toString());
            redis.hold = new CountDownLatch(1);
            // 마감 1 s: 네 번 바꾸기(수 ms)가 앞 물음의 마감보다 먼저 끝나게
            wire(k, lookups, 1_000, redis, new AtomicLong(1_000_000));
            Instant now = Instant.now();
            k.publish("region", now, plane("bbb001", "SYN1", 36, 128, now), plane("bbb002", "SYN2", 37, 128, now),
                    plane("bbb003", "SYN3", 38, 128, now), plane("bbb004", "SYN4", 39, 128, now));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");
            for (String hex : List.of("bbb001", "bbb002", "bbb003", "bbb004")) {
                k.msg(f, "{\"type\":\"select\",\"hex\":\"" + hex + "\"}");
                await(s::idle);
            }
            await(() -> selectedOf(f, "bbb004").stream().anyMatch(n -> RouteInfo.UNAVAILABLE.equals(route(n)))); // 지금 선택은 마감에 답한다
            // 넷 모두 마감에 답이 정해진다(조회 하나에 결과 하나 — 버린 셋의 답은 보내지 않는다)
            await(() -> outcome(k, "deadline") == 4.0);
            assertThat(redis.reads).as("only the first read runs; the later questions wait for it").containsExactly("wakeline:route:SYN1");
            assertThat(lookups.getActiveCount() + lookups.getQueue().size()).as("one executor task for this session").isEqualTo(1);
            for (String hex : List.of("bbb001", "bbb002", "bbb003"))
                assertThat(selectedOf(f, hex).stream().map(RouteSelectionLookupTest::route).toList()).as(hex).containsExactly(RouteInfo.PENDING);

            redis.hold.countDown(); // 앞 읽기가 끝나면 지금 선택만 읽는다(둘째 · 셋째는 건너뛴다)
            await(() -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast())) && s.idle());
            assertThat(ofType(f, "selected").getLast().path("hex").asString()).isEqualTo("bbb004");
            assertThat(redis.reads).as("the replaced selections were not read").containsExactly("wakeline:route:SYN1", "wakeline:route:SYN4");
            assertThat(outcome(k, "skipped")).as("answered at the deadline first — one outcome per lookup").isZero();
            assertThat(dropped(k)).as("three replaced selections, never answered").isEqualTo(3.0);
            assertThat(s.routeLookup).isNull();
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /**
     * 5 s 캐시가 지나 다시 읽는 동안(같은 항공기 · 같은 콜사인)은 이미 보낸 값을 그대로 둔다 — "조회 중" 으로 깜박이지 않는다. 값이 그대로면 답이 와도 보내지
     * 않고, 바뀌었으면(pending → found) 답이 올 때 보낸다.
     */
    @Test void aRereadAfterTheCacheExpires_keepsTheShownRoute_untilTheAnswerChangesIt() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(2, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            AtomicLong clock = new AtomicLong(1_000_000);
            wire(k, lookups, 5_000, redis, clock);
            Instant now = Instant.now();
            k.publish("region", now, plane("bbb001", "SYN736", 36, 128, now));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            await(() -> ofType(f, "selected").size() == 1 && s.idle() && s.routeLookup == null); // 캐시 없음(수집기가 아직) → pending, 곧 읽기가 pending 으로 끝남
            assertThat(route(ofType(f, "selected").getLast())).isEqualTo(RouteInfo.PENDING);

            clock.addAndGet(RouteReader.TTL_MS);
            redis.hold = new CountDownLatch(1);
            k.publish("region", now.plusSeconds(10), plane("bbb001", "SYN736", 36.1, 128, now.plusSeconds(10))); // 캐시가 지남 → 다시 읽는다
            await(() -> redis.reads.size() == 2 && s.idle());
            assertThat(route(ofType(f, "selected").getLast())).as("the move is sent with the route already shown").isEqualTo(RouteInfo.PENDING);
            redis.values.put(SYN736, RouteInfoTest.found("SYN736").toString());
            redis.hold.countDown();
            await(() -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast())) && s.idle());
            int n = ofType(f, "selected").size();

            clock.addAndGet(RouteReader.TTL_MS);
            redis.hold = new CountDownLatch(1);
            k.publish("region", now.plusSeconds(20), plane("bbb001", "SYN736", 36.2, 128, now.plusSeconds(20)));
            await(() -> redis.reads.size() == 3 && s.idle());
            assertThat(ofType(f, "selected")).hasSize(n + 1);
            assertThat(route(ofType(f, "selected").getLast())).as("found stays while it is read again — no flicker to pending").isEqualTo(RouteInfo.FOUND);
            redis.hold.countDown();
            await(() -> s.routeLookup == null && s.idle());
            Thread.sleep(50);
            assertThat(ofType(f, "selected")).as("the same value — nothing more to send").hasSize(n + 1);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    /** 세션이 닫히면 답을 보낼 곳이 없다 — 답은 보내지 않고 센다(dropped). 닫힌 세션의 우편함은 작업을 받지 않는다. */
    @Test void aSessionClosedBeforeTheAnswer_countsTheLookupAsDropped() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(2, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            redis.values.put(SYN736, RouteInfoTest.found("SYN736").toString());
            redis.hold = new CountDownLatch(1);
            wire(k, lookups, 5_000, redis, new AtomicLong(1_000_000));
            Instant now = Instant.now();
            k.publish("region", now, plane("bbb001", "SYN736", 36, 128, now));
            FakeWsSession f = ready(k, "s");
            WsSession s = k.handler.session("s");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"bbb001\"}");
            await(() -> redis.reads.size() == 1 && s.idle());
            k.handler.afterConnectionClosed(f, org.springframework.web.socket.CloseStatus.GOING_AWAY);
            int sent = f.sent.size();
            redis.hold.countDown();
            await(() -> dropped(k) == 1.0);
            assertThat(f.sent).hasSize(sent);
        } finally {
            lookups.shutdownNow();
            pool.shutdownNow();
        }
    }

    // ---- RouteLookups 단위 ----

    static final BooleanSupplier WANTED = () -> true;

    /** 읽는 쪽이 예외로 끝나면(읽는 쪽은 삼키게 돼 있다 — 결함) unavailable 로 답하고 outcome=error. 실행기가 닫혀 거절되면 rejected. */
    @Test void aThrowingOrRejectingSource_isAnsweredAsUnavailable_andCounted() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        RouteLookups l = new RouteLookups(Runnable::run, 1_000, meters);
        assertThat(l.cached("SYN1")).as("no source — nothing cached").isNull();
        l.setSource(SelectionLookups.Source.blocking(cs -> null, cs -> { throw new IllegalStateException("defect"); }));
        SelectionLookups.Flight<RouteInfo> f = l.load("SYN1", null, WANTED);
        assertThat(f.answer()).isDone();
        assertThat(f.settled()).isDone();
        assertThat(f.answer().join()).isEqualTo(RouteInfo.unavailable("SYN1"));
        assertThat(meters.counter("wakeline_ws_route_lookups_total", "outcome", "error").count()).isEqualTo(1.0);

        RouteLookups closed = new RouteLookups(r -> { throw new RejectedExecutionException("shut down"); }, 1_000, meters);
        closed.setSource(SelectionLookups.Source.blocking(cs -> null, RouteInfo::pending));
        assertThat(closed.load("SYN2", null, WANTED).answer().join()).isEqualTo(RouteInfo.unavailable("SYN2"));
        // 읽는 쪽이 거절을 future 로 알려도(운영 SingleFlight) 같다
        RouteLookups async = new RouteLookups(Runnable::run, 1_000, meters);
        async.setSource(SelectionLookups.Source.of(cs -> null, (cs, ex) -> CompletableFuture.failedFuture(new RejectedExecutionException("full"))));
        assertThat(async.load("SYN3", null, WANTED).answer().join()).isEqualTo(RouteInfo.unavailable("SYN3"));
        assertThat(meters.counter("wakeline_ws_route_lookups_total", "outcome", "rejected").count()).isEqualTo(2.0);
    }

    /** 앞 조회(after)가 끝나기 전에는 읽지 않는다. 그사이 버려지면(wanted false) 읽지 않고 끝낸다(skipped). 기다리는 사이 캐시가 채워졌으면 읽지 않고 그 값. */
    @Test void aLookupWaitsForTheSessionsPreviousRead_skipsWhenNoLongerWanted_andUsesACacheFilledMeanwhile() {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        List<String> reads = new CopyOnWriteArrayList<>();
        Map<String, RouteInfo> cache = new ConcurrentHashMap<>();
        RouteLookups l = new RouteLookups(Runnable::run, 60_000, meters);
        l.setSource(SelectionLookups.Source.blocking(cache::get, cs -> { reads.add(cs); return RouteInfo.pending(cs); }));
        CompletableFuture<Void> previous = new CompletableFuture<>();
        SelectionLookups.Flight<RouteInfo> waiting = l.load("SYN1", previous, WANTED);
        boolean[] wanted = {true};
        SelectionLookups.Flight<RouteInfo> dropped = l.load("SYN2", waiting.settled(), () -> wanted[0]);
        SelectionLookups.Flight<RouteInfo> filled = l.load("SYN3", dropped.settled(), WANTED);
        assertThat(reads).as("nothing is read before the previous read ends").isEmpty();
        wanted[0] = false;
        cache.put("SYN3", RouteInfo.unavailable("SYN3"));
        previous.complete(null);
        assertThat(reads).containsExactly("SYN1");
        assertThat(waiting.answer().join()).isEqualTo(RouteInfo.pending("SYN1"));
        assertThat(dropped.answer().join()).isEqualTo(RouteInfo.unavailable("SYN2"));
        assertThat(filled.answer().join()).as("filled by another read meanwhile — not read again").isEqualTo(RouteInfo.unavailable("SYN3"));
        assertThat(meters.counter("wakeline_ws_route_lookups_total", "outcome", "skipped").count()).isEqualTo(1.0);
        assertThat(meters.counter("wakeline_ws_route_lookups_total", "outcome", "ok").count()).isEqualTo(2.0);
    }

    /**
     * 답의 마감은 Redis 명령 상한(RedisConfig.COMMAND_TIMEOUT — spring.data.redis.timeout, 기본 3s)에서 온다 — 해석할 수 없거나 0 이하(상한 없음)면 기동하지
     * 않는다. application.yml 의 값은 3 s.
     */
    @Test void theDeadlineComesFromTheRedisCommandTimeout() throws Exception {
        assertThat(RouteLookups.deadlineMs(dev.wakeline.config.RedisConfig.commandTimeout("3s"))).as("as Boot binds a Duration property").isEqualTo(3_000);
        assertThat(dev.wakeline.config.RedisConfig.commandTimeout("2500")).as("no unit = ms, like Boot").isEqualTo(Duration.ofMillis(2_500));
        for (String bad : new String[] {"${spring.data.redis.timeout}", "0s", "-1s"})
            assertThatThrownBy(() -> dev.wakeline.config.RedisConfig.commandTimeout(bad)).as(bad).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("spring.data.redis.timeout");
        assertThat(RouteLookups.deadlineMs(Duration.ofSeconds(3))).isEqualTo(3_000);
        assertThat(RouteLookups.deadlineMs(Duration.ofMillis(1_500))).isEqualTo(1_500);
        for (Duration bad : new Duration[] {null, Duration.ZERO, Duration.ofSeconds(-1)})
            assertThatThrownBy(() -> RouteLookups.deadlineMs(bad)).as(String.valueOf(bad)).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("spring.data.redis.timeout");
        String yml = new String(getClass().getResourceAsStream("/application.yml").readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertThat(yml).as("the configured Redis command timeout the docs and the web title state").containsPattern("(?m)^      timeout: 3s$");
        assertThat(new RouteLookups(Runnable::run, 3_000, new SimpleMeterRegistry()).deadlineMs()).isEqualTo(3_000);
    }

    /**
     * 리뷰(2026-09-30 · lane-route #5): Redis 명령 상한을 읽는 곳은 모두 같은 설정 식(RedisConfig.COMMAND_TIMEOUT — 기본값 3s 포함)을 쓴다 — 기본 연결의 Lettuce
     * 명령 상한(RedisConfig) · WS 노선 답의 마감(WsHub 운영 생성자) · REST 노선 기다림(RouteReader 운영 생성자). 고치기 전 WsHub 는 기본값 없는
     * "${spring.data.redis.timeout}" 을 읽어, 그 속성이 없는 구성(Redis 는 기본 3 s 로 도는)에서 허브가 기동하지 못했다.
     */
    @Test void everyReaderOfTheRedisCommandTimeout_usesTheOneConfigExpression() throws Exception {
        assertThat(valueOf(WsHub.class.getConstructors())).as("WsHub").isEqualTo(dev.wakeline.config.RedisConfig.COMMAND_TIMEOUT);
        assertThat(valueOf(RouteReader.class.getConstructors())).as("RouteReader").isEqualTo(dev.wakeline.config.RedisConfig.COMMAND_TIMEOUT);
        java.lang.reflect.Method factory = dev.wakeline.config.RedisConfig.class.getDeclaredMethod("redisConnectionFactory",
                String.class, int.class, String.class, String.class, String.class);
        assertThat(java.util.Arrays.stream(factory.getParameters()).map(p -> p.getAnnotation(org.springframework.beans.factory.annotation.Value.class))
                .filter(java.util.Objects::nonNull).map(org.springframework.beans.factory.annotation.Value::value).toList())
                .as("RedisConfig — the Lettuce command timeout").contains(dev.wakeline.config.RedisConfig.COMMAND_TIMEOUT);
        assertThat(dev.wakeline.config.RedisConfig.COMMAND_TIMEOUT).isEqualTo("${spring.data.redis.timeout:3s}");
    }

    /** @Autowired 생성자에서 spring.data.redis.timeout 을 읽는 @Value 의 식. */
    static String valueOf(java.lang.reflect.Constructor<?>[] ctors) {
        for (java.lang.reflect.Constructor<?> c : ctors) {
            if (!c.isAnnotationPresent(org.springframework.beans.factory.annotation.Autowired.class)) continue;
            for (java.lang.reflect.Parameter p : c.getParameters()) {
                org.springframework.beans.factory.annotation.Value v = p.getAnnotation(org.springframework.beans.factory.annotation.Value.class);
                if (v != null && v.value().contains("spring.data.redis.timeout")) return v.value();
            }
        }
        return null;
    }

    /** 운영 실행기: 스레드 수 · 대기열 상한 · 넘치면 거절 · 데몬 이름 · 대기열 길이 지표. 닫으면 멈춘다. 선박 조회 실행기와 따로다(이름 · 지표). */
    @Test void theBoundedExecutor_isSmall_separateFromTheShipLookups_andRejectsWhenFull() throws Exception {
        ThreadPoolExecutor ex = RouteLookups.boundedExecutor(RouteLookups.THREADS, SelectionLookups.queueFor(200));
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        RouteLookups l = new RouteLookups(ex, 3_000, meters);
        assertThat(ex.getMaximumPoolSize()).isEqualTo(RouteLookups.THREADS);
        assertThat(ex.getQueue().remainingCapacity()).isEqualTo(SelectionLookups.DEFAULT_QUEUE);
        assertThat(ex.getRejectedExecutionHandler()).isInstanceOf(ThreadPoolExecutor.AbortPolicy.class);
        String[] name = new String[1];
        CountDownLatch ran = new CountDownLatch(1);
        ex.execute(() -> { name[0] = Thread.currentThread().getName(); ran.countDown(); });
        assertThat(ran.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(name[0]).startsWith("route-lookup-");
        assertThat(meters.get("wakeline_ws_route_lookup_queue").gauge().value()).isZero();
        assertThat(meters.find("wakeline_ws_ship_lookup_queue").gauge()).as("its own metrics").isNull();
        l.close();
        assertThat(ex.isShutdown()).isTrue();
    }

    /** 운영 배선(운영 생성자가 부른다): 노선 조회 실행기(route-lookup-N) · 마감 = spring.data.redis.timeout. 멈추면(stop) 실행기도 닫는다 — 그 뒤의 조회는 거절. */
    @Test void theProductionWiring_usesTheRedisTimeoutAndItsOwnExecutor() {
        try (WsTestKit k = new WsTestKit()) {
            RouteReader reader = new RouteReader(key -> null, RouteInfoTest.JSON, System::currentTimeMillis);
            assertThatThrownBy(() -> k.hub.useRouteReader(reader, Duration.ZERO)).isInstanceOf(IllegalStateException.class);
            k.hub.useRouteReader(reader, Duration.ofMillis(2_500));
            RouteLookups l = k.hub.routeLookups();
            assertThat(l.deadlineMs()).isEqualTo(2_500);
            assertThat(l.enabled()).isTrue();
            assertThat(k.meters.find("wakeline_ws_route_lookup_queue").gauge()).as("a bounded executor").isNotNull();
            k.hub.stop();
            assertThat(l.load("SYN1", null, WANTED).answer().join()).isEqualTo(RouteInfo.unavailable("SYN1"));
            assertThat(outcome(k, "rejected")).isEqualTo(1.0);
        }
    }
}
