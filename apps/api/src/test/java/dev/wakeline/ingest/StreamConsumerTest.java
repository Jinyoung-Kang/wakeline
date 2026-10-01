package dev.wakeline.ingest;

import dev.wakeline.platform.support.Receipt;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * REL-7/COR-19: 부트스트랩은 공유 스트림에서 스코프별 최신 엔트리를 찾는다.
 * REL-8: fetched_at 이 현재보다 새 것이 아니면(백로그·중복) 실시간 상태·엔진·WS 를 되돌리지 않는다.
 */
class StreamConsumerTest {
    static final Instant T = Instant.parse("2026-09-27T05:10:00Z");

    static MapRecord<String, String, String> rec(long seq, String scope) {
        Map<String, String> f = new HashMap<>();
        f.put("scope", scope);
        return MapRecord.create(StreamConsumer.S_AIRCRAFT, f).withId(RecordId.of(seq + "-0"));
    }

    /** 최신 → 과거 순 스트림을 흉내 낸 페이지 리더(경계 id 포함). */
    static StreamConsumer.PageReader reader(List<MapRecord<String, String, String>> newestFirst, AtomicInteger calls) {
        return (upper, count) -> {
            calls.incrementAndGet();
            List<MapRecord<String, String, String>> out = new ArrayList<>();
            for (var r : newestFirst) {
                if (upper != null && Long.parseLong(r.getId().getValue().split("-")[0]) > Long.parseLong(upper.split("-")[0])) continue;
                out.add(r);
                if (out.size() == count) break;
            }
            return out;
        };
    }

    @Test void newestPerScope_findsGlobalBeyondFirstPage() {
        List<MapRecord<String, String, String>> s = new ArrayList<>();
        long seq = 1000;
        for (int i = 0; i < 70; i++) s.add(rec(seq--, "region")); // global 일시 중지 — region 만 70건
        s.add(rec(seq--, "global"));
        s.add(rec(seq--, "region"));
        s.add(rec(seq--, "global"));
        AtomicInteger calls = new AtomicInteger();
        var found = StreamConsumer.newestPerScope(reader(s, calls), StreamConsumer.AIRCRAFT_SCOPES, 1000);
        assertThat(found.get("region").getId().getValue()).isEqualTo("1000-0");
        assertThat(found.get("global").getId().getValue()).isEqualTo("930-0");
        assertThat(calls.get()).isEqualTo(2); // 두 스코프를 찾으면 멈춘다
    }

    @Test void newestPerScope_missingScope_andScanLimit() {
        List<MapRecord<String, String, String>> s = new ArrayList<>();
        for (long seq = 500; seq > 380; seq--) s.add(rec(seq, "region"));
        AtomicInteger calls = new AtomicInteger();
        var found = StreamConsumer.newestPerScope(reader(s, calls), StreamConsumer.AIRCRAFT_SCOPES, 1000);
        assertThat(found).containsOnlyKeys("region");
        assertThat(calls.get()).isLessThanOrEqualTo(4); // 끝까지 읽고 멈춘다(무한 반복 없음)
        var limited = StreamConsumer.newestPerScope(reader(s, new AtomicInteger()), StreamConsumer.AIRCRAFT_SCOPES, 10);
        assertThat(limited).containsOnlyKeys("region");
        assertThat(StreamConsumer.newestPerScope(reader(List.of(), new AtomicInteger()), StreamConsumer.AIRCRAFT_SCOPES, 1000)).isEmpty();
    }

    // ---- fetched_at 단조 가드 ----

    final SnapshotStore snapshots = new SnapshotStore();
    final SigmetStore sigmets = new SigmetStore();
    final RadarStore radar = new RadarStore();
    final List<Object> events = new ArrayList<>();
    final StreamConsumer consumer = new StreamConsumer(null, new SchemaValidator(), snapshots, sigmets, radar, events::add,
            JsonMapper.builder().build(), new SimpleMeterRegistry());

    static MapRecord<String, String, String> envelope(String stream, String kind, String scope, Instant fetchedAt, String payload) throws Exception {
        Map<String, String> f = new HashMap<>(Map.of("schema_version", "1", "kind", kind, "scope", scope, "provider", "fixture",
                "fetched_at", fetchedAt.toString(), "raw_ref", "fixture:test", "encoding", "gzip+base64", "count", "1", "run_id", "1"));
        f.put("payload", SchemaContractTest.gz64(payload));
        return MapRecord.create(stream, f).withId(RecordId.of(fetchedAt.toEpochMilli() + "-0"));
    }

