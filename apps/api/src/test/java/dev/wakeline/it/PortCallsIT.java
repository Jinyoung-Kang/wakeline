package dev.wakeline.it;

import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.portcalls.PortCallFixtures;
import dev.wakeline.portcalls.PortCallReader;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 항만 입출항(ADR-022 개정) 끝에서 끝까지 — 실제 PostgreSQL(V15 색인 · api 계정) · 실제 Redis(ACL) · 실제 api:
 * 선박 스트림(정적 정보의 호출부호) → WS select_ship → ship_selected.port_calls 가 색인에서 찾은 기록(ok) · 완전하고 새 색인에 없는 선박은 none ·
 * 색인이 빠진 곳이 있으면 incomplete. 선택은 Redis 임대를 만들지 않는다(예전 wakeline:demand:portcalls 는 없다). PORT-MIS 는 부르지 않는다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class PortCallsIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(20);
    static final String LISTED = "538012043", ABSENT = "440700230";

    @Autowired ShipStore ships;

    @AfterEach
    void clean() {
        admin().sql("DELETE FROM port_call").update();
        admin().sql("DELETE FROM port_call_coverage").update();
    }

    /** 공유 fixture 행(수집기가 실제 전체 기록을 해석한 것)을 오늘(KST) 기준 창 안의 날짜로 옮겨 넣는다 — 값은 그대로. */
    static void insertListedShip(LocalDate listed) {
        JsonNode r = PortCallFixtures.rowJson();
        admin().sql("""
                INSERT INTO port_call (prt_ag_cd, clsgn, etrypt_year, etrypt_co, listed_date, prt_ag_nm, vssl_nm, purpose_nm, entry_at, entry_revision,
                  exit_at, exit_revision, berth, fetched_at, updated_at)
                VALUES (:pa, :cs, :y, :co, :listed, :pan, :vn, :pur, :entry, :er, :exit, :xr, :berth, now(), now())""")
                .param("pa", r.path("prt_ag_cd").asString()).param("cs", r.path("clsgn").asString()).param("y", r.path("etrypt_year").asString())
                .param("co", r.path("etrypt_co").asString()).param("listed", listed).param("pan", r.path("prt_ag_nm").asString())
                .param("vn", r.path("vssl_nm").asString()).param("pur", r.path("purpose_nm").asString())
                .param("entry", Timestamp.from(Instant.parse(r.path("entry_at").asString()))).param("er", r.path("entry_revision").asString())
                .param("exit", Timestamp.from(Instant.parse(r.path("exit_at").asString()))).param("xr", r.path("exit_revision").asString())
                .param("berth", r.path("berth").asString()).update();
    }

    static void coverAll(LocalDate from, LocalDate to) {
        for (Map.Entry<String, String> pa : PortCallReader.PORT_AUTHORITIES)
            admin().sql("INSERT INTO port_call_coverage (prt_ag_cd, covered_from, covered_to, refreshed_at, updated_at) VALUES (:pa, :f, :t, now(), now())")
                    .param("pa", pa.getKey()).param("f", from).param("t", to).update();
    }

    static void seedShip(String mmsi, String name, String callSign) throws Exception {
        Instant seen = Instant.now();
        Map<String, Object> stat = Streams.shipStatic(mmsi, name, 60, seen.minusSeconds(60));
        stat.put("call_sign", callSign);
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(mmsi, 35.1, 129.0, seen)), List.of(stat)));
    }

    JsonNode portCallsAfterSelect(WsIT.Client c, String mmsi, String status) throws Exception {
        c.send("{\"type\":\"select_ship\",\"mmsi\":\"" + mmsi + "\"}");
        long end = System.nanoTime() + WAIT.toNanos();
        while (System.nanoTime() < end) {
            JsonNode n = c.next("ship_selected", WAIT);
            if (mmsi.equals(n.path("mmsi").asString()) && status.equals(n.path("port_calls").path("status").asString())) return n.path("port_calls");
        }
        throw new AssertionError("no ship_selected " + mmsi + " with port_calls " + status);
    }

    @Test
    void selectingAShipReadsTheIndex_okForAListedShip_noneOnlyWithAFullFreshIndex_andNoLeaseIsWritten() throws Exception {
        LocalDate today = LocalDate.now(ZoneOffset.ofHours(9));
        insertListedShip(today.minusDays(5));
        coverAll(today.minusDays(31), today);
        seedShip(LISTED, "AZAMARA PURSUIT", "V7A3884");
        seedShip(ABSENT, "BUKWANG 9", "230025");
        await("ships with their statics", WAIT, () -> ships.view().get(LISTED) != null && ships.view().get(LISTED).stat() != null
                && ships.view().get(ABSENT) != null && ships.view().get(ABSENT).stat() != null);

        WsIT.Client c = new WsIT.Client();
        c.ws = HTTP.newWebSocketBuilder().header("Origin", ORIGIN).buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
        try {
            c.send("{\"type\":\"hello\",\"proto\":1}");
            c.next("welcome");
            c.send("{\"type\":\"subscribe\",\"bbox\":[128,34,130,36],\"zoom\":8}");
            JsonNode ok = portCallsAfterSelect(c, LISTED, "ok");
            JsonNode item = ok.path("items").get(0);
            assertThat(item.path("port_authority").asString()).isEqualTo("부산");
            assertThat(item.path("reported_name").asString()).isEqualTo("AZAMARA PURSUIT");
            assertThat(item.path("entry_at").asString()).isEqualTo("2026-09-23T23:17:00Z");
            assertThat(item.path("exit_at").asString()).isEqualTo("2026-09-25T05:24:00Z");
            assertThat(item.path("berth").asString()).isEqualTo("북항크루즈터미널 2선석");
            assertThat(ok.path("index").path("complete").asBoolean()).isTrue();

            JsonNode none = portCallsAfterSelect(c, ABSENT, "none");
            assertThat(none.path("call_sign").asString()).isEqualTo("230025");
            assertThat(none.has("items")).isFalse();
            assertThat(ItStack.admin().hasKey("wakeline:demand:portcalls")).as("a selection writes no lease any more").isFalse();
            assertThat(ItStack.admin().keys("wakeline:portcalls:*")).as("nor a per-call-sign cache").isEmpty();

            // 한 곳이 빠졌다 — 이제 '기록 없음' 이라 할 수 없다. 읽기 캐시(15 s)가 지난 뒤 다시 고르면 빈 곳을 밝힌다
            admin().sql("DELETE FROM port_call_coverage WHERE prt_ag_cd = '700'").update();
            Thread.sleep(PortCallReader.TTL_MS + 500);
            JsonNode inc = portCallsAfterSelect(c, ABSENT, "incomplete");
            assertThat(inc.path("index").path("gaps").get(0).path("port_authority_code").asString()).isEqualTo("700");
            assertThat(inc.path("index").path("gaps").get(0).path("issues").get(0).asString()).isEqualTo("not_indexed");
        } finally {
            c.close();
        }
    }
}
