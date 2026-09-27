package dev.skywx.ingest;

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

    @Test void olderSigmetEntry_isIgnored() throws Exception {
        consumer.process(envelope(StreamConsumer.S_SIGMET, "sigmet", "-", T, sigmetPayload("NEW:1:1", T)), true);
        var st = sigmets.state();
        consumer.process(envelope(StreamConsumer.S_SIGMET, "sigmet", "-", T.minusSeconds(300), sigmetPayload("OLD:1:1", T.minusSeconds(300))), true);
        consumer.process(envelope(StreamConsumer.S_SIGMET, "sigmet", "-", T, sigmetPayload("NEW:1:1", T)), true);
        assertThat(sigmets.state()).isSameAs(st);
        assertThat(sigmets.state().byId()).containsOnlyKeys("NEW:1:1");
        assertThat(events.stream().filter(e -> e instanceof IngestEvents.SigmetsUpdated)).hasSize(1);
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
}