    static String aircraftPayload(String hex, Instant t) {
        return """
                {"states":[{"hex":"%s","lat":37.4,"lon":126.4,"alt_ft":30000,"on_ground":false,"seen_at":"%s","provider":"fixture","fetched_at":"%s","quality":0,"estimated":false}]}"""
                .formatted(hex, t, t);
    }

    @Test void olderAircraftEntry_doesNotRollBackSnapshot_butGoesToHistory() throws Exception {
        consumer.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T, aircraftPayload("a00001", T)), true);
        Snapshot live = snapshots.region();
        long v = snapshots.version();
        consumer.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T.minusSeconds(600), aircraftPayload("a00002", T.minusSeconds(600))), true);
        consumer.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T, aircraftPayload("a00001", T)), true); // 중복 재전달
        assertThat(snapshots.region()).isSameAs(live);
        assertThat(snapshots.version()).isEqualTo(v);
        assertThat(events.stream().filter(e -> e instanceof IngestEvents.SnapshotUpdated)).hasSize(1);
        var backlog = events.stream().filter(e -> e instanceof IngestEvents.AircraftBacklog).map(e -> (IngestEvents.AircraftBacklog) e).toList();
        assertThat(backlog).hasSize(2);
        assertThat(backlog.getFirst().states()).extracting(a -> a.hex()).containsExactly("a00002");
        // global 은 자기 스코프 기준 — region 보다 오래된 fetched_at 이어도 적용
        consumer.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "global", T.minusSeconds(60), aircraftPayload("a00003", T.minusSeconds(60))), true);
        assertThat(snapshots.global().states()).containsOnlyKeys("a00003");
        // 새 region 은 적용
        consumer.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T.plusSeconds(10), aircraftPayload("a00004", T.plusSeconds(10))), true);
        assertThat(snapshots.region().states()).containsOnlyKeys("a00004");
    }

    static String sigmetPayload(String id, Instant t) {
        return """
                {"sigmets":[{"id":"%s","fir_id":"RKRR","series_id":"1","hazard":"TS","base_ft":0,"base_source":"assumed_surface","top_ft":null,"top_source":"unknown",
                 "valid_from":"2026-09-27T04:00:00Z","valid_to":"2026-09-27T08:00:00Z","geometry":null,"raw_text":"R","provider":"fixture","fetched_at":"%s"}]}"""
                .formatted(id, t);
    }

    @Test void olderSigmetEntry_isIgnoredLive_butStillGoesToHistoryInStreamOrder() throws Exception {
        consumer.process(envelope(StreamConsumer.S_SIGMET, "sigmet", "-", T, sigmetPayload("NEW:1:1", T)), true);
        var st = sigmets.state();
        consumer.process(envelope(StreamConsumer.S_SIGMET, "sigmet", "-", T.minusSeconds(300), sigmetPayload("OLD:1:1", T.minusSeconds(300))), true);
        consumer.process(envelope(StreamConsumer.S_SIGMET, "sigmet", "-", T, sigmetPayload("NEW:1:1", T)), true);
        assertThat(sigmets.state()).isSameAs(st);
        assertThat(sigmets.state().byId()).containsOnlyKeys("NEW:1:1");
        assertThat(events.stream().filter(e -> e instanceof IngestEvents.SigmetsUpdated)).hasSize(1);
        // API-CONC-1: 이력 이벤트는 백로그·중복까지 스트림 순서대로 모두 나간다(중복 판단은 저장기가 수신 시각으로 한다)
        var history = events.stream().filter(e -> e instanceof IngestEvents.SigmetSetReceived).map(e -> (IngestEvents.SigmetSetReceived) e).toList();
        assertThat(history).extracting(IngestEvents.SigmetSetReceived::fetchedAt).containsExactly(T, T.minusSeconds(300), T);
        assertThat(history.get(1).byId()).containsOnlyKeys("OLD:1:1");
        // 이력 이벤트가 실시간 갱신보다 먼저 — 세트의 SIGMET 행이 그 세트로 만든 알림보다 먼저 순서 큐에 들어간다
        assertThat(events.indexOf(history.getFirst())).isLessThan(events.indexOf(events.stream().filter(e -> e instanceof IngestEvents.SigmetsUpdated).findFirst().orElseThrow()));
    }

    @Test void olderRadarEntry_isIgnored() throws Exception {
        String p = "{\"host\":\"https://tilecache.rainviewer.com\",\"generated\":1,\"past\":[{\"time\":1,\"path\":\"/v2/radar/1\"}]}";
        consumer.process(envelope(StreamConsumer.S_RADAR, "radar", "-", T, p), true);
        var fr = radar.frames();
        consumer.process(envelope(StreamConsumer.S_RADAR, "radar", "-", T.minusSeconds(600), p), true);
        assertThat(radar.frames()).isSameAs(fr);
        assertThat(events.stream().filter(e -> e instanceof IngestEvents.RadarUpdated)).hasSize(1);
    }

    @Test void sigmetStore_republishBumpsVersionKeepsContent() {
        var a = sigmets.replace(T, "awc_isigmet", Map.of());
        var b = sigmets.republish();
        assertThat(b.version()).isGreaterThan(a.version());
        assertThat(b.fetchedAt()).isEqualTo(a.fetchedAt());
        assertThat(b.byId()).isSameAs(a.byId());
        assertThat(sigmets.replaceIfNewer(T, "awc_isigmet", Map.of())).isNull();
        assertThat(sigmets.replaceIfNewer(T.plusSeconds(1), "awc_isigmet", Map.of()).version()).isGreaterThan(b.version());
    }

    // ---------- handle(): DLQ 는 검증 실패만, ACK 는 결과가 durable 해진 뒤(API-CONC-2·8) ----------

    /** Redis 없이 handle() 을 보는 소비자: DLQ·XACK 호출을 기록한다. */
    static final class RecordingConsumer extends StreamConsumer {
        final List<String> deadLettered = new ArrayList<>();
        final List<String> acked = new ArrayList<>();

        RecordingConsumer(SnapshotStore snapshots, org.springframework.context.ApplicationEventPublisher publisher, SimpleMeterRegistry meters) {
            super(null, new SchemaValidator(), snapshots, new SigmetStore(), new RadarStore(), publisher, JsonMapper.builder().build(), meters);
        }

        @Override void deadLetter(MapRecord<String, String, String> r, String reason) { deadLettered.add(r.getId().getValue() + ":" + reason); }
        @Override void acknowledge(String stream, List<String> ids) { acked.addAll(ids); }
    }

    @Test void invalidMessage_isDeadLetteredAndAcknowledged() throws Exception {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        RecordingConsumer c = new RecordingConsumer(new SnapshotStore(), e -> { }, meters);
        var bad = envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T, "{\"states\":[{\"hex\":\"zz\"}]}");
        c.handle(bad);
        c.flushAcks();
        assertThat(c.deadLettered).singleElement().asString().contains("payload:");
        assertThat(c.acked).containsExactly(bad.getId().getValue());
        assertThat(meters.counter("wakeline_stream_messages_total", "result", "rejected").count()).isEqualTo(1.0);
    }

    /** API-CONC-2: 반영 중 오류(예: 리스너 예외가 새어 나옴)는 유효한 메시지를 DLQ 로 보내지 않는다 — 세고 ACK 한다. */
    @Test void applyFailure_isNotDeadLettered() throws Exception {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        RecordingConsumer c = new RecordingConsumer(new SnapshotStore(), e -> { throw new IllegalStateException("engine exploded"); }, meters);
        var ok = envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T, aircraftPayload("a00010", T));
        c.handle(ok);
        c.flushAcks();
        assertThat(c.deadLettered).isEmpty();
        assertThat(c.acked).containsExactly(ok.getId().getValue());
        assertThat(meters.counter("wakeline_stream_messages_total", "result", "apply_error").count()).isEqualTo(1.0);
        assertThat(meters.counter("wakeline_stream_messages_total", "result", "rejected").count()).isZero();
    }

    /** API-CONC-8: 비동기 저장기가 영수증을 잡으면 그 결과가 durable 해질 때까지 ACK 하지 않는다. */
    @Test void ackWaitsUntilTheAsyncWriterReleasesTheReceipt() throws Exception {
        List<Receipt> held = new ArrayList<>();
        RecordingConsumer c = new RecordingConsumer(new SnapshotStore(), e -> {
            if (e instanceof IngestEvents.SnapshotUpdated u) held.add(u.receipt().hold());
        }, new SimpleMeterRegistry());
        var m = envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T, aircraftPayload("a00011", T));
        c.handle(m);
        c.flushAcks();
        assertThat(c.acked).isEmpty();
        assertThat(c.unacked()).isEqualTo(1);
        held.getFirst().release(); // TrackWriter 가 커밋했다
        c.flushAcks();
        assertThat(c.acked).containsExactly(m.getId().getValue());
        assertThat(c.unacked()).isZero();
        // 짝이 맞지 않는 release 는 무시(두 번 ACK 하지 않는다)
        held.getFirst().release();
        c.flushAcks();
        assertThat(c.acked).hasSize(1);
    }

    /** XACK 실패(Redis 장애)는 ACK 를 되돌려 두고 예외를 올린다 — 루프가 재시도하고, 다음 flush 가 빠짐없이 보낸다. */
    @Test void ackFailure_isRequeuedAndRetried() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean redisDown = new java.util.concurrent.atomic.AtomicBoolean(true);
        List<String> acked = new ArrayList<>();
        StreamConsumer c = new StreamConsumer(null, new SchemaValidator(), new SnapshotStore(), new SigmetStore(), new RadarStore(), e -> { },
                JsonMapper.builder().build(), new SimpleMeterRegistry()) {
            @Override void acknowledge(String stream, List<String> ids) {
                if (redisDown.get()) throw new org.springframework.data.redis.RedisConnectionFailureException("down");
                acked.addAll(ids);
            }
        };
        var m = envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T, aircraftPayload("a00012", T));
        c.handle(m);
        org.assertj.core.api.Assertions.assertThatThrownBy(c::flushAcks).isInstanceOf(org.springframework.data.redis.RedisConnectionFailureException.class);
        c.flushAcksQuietly(); // 종료 경로 — 예외를 삼킨다
        redisDown.set(false);
        c.flushAcks();
        assertThat(acked).containsExactly(m.getId().getValue());
    }

    @Test void receiptNone_isInert() {
        assertThat(Receipt.NONE.tracked()).isFalse();
        assertThat(Receipt.NONE.hold()).isSameAs(Receipt.NONE);
        Receipt.NONE.release();
        assertThat(Receipt.NONE.holds()).isZero();
    }

    /** 압축 폭탄: 풀린 크기가 상한을 넘으면 DLQ(힙을 채우지 않는다). */
    @Test void decode_rejectsPayloadsLargerThanTheCap() throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        try (var gz = new java.util.zip.GZIPOutputStream(bos)) {
            byte[] chunk = new byte[1 << 20];
            for (int i = 0; i <= StreamConsumer.MAX_PAYLOAD_BYTES / chunk.length; i++) gz.write(chunk);
        }
        String b64 = java.util.Base64.getEncoder().encodeToString(bos.toByteArray());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> StreamConsumer.decode(b64)).isInstanceOf(java.io.IOException.class).hasMessageContaining("exceeds");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> StreamConsumer.decode(null)).isInstanceOf(java.io.IOException.class);
        assertThat(StreamConsumer.decode(SchemaContractTest.gz64("{}"))).isEqualTo("{}");
    }

    @Test void compareIds_isNumeric() {
        assertThat(StreamConsumer.compareIds("10-0", "9-5")).isPositive();
        assertThat(StreamConsumer.compareIds("5-10", "5-9")).isPositive();
        assertThat(StreamConsumer.compareIds("5", "5-0")).isZero();
        assertThat(StreamConsumer.compareIds("4-99", "5-0")).isNegative();
    }

    // ---------- 수요 스코프 hot·focus(계약 v2 §A3) ----------

    static String hotPayload(String cell, String hex, Instant t) {
        String cellField = cell == null ? "" : "\"cell\":\"" + cell + "\",";
        return """
                {"region":{"lat":35.5,"lon":139.5,"radius_nm":150},%s"states":[{"hex":"%s","lat":35.6,"lon":139.6,"alt_ft":30000,"on_ground":false,"seen_at":"%s","provider":"adsb_fi","fetched_at":"%s","quality":0,"estimated":false}]}"""
                .formatted(cellField, hex, t, t);
    }

    static String focusPayload(List<String> requested, List<String> missing, Instant t, String... hexes) {
        StringBuilder st = new StringBuilder();
        for (String h : hexes) {
            if (!st.isEmpty()) st.append(',');
            st.append("""
                    {"hex":"%s","lat":10.0,"lon":150.0,"alt_ft":36000,"on_ground":false,"seen_at":"%s","provider":"adsb_fi","fetched_at":"%s","quality":0,"estimated":false}"""
                    .formatted(h, t, t));
        }
        String req = requested == null ? "" : "\"requested\":[" + String.join(",", requested.stream().map(x -> "\"" + x + "\"").toList()) + "],";
        String mis = missing == null ? "" : "\"missing\":[" + String.join(",", missing.stream().map(x -> "\"" + x + "\"").toList()) + "],";
        return "{\"region\":null," + req + mis + "\"states\":[" + st + "]}";
    }

    @Test void hot_appliesPerCell_olderGoesToHistory_neverTouchesRegion() throws Exception {
        consumer.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T, aircraftPayload("a00001", T)), true);
        Snapshot region = snapshots.region();
        consumer.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "hot", T.plusSeconds(1), hotPayload("35.5:139.5:150", "b00001", T.plusSeconds(1))), true);
        assertThat(snapshots.region()).isSameAs(region); // 예전에는 region 이 아닌 스코프가 모두 region 을 덮어썼다
        assertThat(snapshots.hot()).containsOnlyKeys("35.5:139.5:150");
        assertThat(snapshots.merged(T.plusSeconds(2))).containsKeys("a00001", "b00001");
        var upd = events.stream().filter(e -> e instanceof IngestEvents.SnapshotUpdated).map(e -> (IngestEvents.SnapshotUpdated) e).toList();
        assertThat(upd.getLast().current().scope()).isEqualTo("hot");
        assertThat(upd.getLast().previous().states()).isEmpty();
        // 같은 셀의 오래된 메시지 → 항적만
        consumer.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "hot", T, hotPayload("35.5:139.5:150", "b00002", T)), true);
        var backlog = events.stream().filter(e -> e instanceof IngestEvents.AircraftBacklog).map(e -> (IngestEvents.AircraftBacklog) e).toList();
        assertThat(backlog).singleElement().satisfies(b -> {
            assertThat(b.scope()).isEqualTo("hot");
            assertThat(b.states()).extracting(dev.wakeline.domain.AircraftState::hex).containsExactly("b00002");
        });
    }

    @Test void hot_withoutValidCell_isRejected() throws Exception {
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> consumer.parse(
                        envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "hot", T, hotPayload(null, "b00003", T))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("cell");
        // 스키마 패턴은 통과하지만 위도 ±85 밖
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> consumer.parse(
                        envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "hot", T, hotPayload("89.5:10.0:50", "b00003", T))))
                .isInstanceOf(IllegalArgumentException.class);
        // 항공기 메시지에 선박 스코프
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> consumer.parse(
                        envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "ships", T, aircraftPayload("b00004", T))))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("scope");
    }

    @Test void focus_dropsUnrequested_appliesPerHex_allMissingIsNoOp() throws Exception {
        SimpleMeterRegistry meters = new SimpleMeterRegistry();
        List<Object> ev = new ArrayList<>();
        StreamConsumer c = new StreamConsumer(null, new SchemaValidator(), snapshots, sigmets, radar, ev::add, JsonMapper.builder().build(), meters);
        c.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "focus", T,
                focusPayload(List.of("c00001", "c00002"), List.of("c00002"), T, "c00001", "c00009")), true);
        assertThat(snapshots.focus()).containsOnlyKeys("c00001"); // c00009 는 요청하지 않은 hex
        assertThat(meters.counter("wakeline_focus_unrequested_total").count()).isEqualTo(1.0);
        var upd = (IngestEvents.SnapshotUpdated) ev.getLast();
        assertThat(upd.current().scope()).isEqualTo("focus");
        assertThat(upd.current().states()).containsOnlyKeys("c00001");
        // 모두 missing → 반영할 관측 없음(이벤트 없음)
        int n = ev.size();
        c.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "focus", T.plusSeconds(5), focusPayload(List.of("c00001"), List.of("c00001"), T.plusSeconds(5))), true);
        assertThat(ev).hasSize(n);
        // 임대에서 빠진 hex 의 메시지 → 실시간 상태엔 넣지 않고 항적만
        snapshots.setLeases(java.util.Set.of(), java.util.Set.of("c00002"));
        c.process(envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "focus", T.plusSeconds(10), focusPayload(List.of("c00001"), null, T.plusSeconds(10), "c00001")), true);
        assertThat(snapshots.focus()).isEmpty();
        assertThat(ev.getLast()).isInstanceOf(IngestEvents.AircraftBacklog.class);
        assertThat(((IngestEvents.AircraftBacklog) ev.getLast()).scope()).isEqualTo("focus");
    }
}
