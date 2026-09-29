package dev.wakeline.it;

import dev.wakeline.ingest.ShipStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
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
 * MMSI 는 이 시험만 쓰는 값이다(컨텍스트를 함께 쓰는 다른 시험의 메모리 정적 정보와 섞이지 않게) — 이름 · 호출부호는 관찰된 선박의 값.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StoredStaticIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(20);
    static final String MMSI = "440700241";

    @Autowired ShipStore ships;

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

    /** 고친 뒤의 기대: 저장된 정적 보고를 stored 로 밝혀 싣고, 입출항은 그 호출부호로 찾는다. */
    static void assertStoredFallback(JsonNode sel, Instant storedAt) {
        assertThat(sel.path("static").path("call_sign").asString()).isEqualTo("V7A3884");
        assertThat(sel.path("static").path("name").asString()).isEqualTo("AZAMARA PURSUIT");
        assertThat(sel.path("static_source").asString()).isEqualTo("stored");
        assertThat(Instant.parse(sel.path("static_updated_at").asString())).isEqualTo(storedAt);
        assertThat(sel.path("port_calls").path("call_sign").asString()).isEqualTo("V7A3884");
        assertThat(sel.path("port_calls").path("status").asString()).isNotEqualTo("no_call_sign");
    }

    @Test
    void afterARestartTheSelectionHasNoStaticAlthoughTheDbHoldsTheLastStaticReport() throws Exception {
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
            // 고치기 전(재현): 관찰과 같다 — static null · no_call_sign(not_received). 고치면 아래 단언이 실패한다(xfail strict — 고칠 때 이 블록을 바꾼다)
            assertThat(sel.get("static").isNull()).isTrue();
            assertThat(sel.path("port_calls").path("status").asString() + "/" + sel.path("port_calls").path("call_sign_state").asString())
                    .isEqualTo("no_call_sign/not_received");
            assertThatThrownBy(() -> assertStoredFallback(sel, storedAt)).isInstanceOf(AssertionError.class);
            // REST 상세는 이미 DB 로 채운다 — 그러나 저장값이라고 밝히지 않아 카드는 호출부호를 보이면서 입출항은 '호출부호 아직 받지 않음' 이었다
            JsonNode detail = get("/api/v1/ships/" + MMSI).json();
            assertThat(detail.path("static").path("call_sign").asString()).isEqualTo("V7A3884");
            assertThat(detail.has("static_source")).isFalse();
        } finally {
            c.close();
        }
    }
}
