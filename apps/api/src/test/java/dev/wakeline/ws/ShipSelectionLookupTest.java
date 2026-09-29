package dev.wakeline.ws;

import dev.wakeline.domain.ShipStatic;
import dev.wakeline.persist.StoredStaticReader;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static dev.wakeline.ws.ShipFanoutTest.BUSAN;
import static dev.wakeline.ws.ShipFanoutTest.pos;
import static dev.wakeline.ws.WsTestKit.ac;
import static dev.wakeline.ws.WsTestKit.ofType;
import static dev.wakeline.ws.WsTestKit.types;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 선택 선박의 DB 조회(저장 정적 보고 · 입출항 색인)와 세션 우편함(VERIFICATION #51 '남은 것').
 * <p>관찰(코드): ShipFanout.runSelected 는 세션 우편함(SerialOutbox — 한 번에 하나)에서 돌고 StoredStaticReader.lookup · PortCallReader 를 그 자리에서
 * 부른다(공유 Hikari 풀 — 연결 대기 5 s + 공개 조회 문장 3 s). 풀에 연결이 없는 동안 선택 하나가 그 세션의 항공기 · 선박 diff · pong · heartbeat 를 최대 약 8 s
 * 붙잡고, 실패 기억(15 s)이 끝날 때마다 되풀이된다.
 */
class ShipSelectionLookupTest {
    static final Instant T = ShipFanoutTest.T;
    static final String MMSI = "440000061", OTHER = "440000062";

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
        volatile RuntimeException fail;

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
            if (fail != null) throw fail;
            return rows.get(mmsi);
        }
    }

    static ShipStatic stored(String mmsi, String callSign) {
        return new ShipStatic(mmsi, "STORED " + mmsi, callSign, null, 70, null, null, null, null, null, null, null, null, null, null,
                T.minusSeconds(5 * 3600), "aisstream");
    }

    /**
     * 재현(고치기 전): 저장 정적 보고 읽기가 DB 를 기다리는 동안 그 세션의 pong · 항공기 diff · 선박 diff 가 가지 않는다 — 읽기가 끝나야(ship_selected 뒤)
     * 나간다. 고치기 전 관찰을 단언한다(xfail strict — 고칠 때 이 단언을 뒤집는다).
     */
    @Test void whileTheStoredStaticReadWaitsOnTheDb_theSessionsOtherTrafficWaitsToo_reproduction() throws Exception {
        ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
        try (WsTestKit k = new WsTestKit(pool, 5_000, 200, 5)) {
            Instant now = Instant.now();
            k.publish("region", now, ac("aaa001", 35, 129, 30000, now, "adsb_lol"));
            ShipFanoutTest.publish(k, List.of(pos(MMSI, 35.1, 129.1, T), pos(OTHER, 35.2, 129.2, T)), List.of()); // 위치만(메모리에 정적 정보 없음)
            BlockingStored db = new BlockingStored();
            db.rows.put(MMSI, stored(MMSI, "D7SL"));
            k.shipFanout.setStoredStaticSource(new StoredStaticReader(db, System::currentTimeMillis, k.meters)::lookup);
            FakeWsSession f = ShipFanoutTest.session(k, "s", BUSAN, true);
            WsSession s = k.handler.session("s");
            await(s::idle);
            assertThat(ofType(f, "ships_snapshot")).hasSize(1);

            db.hold = new CountDownLatch(1);
            k.msg(f, "{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            await(() -> db.reads.size() == 1); // 읽기가 시작돼 DB 를 기다린다
            k.msg(f, "{\"type\":\"ping\"}");
            k.publish("region", now.plusSeconds(10), ac("aaa001", 35.3, 129, 30000, now.plusSeconds(10), "adsb_lol"));
            ShipFanoutTest.publish(k, List.of(pos(OTHER, 35.4, 129.2, T.plusSeconds(10))), List.of());
            Thread.sleep(300);
            // 고치기 전(재현): 우편함이 읽기에 붙잡혀 아무것도 가지 않는다
            assertThat(ofType(f, "pong")).isEmpty();
            assertThat(ofType(f, "diff")).isEmpty();
            assertThat(ofType(f, "ships_diff")).isEmpty();
            assertThat(ofType(f, "ship_selected")).isEmpty();

            db.hold.countDown();
            await(() -> !ofType(f, "pong").isEmpty() && !ofType(f, "ships_diff").isEmpty() && s.idle());
            List<String> order = types(f);
            assertThat(order.indexOf("ship_selected")).as("everything else waited for the read").isLessThan(order.indexOf("pong"));
            JsonNode sel = ofType(f, "ship_selected").getLast();
            assertThat(sel.path("static_source").asString()).isEqualTo("stored");
        } finally {
            pool.shutdownNow();
        }
    }
}
