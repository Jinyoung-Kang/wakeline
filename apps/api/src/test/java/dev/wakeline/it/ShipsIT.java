package dev.wakeline.it;

import dev.wakeline.ingest.ShipStore;
import dev.wakeline.ingest.StreamConsumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.net.http.WebSocket;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 선박 경로 전체(ADR-014 · 계약 v2 §B3)를 실제 Redis(ACL — ais 수집기와 같은 wakeline_ais 사용자)·실제 PostGIS 로:
 * XADD wakeline:ships → 소비(스키마 검증) → ShipStore → REST · DB(60 s 창) → 커밋 뒤 ACK, ais_gap → ingest_gap → /ais/gaps,
 * 신뢰 경계(선박 스트림의 항공기 메시지 → DLQ, ais 사용자는 항공기 스트림에 못 쓴다), 상태 해시 → status.sources.ais, WS 선박 레이어
 * (줌 &lt; 7 격자 · 줌 ≥ 7 snapshot/diff 의 틈 없는 sseq), 저장 항적이 AIS 공백·긴 침묵에서 끊기는 것.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class ShipsIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(15);

    @Autowired ShipStore ships;

    long pendingShips() {
        var p = ItStack.admin().opsForStream().pending(Streams.SHIPS, StreamConsumer.GROUP);
        return p == null ? 0 : p.getTotalPendingMessages();
    }

    @Test
    void shipsFlowToMemoryRestAndDb_andAreAcknowledgedAfterCommit() {
        Instant seen = Instant.now().truncatedTo(ChronoUnit.MINUTES).plusSeconds(1); // 창 시작 직후
        String a = "440700001", b = "440700002";
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(a, 35.1, 129.05, seen), Streams.shipState(b, 35.2, 129.1, seen)),
                List.of(Streams.shipStatic(a, "IT BUSAN", 70, seen.minusSeconds(60)))));
        // 같은 60 s 창의 다음 보고 → 실시간은 갱신, 저장은 하지 않는다
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(a, 35.11, 129.05, seen.plusSeconds(10))), List.of()));
        await("ships in memory", WAIT, () -> ships.view().get(a) != null && ships.view().get(a).state().lat() == 35.11);
        await("rows committed", WAIT, () -> count("SELECT count(*) FROM ship_position WHERE mmsi IN (?, ?)", a, b) == 2);
        await("static row", WAIT, () -> count("SELECT count(*) FROM ship WHERE mmsi = ? AND name = 'IT BUSAN'", a) == 1);
        assertThat(count("SELECT count(*) FROM ship_position WHERE mmsi = ?", a)).as("first fix of the 60 s window only").isEqualTo(1);
        await("acknowledged after commit", WAIT, () -> pendingShips() == 0);

        Res list = get("/api/v1/ships?bbox=128,34,130,36");
        assertThat(list.status()).isEqualTo(200);
        assertThat(list.header("ETag")).startsWith("\"s");
        JsonNode fc = list.json();
        assertThat(fc.path("meta").path("total_in_bbox").asInt()).isGreaterThanOrEqualTo(2);
        boolean found = false;
        for (JsonNode f : fc.path("features")) if (a.equals(f.path("id").asString())) {
            found = true;
            assertThat(f.path("properties").path("name").asString()).isEqualTo("IT BUSAN");
            assertThat(f.path("properties").has("rot")).isFalse();
        }
        assertThat(found).isTrue();

        JsonNode detail = get("/api/v1/ships/" + a).json();
        assertThat(detail.path("state").path("lat").asDouble()).isEqualTo(35.11);
        assertThat(detail.path("static").path("ship_type").asInt()).isEqualTo(70);
        assertThat(detail.path("category").asString()).isEqualTo("cargo");
        assertThat(detail.path("first_recorded_at").isString()).isTrue();
        assertThat(Instant.parse(detail.path("last_position_at").asString())).isEqualTo(seen);
        assertThat(get("/api/v1/ships/440799999").status()).isEqualTo(404);

        JsonNode track = get("/api/v1/ships/" + a + "/track").json();
        assertThat(track.path("properties").path("points").asInt()).isEqualTo(1);
        assertThat(track.path("geometry").path("type").asString()).isEqualTo("MultiLineString");
    }

    @Test
    void gapsArePersistedOnce_andListed() {
        Instant s = Instant.now().minusSeconds(900).truncatedTo(ChronoUnit.MILLIS), e = s.plusSeconds(95);
        Streams.xaddAis(Streams.aisGap(Streams.nextFetchedAt(), s, e, "server closed (1006)"));
        Streams.xaddAis(Streams.aisGap(Streams.nextFetchedAt(), s, e, "server closed (1006)")); // 수집기 재발행 — 한 번만
        await("gap row", WAIT, () -> count("SELECT count(*) FROM ingest_gap WHERE started_at = ?", java.time.OffsetDateTime.ofInstant(s, java.time.ZoneOffset.UTC)) == 1);
        await("acked", WAIT, () -> pendingShips() == 0);
        assertThat(count("SELECT count(*) FROM ingest_gap WHERE started_at = ?", java.time.OffsetDateTime.ofInstant(s, java.time.ZoneOffset.UTC))).isEqualTo(1);
        JsonNode g = get("/api/v1/ais/gaps").json();
        boolean found = false;
        for (JsonNode it : g.path("items")) if (it.path("reason").asString().equals("server closed (1006)")) found = true;
        assertThat(found).isTrue();
        assertThat(ships.gaps()).anyMatch(x -> x.startedAt().equals(s));
    }

    /** 신뢰 경계(ADR-014): ais 사용자는 선박 스트림에만 쓸 수 있고, 선박 스트림의 다른 kind 는 DLQ 로 간다(반영하지 않는다). */
    @Test
    void aisUserIsConfinedToTheShipsStream_andForeignKindsAreDeadLettered() {
        assertThatThrownBy(() -> ItStack.ais().opsForStream().add(org.springframework.data.redis.connection.stream.MapRecord.create(Streams.AIRCRAFT,
                Map.of("kind", "aircraft")))).isInstanceOf(org.springframework.dao.DataAccessException.class).hasStackTraceContaining("NOPERM");
        Instant f = Streams.nextFetchedAt();
        String forged = "a1f0f0";
        Map<String, String> env = Streams.aircraft("region", f, List.of(Streams.state(forged, 37.4, 126.4, 30000, f, f)));
        String id = Streams.xaddAis(env);
        await("dead-lettered", WAIT, () -> {
            var dlq = ItStack.admin().opsForStream().range(Streams.DLQ, org.springframework.data.domain.Range.unbounded());
            return dlq != null && dlq.stream().anyMatch(r -> id.equals(r.getValue().get("source_id")));
        });
        assertThat(count("SELECT count(*) FROM track_point WHERE hex = ?", forged)).isZero();
    }

    @Test
    void aisStatusHashBecomesStatusSourcesAis() {
        Instant now = Instant.now();
        ItStack.ais().opsForHash().putAll("wakeline:ais:status", Map.of("provider", "fixture", "connected", "1", "msgs_per_s", "5.40",
                "last_msg_at", now.toString(), "updated_at", now.toString(), "gap_open_since", "",
                "last_gap_started_at", now.minusSeconds(3600).toString(), "last_gap_ended_at", now.minusSeconds(3500).toString(), "last_gap_reason", "idle 120 s"));
        await("status refreshed", Duration.ofSeconds(12), () -> {
            JsonNode ais = get("/api/v1/status").json().path("sources").path("ais");
            return ais.path("connected").asBoolean(false) && ais.path("msgs_per_s").asDouble() == 5.4;
        });
        JsonNode ais = get("/api/v1/status").json().path("sources").path("ais");
        assertThat(ais.path("last_gap").path("reason").asString()).isNotBlank();
        assertThat(ais.has("gap_open_since")).as("no open gap → key omitted (unknown/none)").isFalse();
    }

    @Test
    void wsShipsLayer_snapshotThenDiffWithContiguousSseq() throws Exception {
        Instant seen = Instant.now();
        String m = "440700010";
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(m, 34.5, 128.5, seen)), List.of()));
        await("ship", WAIT, () -> ships.view().get(m) != null);
        WsIT.Client c = new WsIT.Client();
        c.ws = HTTP.newWebSocketBuilder().header("Origin", ORIGIN).buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
        try {
            c.send("{\"type\":\"hello\",\"proto\":1}");
            c.next("welcome");
            c.send("{\"type\":\"layers\",\"aircraft\":false,\"ships\":true}");
            c.send("{\"type\":\"subscribe\",\"bbox\":[128,34,130,36],\"zoom\":8}");
            JsonNode snap = c.next("ships_snapshot");
            assertThat(snap.path("sseq").asInt()).isEqualTo(1);
            boolean has = false;
            for (JsonNode s : snap.path("ships")) if (m.equals(s.path("mmsi").asString())) has = true;
            assertThat(has).isTrue();
            Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(m, 34.6, 128.5, seen.plusSeconds(10))), List.of()));
            JsonNode diff = c.next("ships_diff", Duration.ofSeconds(20)); // 팬아웃은 10 s 에 한 번으로 모은다
            assertThat(diff.path("sseq").asInt()).isEqualTo(2);
            assertThat(diff.path("upsert").get(0).path("lat").asDouble()).isEqualTo(34.6);
            c.send("{\"type\":\"select_ship\",\"mmsi\":\"" + m + "\"}");
            JsonNode sel = c.next("ship_selected");
            assertThat(sel.path("state").path("class").asString()).isEqualTo("A");
            assertThat(sel.has("static")).isTrue();
        } finally {
            c.close();
        }
    }

    // ---------- WS 격자 → 점(계약 v2 §B3) ----------

    /** 한 세션의 선박 메시지 기록: ships_snapshot 은 sseq 1, ships_diff 는 직전 sseq + 1(틈 없음)을 받는 즉시 확인한다. */
    static final class ShipFeed {
        final WsIT.Client c;
        int lastSseq;

        ShipFeed(WsIT.Client c) { this.c = c; }

        JsonNode next(String type, Duration timeout) throws InterruptedException {
            long end = System.nanoTime() + timeout.toNanos();
            while (System.nanoTime() < end) {
                JsonNode n = c.messages.poll(50, TimeUnit.MILLISECONDS);
                if (n == null) continue;
                String t = n.path("type").asString();
                if ("ships_snapshot".equals(t)) {
                    assertThat(n.path("sseq").asInt()).as("ships_snapshot sseq").isEqualTo(1);
                    lastSseq = 1;
                } else if ("ships_diff".equals(t)) {
                    assertThat(lastSseq).as("ships_diff before any ships_snapshot").isPositive();
                    assertThat(n.path("sseq").asInt()).as("ships_diff sseq contiguous").isEqualTo(lastSseq + 1);
                    assertThat(n.path("upsert").size() + n.path("remove").size()).as("no empty ships_diff").isPositive();
                    lastSseq = n.path("sseq").asInt();
                } else if ("ships_grid".equals(t)) {
                    lastSseq = 0; // 격자 모드 — 점으로 돌아오면 스냅샷부터
                }
                if (type.equals(t)) return n;
            }
            throw new AssertionError("no '" + type + "' within " + timeout);
        }
    }

    /** ships_grid 칸 → {"lat,lon": "count,category"}. */
    static Map<String, String> cells(JsonNode grid) {
        Map<String, String> out = new HashMap<>();
        for (JsonNode cell : grid.path("cells")) {
            assertThat(cell.size()).as("cell = [lat, lon, count, category]").isEqualTo(4);
            out.put(cell.get(0).asDouble() + "," + cell.get(1).asDouble(), cell.get(2).asInt() + "," + cell.get(3).asString());
        }
        return out;
    }

    static Set<String> mmsis(JsonNode arr) {
        Set<String> out = new HashSet<>();
        for (JsonNode n : arr) out.add(n.isString() ? n.asString() : n.path("mmsi").asString());
        return out;
    }

    /**
     * 스트림 → ShipStore → WS: 줌 3 은 2° 격자(칸 중심 좌표 · 척수 · 대표 분류), 줌 2 는 5° 격자, 줌 8 은 ships_snapshot(sseq 1) 뒤
     * 바뀐 것만 ships_diff(sseq 2, 3 — 틈 없음). 화면 밖으로 나간 선박은 remove.
     */
    @Test
    void wsShipsGridAtLowZoom_thenSnapshotAndContiguousDiffsAtZoom8() throws Exception {
        Instant seen0 = Instant.now().truncatedTo(ChronoUnit.MILLIS).minusSeconds(120);
        Instant stat = seen0.minusSeconds(60);
        String m1 = "440799601", m2 = "440799602", m3 = "440799603", m4 = "440799604";
        // 아라비아해(다른 테스트의 선박과 겹치지 않는다): 2° 칸 (12–14N, 62–64E) 에 화물 2 · 유조 1, (16–18N, 60–62E) 에 여객 1
        Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(m1, 12.3, 62.1, seen0), Streams.shipState(m2, 12.6, 62.4, seen0),
                Streams.shipState(m3, 13.1, 63.2, seen0), Streams.shipState(m4, 17.2, 61.1, seen0)), List.of(Streams.shipStatic(m1, "IT GRID 1", 70, stat),
                Streams.shipStatic(m2, "IT GRID 2", 71, stat), Streams.shipStatic(m3, "IT GRID 3", 80, stat), Streams.shipStatic(m4, "IT GRID 4", 60, stat))));
        await("ships with static", WAIT, () -> {
            for (String m : List.of(m1, m2, m3, m4)) {
                ShipStore.Ship s = ships.view().get(m);
                if (s == null || s.stat() == null) return false;
            }
            return true;
        });
        WsIT.Client c = new WsIT.Client();
        c.ws = HTTP.newWebSocketBuilder().header("Origin", ORIGIN).buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/v1"), c).get(5, TimeUnit.SECONDS);
        ShipFeed feed = new ShipFeed(c);
        try {
            c.send("{\"type\":\"hello\",\"proto\":1}");
            c.next("welcome");
            c.send("{\"type\":\"layers\",\"aircraft\":false,\"ships\":true}");
            c.send("{\"type\":\"subscribe\",\"bbox\":[55,5,70,25],\"zoom\":3}");
            JsonNode g2 = feed.next("ships_grid", Duration.ofSeconds(10));
            assertThat(g2.path("cell_deg").asDouble()).isEqualTo(2.0);
            assertThat(g2.has("capped")).as("capped only on the zoom ≥ 7 fallback").isFalse();
            assertThat(cells(g2)).isEqualTo(Map.of("13.0,63.0", "3,cargo", "17.0,61.0", "1,passenger"));

            c.send("{\"type\":\"subscribe\",\"bbox\":[55,5,70,25],\"zoom\":2}");
            JsonNode g5 = feed.next("ships_grid", Duration.ofSeconds(10));
            assertThat(g5.path("cell_deg").asDouble()).isEqualTo(5.0);
            assertThat(cells(g5)).isEqualTo(Map.of("12.5,62.5", "3,cargo", "17.5,62.5", "1,passenger"));

            c.send("{\"type\":\"subscribe\",\"bbox\":[61.5,11.5,63.5,13.5],\"zoom\":8}");
            JsonNode snap = feed.next("ships_snapshot", Duration.ofSeconds(10));
            assertThat(mmsis(snap.path("ships"))).isEqualTo(Set.of(m1, m2, m3));
            for (JsonNode sh : snap.path("ships")) {
                assertThat(sh.has("rot")).as("ShipLite has no rot").isFalse();
                assertThat(sh.path("name").asString()).startsWith("IT GRID");
            }

            // 1) m1 이동 → diff sseq 2
            Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(m1, 12.35, 62.15, seen0.plusSeconds(10))), List.of()));
            JsonNode d1 = feed.next("ships_diff", Duration.ofSeconds(25)); // 팬아웃은 10 s 에 한 번으로 모은다
            assertThat(d1.path("sseq").asInt()).isEqualTo(2);
            assertThat(mmsis(d1.path("upsert"))).isEqualTo(Set.of(m1));
            assertThat(d1.path("remove").size()).isZero();
            // 2) m2 가 화면 밖으로, m3 이동 → diff sseq 3 (upsert m3 · remove m2)
            Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(m2, 14.0, 62.4, seen0.plusSeconds(20)),
                    Streams.shipState(m3, 13.15, 63.2, seen0.plusSeconds(20))), List.of()));
            JsonNode d2 = feed.next("ships_diff", Duration.ofSeconds(25));
            assertThat(d2.path("sseq").asInt()).isEqualTo(3);
            assertThat(mmsis(d2.path("upsert"))).isEqualTo(Set.of(m3));
            assertThat(mmsis(d2.path("remove"))).isEqualTo(Set.of(m2));
        } finally {
            c.close();
        }
    }

    // ---------- 저장 항적 ----------

    /**
     * /ships/{mmsi}/track(계약 v2 §B3): 60 s 창마다 첫 보고로 저장된 점을 AIS 수신 공백(ingest_gap)이 걸친 두 점, 15분 넘게 떨어진 두 점에서 끊는다
     * → MultiLineString 3개(각 2점), segments 가 geometry 와 같은 순서, gaps 는 창과 겹치는 공백만. /ais/gaps 는 두 공백을 모두 시간순으로.
     * (다른 테스트의 공백은 최근 1시간 안이라 겹치지 않게 23시간 전 — 저장 한도 24 h 안.)
     */
    @Test
    void trackIsSplitAtAnIngestGapAndAtLongSilences() {
        String m = "440799701";
        Instant b = Instant.now().minus(23, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MINUTES).plusSeconds(1);
        List<Instant> ts = List.of(b, b.plusSeconds(60), b.plusSeconds(30 * 60), b.plusSeconds(32 * 60), b.plusSeconds(40 * 60), b.plusSeconds(42 * 60));
        for (int i = 0; i < ts.size(); i++)
            Streams.xaddAis(Streams.ships(Streams.nextFetchedAt(), List.of(Streams.shipState(m, 30.0 + 0.01 * i, 120.0, ts.get(i))), List.of()));
        Instant gs = b.plusSeconds(33 * 60), ge = b.plusSeconds(38 * 60);
        Instant later = b.plusSeconds(120 * 60);
        Streams.xaddAis(Streams.aisGap(Streams.nextFetchedAt(), gs, ge, "it: server closed (1006)"));
        Streams.xaddAis(Streams.aisGap(Streams.nextFetchedAt(), later, later.plusSeconds(300), "it: idle 120 s"));
        await("six rows", WAIT, () -> count("SELECT count(*) FROM ship_position WHERE mmsi = ?", m) == 6);
        await("gap rows", WAIT, () -> count("SELECT count(*) FROM ingest_gap WHERE started_at IN (?, ?)",
                OffsetDateTime.ofInstant(gs, ZoneOffset.UTC), OffsetDateTime.ofInstant(later, ZoneOffset.UTC)) == 2);

        Res r = get("/api/v1/ships/" + m + "/track?from=" + b.minusSeconds(60) + "&to=" + b.plusSeconds(60 * 60));
        assertThat(r.status()).isEqualTo(200);
        assertThat(r.header("Content-Type")).startsWith("application/geo+json");
        JsonNode t = r.json();
        JsonNode lines = t.path("geometry").path("coordinates");
        assertThat(lines.size()).as("split at the 28-min silence and at the AIS gap").isEqualTo(3);
        for (JsonNode line : lines) assertThat(line.size()).isEqualTo(2);
        JsonNode segs = t.path("properties").path("segments");
        assertThat(segs.size()).isEqualTo(3);
        for (int i = 0; i < 3; i++) {
            assertThat(Instant.parse(segs.get(i).path("start").asString())).isEqualTo(ts.get(2 * i));
            assertThat(Instant.parse(segs.get(i).path("end").asString())).isEqualTo(ts.get(2 * i + 1));
            assertThat(segs.get(i).path("points").asInt()).isEqualTo(2);
            assertThat(lines.get(i).get(0).get(1).asDouble()).as("line %d starts at its first point (lon, lat)", i).isEqualTo(30.0 + 0.01 * (2 * i));
        }
        assertThat(t.path("points").size()).isEqualTo(6);
        assertThat(t.path("properties").path("points").asInt()).isEqualTo(6);
        assertThat(t.path("properties").path("sampling").asString()).isEqualTo("first_fix_per_60s");
        assertThat(t.path("gaps").size()).as("only the gap overlapping the window").isEqualTo(1);
        assertThat(Instant.parse(t.path("gaps").get(0).path("started_at").asString())).isEqualTo(gs);
        assertThat(Instant.parse(t.path("gaps").get(0).path("ended_at").asString())).isEqualTo(ge);

        JsonNode gaps = get("/api/v1/ais/gaps?from=" + b.minusSeconds(60) + "&to=" + b.plusSeconds(180 * 60)).json();
        List<Instant> starts = new ArrayList<>();
        for (JsonNode g : gaps.path("items")) starts.add(Instant.parse(g.path("started_at").asString()));
        assertThat(starts).containsExactly(gs, later);
        assertThat(gaps.path("meta").path("stale").asBoolean(true)).as("a DB listing is current as of the request").isFalse();
        assertThat(get("/api/v1/ships/" + m + "/track?from=" + b + "&to=" + b.plusSeconds(25 * 3600)).status()).as("> 24 h range").isEqualTo(400);
    }
}
