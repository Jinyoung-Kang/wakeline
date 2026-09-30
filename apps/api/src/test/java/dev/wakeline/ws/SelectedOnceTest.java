package dev.wakeline.ws;

import dev.wakeline.domain.AircraftState;
import dev.wakeline.route.RouteInfo;
import dev.wakeline.route.RouteInfoTest;
import dev.wakeline.route.RouteReader;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.atomic.AtomicLong;

import static dev.wakeline.ws.RouteSelectionLookupTest.BlockingRedis;
import static dev.wakeline.ws.RouteSelectionLookupTest.await;
import static dev.wakeline.ws.RouteSelectionLookupTest.outcome;
import static dev.wakeline.ws.RouteSelectionLookupTest.plane;
import static dev.wakeline.ws.RouteSelectionLookupTest.route;
import static dev.wakeline.ws.RouteSelectionLookupTest.selectedOf;
import static dev.wakeline.ws.RouteSelectionLookupTest.wire;
import static dev.wakeline.ws.WsTestKit.ofType;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 선택 하나에 같은 내용의 selected 를 두 번 보내지 않는다(사용자 보고 2026-09-30 "항공기를 고르면 '노선 조회 중' 메시지가 같은 내용으로 두 번 나갑니다" —
 * 계약 v5 §G21 · ADR-025 개정 뒤의 실서비스 확인 #68: APJ705 선택에 selected 두 건이 모두 +0.07 s 에 route pending, 11.0 s 에 found).
 * <p>원인(코드 — 이 파일의 앞 세 시험이 고치기 전 코드에서 재현): 핸들러는 select 를 받으면 selectedHex 를 먼저 쓰고 SELECTED 작업을 예약한다. 그 세션
 * 우편함에 이미 초기 세트(바로 앞의 subscribe — 스크립트 · 다시 연결한 웹이 한꺼번에 보낸다)나 팬아웃(스냅샷 · 수요) 작업이 있으면, 그 작업이 먼저 돌며 새
 * selectedHex 를 보고 selected 를 보낸다(이 세션에 보낸 selected 가 없거나 다른 항공기라 '바뀜' — 노선은 pending, 조회 시작). 뒤이은 SELECTED 작업은 늘(ALWAYS)
 * 다시 보냈다 — 노선 읽기가 곧바로 '아직 없음'(pending)으로 끝나 같은 내용이다. 반대로 SELECTED 작업이 focus 관측 작업과 합쳐지면(같은 종류 — 단일 비행)
 * select 의 답이 '같은 관측' 규칙에 걸려 나가지 않을 수 있었다(해제 뒤 같은 항공기를 다시 고를 때 — 웹은 해제 때 selected 를 지운다).
 * <p>고침: select 는 '답을 한 번 보낼 것' 표시(WsSession.selectedForce — 선박의 shipSelectedForce 와 같은 방식)를 올리고, selected 를 계산하는 어느 작업이든
 * 처음 보는 쪽이 그 답을 보낸다. 그 밖에는 이 세션에 마지막으로 보낸 selected 와 글자까지 같으면 보내지 않는다(초기 세트의 force — resume · 재동기 — 만 예외).
 * <p>시험은 세션 우편함 실행기를 잠시 붙잡아(GatedExecutor) 운영에서 가상 스레드가 늦게 돌 때의 순서 — 메시지를 먼저 다 받고 우편함 작업이 뒤에 도는 순서 —
 * 를 고정한다.
 */
class SelectedOnceTest {
    static final String APJ705 = "wakeline:route:APJ705";

    /** 세션 우편함 실행기: hold 동안 받은 작업을 붙잡아 두었다가 release 때 가상 스레드에서 돌린다. */
    static final class GatedExecutor implements Executor {
        private final ExecutorService run = Executors.newVirtualThreadPerTaskExecutor();
        private final List<Runnable> held = new ArrayList<>();
        private boolean open = true;

        @Override public synchronized void execute(Runnable r) {
            if (open) run.execute(r);
            else held.add(r);
        }

        synchronized void hold() { open = false; }

        synchronized void release() {
            open = true;
            held.forEach(run::execute);
            held.clear();
        }

        void shutdown() { run.shutdownNow(); }
    }

    static int selected(FakeWsSession f) { return ofType(f, "selected").size(); }

    /** 우편함 · 노선 조회가 모두 끝나고 더 보낼 것이 없을 때까지(늦은 작업이 있으면 잡히게 조금 더 기다린다). */
    static void settle(WsSession s) throws InterruptedException {
        await(() -> s.idle() && s.routeLookup == null);
        Thread.sleep(50);
        await(s::idle);
    }

    /**
     * 실서비스 재현(#68 의 순서): hello · subscribe · select 를 한꺼번에 받고 우편함이 뒤에 돈다 — 초기 세트가 먼저 selected(pending)를 보내고, 수집기가
     * 아직 쓰지 않은 노선의 Redis 읽기는 곧바로 pending 으로 끝난다. selected 는 한 건이어야 한다(고치기 전: 같은 pending 두 건). 실제 변화(found)는 그대로
     * 나간다.
     */
    @Test void aSelectQueuedBehindTheInitialSet_sendsOnePendingSelected_andTheFoundAnswerStillFollows() throws Exception {
        GatedExecutor pool = new GatedExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(2, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis(); // 수집기가 아직 쓰지 않음 — GET 은 곧바로 null(pending)
            AtomicLong clock = new AtomicLong(1_000_000);
            wire(k, lookups, 5_000, redis, clock);
            Instant now = Instant.now();
            AircraftState apj = plane("872841", "APJ705", 35.5, 129.5, now);
            k.publish("region", now, apj);

            pool.hold();
            FakeWsSession f = k.connect("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"hello\",\"proto\":1}");
            k.msg(f, "{\"type\":\"subscribe\",\"bbox\":[124,33,132,39],\"zoom\":7}");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"872841\"}");
            WsSession s = k.handler.session("s");
            pool.release();
            await(() -> outcome(k, "ok") == 1.0);
            settle(s);

            List<JsonNode> sel = selectedOf(f, "872841");
            assertThat(sel).as("one select, one selected — not the same pending twice").hasSize(1);
            assertThat(route(sel.getFirst())).isEqualTo(RouteInfo.PENDING);
            assertThat(sel.getFirst().path("state").path("callsign").asString()).isEqualTo("APJ705");
            assertThat(redis.reads).as("one Redis read").hasSize(1);
            assertThat(outcome(k, "ok")).isEqualTo(1.0);

            // 수집기가 노선을 쓴 뒤 캐시(5 s)가 지나 다시 읽으면 found — 실제 변화는 그대로 나간다
            redis.values.put(APJ705, RouteInfoTest.found("APJ705").toString());
            clock.addAndGet(RouteReader.TTL_MS);
            k.publish("region", now.plusSeconds(10), apj);
            await(() -> RouteInfo.FOUND.equals(route(ofType(f, "selected").getLast())));
            settle(s);
            assertThat(selectedOf(f, "872841")).extracting(RouteSelectionLookupTest::route).containsExactly(RouteInfo.PENDING, RouteInfo.FOUND);
            assertThat(outcome(k, "ok")).isEqualTo(2.0);
        } finally {
            lookups.shutdownNow();
            pool.shutdown();
        }
    }

    /**
     * 브라우저의 순서: 구독한 세션에 스냅샷이 와서 팬아웃이 우편함에 있는 동안 항공기를 고른다 — 팬아웃이 selected 를 먼저 보낸다. 한 건이어야 한다(고치기 전: 두 건,
     * 같은 내용). 그 selected 는 팬아웃 때의 상태(새 위치)를 싣는다.
     */
    @Test void aSelectQueuedBehindAFanout_sendsOneSelected() throws Exception {
        GatedExecutor pool = new GatedExecutor();
        ThreadPoolExecutor lookups = RouteLookups.boundedExecutor(2, SelectionLookups.DEFAULT_QUEUE);
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            BlockingRedis redis = new BlockingRedis();
            wire(k, lookups, 5_000, redis, new AtomicLong(1_000_000));
            Instant now = Instant.now();
            k.publish("region", now, plane("872841", "APJ705", 35.5, 129.5, now));
            FakeWsSession f = RouteSelectionLookupTest.ready(k, "s");
            WsSession s = k.handler.session("s");

            pool.hold();
            k.publish("region", now.plusSeconds(10), plane("872841", "APJ705", 35.6, 129.5, now.plusSeconds(10)));
            k.msg(f, "{\"type\":\"select\",\"hex\":\"872841\"}");
            pool.release();
            await(() -> outcome(k, "ok") == 1.0);
            settle(s);

            List<JsonNode> sel = selectedOf(f, "872841");
            assertThat(sel).as("one select, one selected").hasSize(1);
            assertThat(route(sel.getFirst())).isEqualTo(RouteInfo.PENDING);
            assertThat(sel.getFirst().path("state").path("lat").asDouble()).isEqualTo(35.6);
        } finally {
            lookups.shutdownNow();
            pool.shutdown();
        }
    }

    /**
     * select 는 늘 답을 받는다 — 앞에 있던 작업과 합쳐져도: 해제한 뒤 같은 항공기를 다시 고르는 동안(웹은 해제 때 selected 를 지운다) focus 관측 작업
     * (SELECTED — 같은 종류라 select 의 작업이 합쳐진다)과 팬아웃이 우편함에 있다. 두 작업 모두 '같은 상태'라 보내지 않았다(고치기 전: 답 없음). 이제 먼저 도는
     * 작업이 답을 보내고, 뒤의 작업은 같은 내용을 다시 보내지 않는다.
     */
    @Test void aReselectCoalescedWithAFocusObservation_stillGetsExactlyOneReply() throws Exception {
        GatedExecutor pool = new GatedExecutor();
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            Instant now = Instant.now();
            k.publish("region", now, plane("872841", "APJ705", 35.5, 129.5, now));
            FakeWsSession f = RouteSelectionLookupTest.ready(k, "s");
            WsSession s = k.handler.session("s");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"872841\"}");
            await(() -> selected(f) == 1 && s.idle());

            pool.hold();
            // 같은 보고(seen_at 같음)를 focus 가 실어 왔다 — 병합 뷰는 region 의 그 상태 그대로(같으면 region 이 이긴다)
            k.publishFocus(now.plusSeconds(1), new AircraftState("872841", "APJ705", "HL0000", "A321", "A3", 35.5, 129.5, 36000, 450.0, 90.0, 0.0,
                    false, null, now, "adsb_fi", now.plusSeconds(1), 0, false));
            k.msg(f, "{\"type\":\"select\",\"hex\":null}");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"872841\"}");
            pool.release();
            settle(s);

            assertThat(selected(f)).as("the re-select is answered once").isEqualTo(2);
            assertThat(ofType(f, "selected").getLast().path("hex").asString()).isEqualTo("872841");
        } finally {
            pool.shutdown();
        }
    }

    /**
     * 선택 해제 뒤 곧바로(팬아웃 없이) 같은 항공기를 다시 고르면 — 웹은 해제 때 selected 를 지웠다 — 같은 내용이어도 답을 보낸다. 같은 항공기를 연달아 고를
     * 때도 select 마다 답 하나(계약 §1 "바로 한 번").
     */
    @Test void everySelectIsAnsweredOnce_evenWithTheSameContent() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, plane("872841", "APJ705", 35.5, 129.5, now));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"872841\"}");
            k.msg(f, "{\"type\":\"select\",\"hex\":null}");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"872841\"}");
            assertThat(selected(f)).isEqualTo(2);
            k.msg(f, "{\"type\":\"select\",\"hex\":\"872841\"}");
            assertThat(selected(f)).isEqualTo(3);
            k.publish("region", now.plusSeconds(10), plane("872841", "APJ705", 35.5, 129.5, now)); // 같은 보고 — 보낼 것 없음
            assertThat(selected(f)).isEqualTo(3);
        }
    }

    /**
     * resume(초기 세트의 force)은 전처럼 selected 를 다시 보낸다 — 클라이언트가 전체를 다시 받는 경우다. 백프레셔 · 작업 실패의 재동기도 같은 길이다.
     */
    @Test void aResumeStillResendsTheSelected() throws Exception {
        try (WsTestKit k = new WsTestKit()) {
            Instant now = Instant.now();
            k.publish("region", now, plane("872841", "APJ705", 35.5, 129.5, now));
            FakeWsSession f = k.subscribed("s", "1.1.1.1");
            k.msg(f, "{\"type\":\"select\",\"hex\":\"872841\"}");
            assertThat(selected(f)).isEqualTo(1);
            k.msg(f, "{\"type\":\"pause\"}");
            k.msg(f, "{\"type\":\"resume\"}");
            assertThat(selected(f)).isEqualTo(2);
            assertThat(ofType(f, "selected").get(0).toString()).isEqualTo(ofType(f, "selected").get(1).toString());
        }
    }
}
