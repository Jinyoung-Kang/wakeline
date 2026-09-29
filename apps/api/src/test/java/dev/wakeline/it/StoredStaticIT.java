package dev.wakeline.it;

import dev.wakeline.DbTestSupport;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.persist.ReadPool;
import dev.wakeline.persist.Sql;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 선택 선박의 저장된 AIS 정적 보고(static-fallback) — 실제 PostgreSQL · Redis · api.
 * <p>관찰(운영 스택, api 재시작 뒤): 지도에서 고른 실시간 선박(MMSI 538012043 AZAMARA PURSUIT)의 ship_selected.static 이 null 이고 port_calls 가
 * no_call_sign(not_received)로 오래 남았다. api 메모리(ShipStore)의 정적 정보는 선박 스트림(보존 약 2.5 h)에서만 다시 채워지는데 이 선박의 정적 보고는
 * 그보다 오래됐다 — DB ship 표(ShipRepository — /ships/{mmsi} · 검색이 이미 읽는 곳)에는 마지막으로 받은 정적 보고(호출부호 V7A3884)가 있다.
 * <p>재현: DB 에 5시간 전 정적 보고를 넣고 스트림에는 위치만 발행한다(재시작 뒤 스트림 보존 창에 정적 보고가 없는 상태) → WS select_ship.
 * 고침(계약 v5 §G17): 저장된 정적 보고를 static_source = stored · static_updated_at(저장 행의 updated_at)으로 밝혀 싣고 입출항은 그 호출부호로 찾는다 —
 * 메모리(ShipStore)에는 넣지 않는다. REST 상세도 같은 출처를 밝힌다. ship 표가 잠기면(문장 — 공개 조회 상한 3 s) static null · stored_unavailable · no_call_sign.
 * <p>우편함 밖 조회(계약 v5 §G18 · VERIFICATION #51 '남은 것'): 읽기는 세션 우편함 밖 조회 실행기에서, 선택 조회 전용 읽기 풀(ReadPool — 4 연결 · 연결 대기
 * 2 s · 서버 statement_timeout 3 s · 읽기 전용)로 한다. 읽기가 막힌 동안에도 pong · 항공기 diff 는 곧바로 가고, 읽기 풀이 바닥나면 연결 대기 2 s(공유 풀은
 * 5 s)에 끊겨 stored_unavailable 로 답한다.
 * MMSI 는 이 시험만 쓰는 값이다(컨텍스트를 함께 쓰는 다른 시험의 메모리 정적 정보와 섞이지 않게) — 이름 · 호출부호는 관찰된 선박의 값.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StoredStaticIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(20);
    static final String MMSI = "440700241", LOCKED = "440700242", EXHAUSTED = "440700243";

    @Autowired ShipStore ships;
    @Autowired ReadPool readPool;

    /** 다음 ship_selected 까지 받은 것의 type 순서(ship_selected 가 마지막). */
    static List<String> untilSelected(WsIT.Client c, Duration timeout) throws InterruptedException {
        List<String> seen = new ArrayList<>();
        long end = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < end) {
            JsonNode n = c.messages.poll(50, TimeUnit.MILLISECONDS);
            if (n == null) continue;
            seen.add(n.path("type").asString());
            if ("ship_selected".equals(n.path("type").asString())) {
                c.messages.add(n); // 부르는 쪽이 next 로 다시 읽는다(순서상 마지막)
                return seen;
            }
        }
        throw new AssertionError("no ship_selected within " + timeout + " — seen " + seen);
    }

    @AfterEach
    void clean() {
        admin().sql("DELETE FROM port_call").update();
        admin().sql("DELETE FROM port_call_coverage").update();
    }

    /**
     * ShipWriter 가 쓰는 것과 같은 모양의 저장 정적 보고(api 계정 — 앱과 같은 권한). updated_at = 이 내용을 담은 메시지의 수신 시각.
     * 이름 · 호출부호 밖의 칸은 모름(NULL) — 관찰된 선박의 다른 값을 지어 넣지 않는다.
     */
    void storeStatic(String mmsi, String name, String callSign, Instant updatedAt) {
        OffsetDateTime at = OffsetDateTime.ofInstant(updatedAt, ZoneOffset.UTC);
        db.sql("""
                INSERT INTO ship (mmsi, name, call_sign, first_seen, last_seen, updated_at, provider)
                VALUES (?, ?, ?, ? - interval '2 days', ?, ?, 'aisstream')
                ON CONFLICT (mmsi) DO NOTHING""").param(mmsi).param(name).param(callSign).param(at).param(at).param(at).update();
    }

    WsIT.Client connect() throws Exception {
        WsIT.Client c = new WsIT.Client();
        c.ws = HTTP.newWebSocketBuilder().header("Origin", ORIGIN).buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
        c.send("{\"type\":\"hello\",\"proto\":1}");
        c.next("welcome");
        c.send("{\"type\":\"subscribe\",\"bbox\":[128,34,130,36],\"zoom\":8}");
        return c;
    }

    /** 저장된 정적 보고를 stored 로 밝혀 싣고, 입출항은 그 호출부호로 찾는다. */
    static void assertStoredFallback(JsonNode sel, Instant storedAt) {
        assertThat(sel.path("static").path("call_sign").asString()).isEqualTo("V7A3884");
        assertThat(sel.path("static").path("name").asString()).isEqualTo("AZAMARA PURSUIT");
        assertThat(sel.path("static_source").asString()).isEqualTo("stored");
        assertThat(Instant.parse(sel.path("static_updated_at").asString())).isEqualTo(storedAt);
        assertThat(sel.path("static_updated_at").asString()).as("the row's updated_at = static.updated_at").isEqualTo(sel.path("static").path("updated_at").asString());
        assertThat(sel.path("port_calls").path("call_sign").asString()).isEqualTo("V7A3884");
        assertThat(sel.path("port_calls").path("status").asString()).isNotEqualTo("no_call_sign");
    }

    /** 이 선박의 ship_selected 중 port_calls 상태가 status 인 것(색인 읽기 캐시 15 s 동안 다른 시험이 남긴 값이면 주기 다시 보기가 바꾼다). */
    static JsonNode selectedWith(WsIT.Client c, String mmsi, String status) throws Exception {
        long end = System.nanoTime() + WAIT.toNanos();
        while (System.nanoTime() < end) {
            JsonNode n = c.next("ship_selected", WAIT);
            if (mmsi.equals(n.path("mmsi").asString()) && status.equals(n.path("port_calls").path("status").asString())) return n;
        }
        throw new AssertionError("no ship_selected " + mmsi + " with port_calls " + status);
    }

    @Test
    void afterARestartTheStoredStaticReportFillsTheSelection_markedStored_andPortCallsUseItsCallSign() throws Exception {
        LocalDate today = LocalDate.now(ZoneOffset.ofHours(9));
        PortCallsIT.insertListedShip(today.minusDays(5));
        PortCallsIT.coverAll(today.minusDays(31), today);
        Instant storedAt = Instant.now().minus(5, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS); // 스트림 보존(2.5 h)보다 오래됨
        storeStatic(MMSI, "AZAMARA PURSUIT", "V7A3884", storedAt);
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(MMSI, 35.1, 129.0, Instant.now())), List.of()));
        await("live ship (position only)", WAIT, () -> ships.view().get(MMSI) != null);
        assertThat(ships.view().get(MMSI).stat()).as("no static in memory — as after the restart").isNull();

        WsIT.Client c = connect();
        try {
            c.send("{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            JsonNode sel = c.next("ship_selected", WAIT);
            assertThat(sel.path("mmsi").asString()).isEqualTo(MMSI);
            assertThat(sel.path("state").path("lat").asDouble()).isEqualTo(35.1);
            assertStoredFallback(sel, storedAt);
            // 입출항: 저장된 호출부호로 색인에서 찾은 부산 기록(공유 fixture 행) — 색인 읽기 캐시에 다른 시험의 값이 남아 있으면 주기 다시 보기가 바꾼다
            JsonNode ok = "ok".equals(sel.path("port_calls").path("status").asString()) ? sel : selectedWith(c, MMSI, "ok");
            assertStoredFallback(ok, storedAt);
            assertThat(ok.path("port_calls").path("items").get(0).path("reported_name").asString()).isEqualTo("AZAMARA PURSUIT");
            // 메모리에 섞지 않았다 — 지도 목록 · 검색의 실시간 값은 그대로
            assertThat(ships.view().get(MMSI).stat()).isNull();
            assertThat(ships.staticOf(MMSI)).isNull();
            // REST 상세도 같은 출처를 밝힌다(저장 행의 updated_at)
            JsonNode detail = get("/api/v1/ships/" + MMSI).json();
            assertThat(detail.path("static").path("call_sign").asString()).isEqualTo("V7A3884");
            assertThat(detail.path("static_source").asString()).isEqualTo("stored");
            assertThat(Instant.parse(detail.path("static_updated_at").asString())).isEqualTo(storedAt);
        } finally {
            c.close();
        }
    }

    /**
     * DB 가 막힌 동안(ship 표 잠금 — 문장이 공개 조회 상한 {@value Sql#PUBLIC_READ_TIMEOUT_S} s 에 끊긴다. 연결 대기는 따로 — 위 설명): static null · static_source stored_unavailable
     * (저장돼 있는지 모름 — none 이 아니다) · 입출항 no_call_sign/not_received. 연결 · 세션은 그대로이고 선택 응답은 상한 안에 온다.
     */
    @Test
    void whileTheShipTableIsLockedTheSelectionSaysStoredUnavailable_withinThePublicReadTimeout() throws Exception {
        storeStatic(LOCKED, "IT LOCKED STORED", "D9LK", Instant.now().minus(4, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS));
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(LOCKED, 35.2, 129.1, Instant.now())), List.of()));
        await("live ship (position only)", WAIT, () -> ships.view().get(LOCKED) != null);
        WsIT.Client c = connect();
        try (Connection lock = DriverManager.getConnection(DbTestSupport.jdbcUrl(ItStack.DB), "postgres", DbTestSupport.ROOT_PW);
             Statement st = lock.createStatement()) {
            lock.setAutoCommit(false);
            st.execute("LOCK TABLE ship IN ACCESS EXCLUSIVE MODE"); // 저장 정적 보고 읽기가 이 잠금을 기다린다
            long t0 = System.nanoTime();
            c.send("{\"type\":\"select_ship\",\"mmsi\":\"" + LOCKED + "\"}");
            c.send("{\"type\":\"ping\"}");
            JsonNode pong = c.next("pong", Duration.ofSeconds(1));
            long pongMs = (System.nanoTime() - t0) / 1_000_000;
            assertThat(pong).isNotNull();
            assertThat(pongMs).as("the read runs off the session queue — pong does not wait for it").isLessThan(1_000);
            JsonNode sel = c.next("ship_selected", WAIT);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            lock.rollback();
            assertThat(sel.path("mmsi").asString()).isEqualTo(LOCKED);
            assertThat(sel.path("state").path("lat").asDouble()).as("the live state still goes out").isEqualTo(35.2);
            assertThat(sel.get("static").isNull()).isTrue();
            assertThat(sel.path("static_source").asString()).isEqualTo("stored_unavailable");
            assertThat(sel.get("static_updated_at").isNull()).isTrue();
            assertThat(sel.path("port_calls").path("status").asString() + "/" + sel.path("port_calls").path("call_sign_state").asString())
                    .isEqualTo("no_call_sign/not_received");
            assertThat(ms).as("cut by the public read timeout (3 s), not the lock holder").isBetween(2_500L, 4_900L);
            // 세션은 살아 있다 — 다음 메시지에 바로 답한다
            c.send("{\"type\":\"ping\"}");
            c.next("pong");
        } finally {
            c.close();
        }
    }

    /**
     * 선택 조회 전용 읽기 풀이 바닥나면(4 연결 모두 다른 읽기가 잡음) 연결 대기 2 s 에 끊겨 stored_unavailable 로 답한다 — 공유 풀의 5 s 가 아니다. 그동안
     * 그 세션의 pong 은 곧바로 간다. 잡은 읽기(2.8 s)가 끝나기 전에 답이 오므로 stored_unavailable 자체가 '연결 대기에서 끊겼다' 는 증거다.
     */
    @Test
    void whenTheReadPoolIsExhaustedTheSelectionIsCutByItsTwoSecondConnectionWait() throws Exception {
        storeStatic(EXHAUSTED, "IT EXHAUSTED STORED", "D9EX", Instant.now().minus(4, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MILLIS));
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(EXHAUSTED, 35.3, 129.2, Instant.now())), List.of()));
        await("live ship (position only)", WAIT, () -> ships.view().get(EXHAUSTED) != null);
        assertThat(readPool.size()).isEqualTo(ReadPool.DEFAULT_SIZE);
        WsIT.Client c = connect();
        List<Thread> holders = new ArrayList<>();
        try {
            for (int i = 0; i < readPool.size(); i++)
                holders.add(Thread.ofVirtual().start(() -> readPool.jdbc().sql("SELECT pg_sleep(2.8)").query((rs, n) -> 1).list()));
            await("all read-pool connections taken", Duration.ofSeconds(5), () -> readPool.active() == readPool.size());
            long t0 = System.nanoTime();
            c.send("{\"type\":\"select_ship\",\"mmsi\":\"" + EXHAUSTED + "\"}");
            c.send("{\"type\":\"ping\"}");
            List<String> order = untilSelected(c, WAIT);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            JsonNode sel = c.next("ship_selected", WAIT);
            assertThat(order).as("pong is not held by the pending lookup").contains("pong");
            assertThat(sel.path("mmsi").asString()).isEqualTo(EXHAUSTED);
            assertThat(sel.path("static_source").asString()).as("cut before the holders released a connection").isEqualTo("stored_unavailable");
            assertThat(ms).as("the read pool's 2 s connection wait, not the shared pool's 5 s").isBetween(1_800L, 2_799L);
        } finally {
            for (Thread t : holders) t.join(5_000);
            c.close();
        }
    }

    /** 읽기 풀의 연결: 서버 statement_timeout = 공개 조회 상한(3 s) · 읽기 전용 · 이름 wakeline-api-read — 쓰기는 거절된다. */
    @Test
    void readPoolConnectionsCarryTheStatementLimitAndAreReadOnly() {
        assertThat(readPool.jdbc().sql("SHOW statement_timeout").query(String.class).single()).isEqualTo(Sql.PUBLIC_READ_TIMEOUT_S + "s");
        assertThat(readPool.jdbc().sql("SHOW default_transaction_read_only").query(String.class).single()).isEqualTo("on");
        assertThat(readPool.jdbc().sql("SHOW application_name").query(String.class).single()).isEqualTo("wakeline-api-read");
        assertThatThrownBy(() -> readPool.jdbc().sql("DELETE FROM ship WHERE mmsi = '000000000'").update())
                .hasMessageContaining("read-only transaction");
    }
}
