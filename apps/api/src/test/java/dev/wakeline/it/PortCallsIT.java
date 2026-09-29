package dev.wakeline.it;

import dev.wakeline.demand.DemandLeases;
import dev.wakeline.ingest.ShipStore;
import dev.wakeline.portcalls.PortCallsInfoTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 한국 항만 입출항(ADR-022) 끝에서 끝까지 — 실제 Redis(infra/redis/start.sh ACL) · 실제 api:
 * 선박 스트림(정적 정보의 호출부호) → WS select_ship → api 가 임대 wakeline:demand:portcalls 에 호출부호를 쓴다(수집기 사용자로 읽힌다 · 쓰지는 못한다)
 * → 수집기 사용자가 캐시 wakeline:portcalls:{호출부호} 에 SET EX(값 = 수집기가 실제 응답 fixture 로 만든 것) → ship_selected.port_calls 가
 * pending 에서 ok 로(선박이 바뀌지 않아도) → 선택 해제하면 임대가 빠진다. PORT-MIS 는 부르지 않는다(외부 호출 없음).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class PortCallsIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(20);
    static final String CALL_SIGN = "230025";
    static final String MMSI = "440700230";

    @Autowired ShipStore ships;

    static Set<String> leased() {
        Set<String> out = ItStack.collector().opsForZSet().rangeByScore(DemandLeases.PORT_CALLS, System.currentTimeMillis(), Double.POSITIVE_INFINITY);
        return out == null ? Set.of() : out;
    }

    @Test
    void selectingAShipLeasesItsCallSign_andTheCollectorsCacheValueReachesTheCard() throws Exception {
        Instant seen = Instant.now();
        Map<String, Object> stat = Streams.shipStatic(MMSI, "BUKWANG 9", 80, seen.minusSeconds(60));
        stat.put("call_sign", CALL_SIGN);
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(MMSI, 34.9, 128.7, seen)), List.of(stat)));
        await("ship with its static", WAIT, () -> ships.view().get(MMSI) != null && ships.view().get(MMSI).stat() != null);
        String key = "wakeline:portcalls:" + CALL_SIGN;
        ItStack.admin().delete(key);

        WsIT.Client c = new WsIT.Client();
        c.ws = HTTP.newWebSocketBuilder().header("Origin", ORIGIN).buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
        try {
            c.send("{\"type\":\"hello\",\"proto\":1}");
            c.next("welcome");
            c.send("{\"type\":\"subscribe\",\"bbox\":[128,34,130,36],\"zoom\":8}");
            c.send("{\"type\":\"select_ship\",\"mmsi\":\"" + MMSI + "\"}");
            JsonNode first = c.next("ship_selected");
            assertThat(first.path("port_calls").path("status").asString()).isEqualTo("pending");
            assertThat(first.path("port_calls").path("call_sign").asString()).isEqualTo(CALL_SIGN);

            await("lease readable by the collector user", WAIT, () -> leased().contains(CALL_SIGN));
            Long ttl = ItStack.admin().getExpire(DemandLeases.PORT_CALLS, TimeUnit.MILLISECONDS);
            assertThat(ttl).as("the lease key itself expires (api gone → the collector stops within 60 s)").isBetween(1L, 60_000L);
            assertThatThrownBy(() -> ItStack.collector().opsForZSet().add(DemandLeases.PORT_CALLS, "FORGED1", Double.MAX_VALUE))
                    .as("only the api writes leases").hasStackTraceContaining("NOPERM");

            // 수집기 사용자로 캐시를 쓴다(수집기와 같은 ACL — SET EX)
            ItStack.collector().opsForValue().set(key, PortCallsInfoTest.sample().toString(), Duration.ofSeconds(60));
            JsonNode ok = null;
            long end = System.nanoTime() + WAIT.toNanos();
            while (System.nanoTime() < end) {
                JsonNode n = c.next("ship_selected", WAIT);
                if ("ok".equals(n.path("port_calls").path("status").asString())) { ok = n; break; }
            }
            assertThat(ok).as("ship_selected with port_calls ok (periodic refresh — the ship itself did not change)").isNotNull();
            JsonNode item = ok.path("port_calls").path("items").get(0);
            assertThat(item.path("port_authority").asString()).isEqualTo("부산");
            assertThat(item.path("reported_name").asString()).isEqualTo("부광9호");
            assertThat(item.path("entry_at").asString()).isEqualTo("2026-09-28T15:00:00Z");
            assertThat(ok.path("port_calls").has("error")).isFalse();

            c.send("{\"type\":\"select_ship\",\"mmsi\":null}");
            await("lease removed after deselect", WAIT, () -> !leased().contains(CALL_SIGN));
        } finally {
            c.close();
            ItStack.admin().delete(key);
        }
    }
}
