package dev.wakeline.ingest;

import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.weather.core.RadarStore;
import dev.wakeline.weather.core.SigmetStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.core.StreamOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import tools.jackson.databind.json.JsonMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 스트림 소비자의 오류 · 회수 갈래(QA 2026-10 보고 §7-5 '시험 공백 — 위험 경로'). Redis 는 목(mock) — 이 시험은 소비자의 판단만 본다
 * (실제 Redis 로 도는 소비 · PEL 재처리 · 보존 창 손실은 IngestIT · StreamTrimLossIT).
 */
class StreamConsumerFailureTest {
    static final Instant T = Instant.parse("2026-10-03T01:00:00Z");
    final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    final List<String> acked = new ArrayList<>();

    @SuppressWarnings({"unchecked", "rawtypes"})
    static StreamOperations<String, Object, Object> streamOps(StringRedisTemplate redis) {
        StreamOperations ops = mock(StreamOperations.class);
        when(redis.opsForStream()).thenReturn(ops);
        return ops;
    }

    StreamConsumer consumer(StringRedisTemplate redis) { return consumer(redis, e -> { }); }

    StreamConsumer consumer(StringRedisTemplate redis, org.springframework.context.ApplicationEventPublisher events) {
        return new StreamConsumer(redis, new SchemaValidator(), new SnapshotStore(), new SigmetStore(), new RadarStore(), events,
                JsonMapper.builder().build(), meters) {
            @Override void acknowledge(String stream, List<String> ids) { acked.addAll(ids); }
        };
    }

    /** 돌고 있는(running) 소비자 — 선행 구성 요소가 준비되지 않아 소비 루프는 Redis 를 건드리지 않고 기다린다(PEL 재처리는 시험이 직접 부른다). */
    StreamConsumer runningConsumer(StringRedisTemplate redis, org.springframework.context.ApplicationEventPublisher events) {
        dev.wakeline.platform.support.StreamPrerequisite neverReady = new dev.wakeline.platform.support.StreamPrerequisite() {
            @Override public void start() { }
            @Override public void stop() { }
            @Override public boolean isRunning() { return false; }
        };
        StreamConsumer c = new StreamConsumer(redis, new SchemaValidator(), new SnapshotStore(), new SigmetStore(), new RadarStore(),
                new dev.wakeline.ships.core.ShipStore(), null, events, JsonMapper.builder().build(), meters, List.of(neverReady)) {
            @Override void acknowledge(String stream, List<String> ids) { acked.addAll(ids); }
        };
        c.start();
        return c;
    }

    /**
     * 검증에 실패한 메시지는 DLQ 에 남긴 뒤 ACK 한다. DLQ 를 쓰지 못하면(Redis 가 잠깐 끊김 등) ACK 하지 않는다 — PEL 에 남아 다음 PEL 재처리(소비 루프의
     * 재시도 · 다시 기동)에서 다시 DLQ 로 간다. 예전에는 ERROR 한 줄을 남기고 ACK 해 그 메시지는 DLQ 에도 PEL 에도 없었다(운영자가 볼 수 없다).
     */
    @Test
    @SuppressWarnings("unchecked")
    void anInvalidMessageWhoseDeadLetterCannotBeWrittenStaysPendingAndGoesToTheDlqOnRetry() throws Exception {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        StreamOperations<String, Object, Object> ops = streamOps(redis);
        doThrow(new RedisConnectionFailureException("Unable to connect to Redis")).when(ops).add(any(MapRecord.class));
        StreamConsumer c = consumer(redis);
        MapRecord<String, String, String> bad = StreamConsumerTest.envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T, "{\"states\":[{\"hex\":\"zz\"}]}");

        c.handle(bad);
        c.flushAcks();
        assertThat(acked).as("not in the DLQ — must stay in the PEL, not be acknowledged").isEmpty();

        doReturn(RecordId.of("1-0")).when(ops).add(any(MapRecord.class)); // DLQ 를 다시 쓸 수 있다 — PEL 재처리가 같은 메시지를 다시 다룬다
        c.handle(bad);
        c.flushAcks();
        assertThat(acked).containsExactly(bad.getId().getValue());
    }

    /**
     * PEL 재처리(회수): 이 프로세스에서 아직 저장 중인 메시지(영수증이 풀리지 않음 — 소비 루프가 오류로 다시 돌며 PEL 을 다시 훑는 경우)는 다시 다루지 않는다
     * (같은 메시지를 두 번 반영 · 영수증을 두 번 잡지 않게). 다른 대기 메시지는 다시 다루고, 스트림에서 이미 잘린 것은 되살릴 수 없으므로 ACK 하고 센다.
     * 저장 중이던 메시지는 저장이 끝나면 한 번만 ACK 된다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void pendingReprocessingSkipsAMessageStillBeingWrittenReprocessesTheRestAndAcknowledgesTrimmedOnes() throws Exception {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        StreamOperations<String, Object, Object> ops = streamOps(redis);
        List<dev.wakeline.platform.support.Receipt> writer = new ArrayList<>(); // 저장기가 쥔 영수증(첫 스냅샷만 — 아직 쓰는 중)
        StreamConsumer c = runningConsumer(redis, e -> {
            if (e instanceof dev.wakeline.aircraft.core.AircraftEvents.SnapshotUpdated u && writer.isEmpty()) writer.add(u.receipt().hold());
        });
        String s = StreamConsumer.S_AIRCRAFT;
        MapRecord<String, String, String> a = StreamConsumerTest.envelope(s, "aircraft", "region", T, StreamConsumerTest.aircraftPayload("a00001", T));
        Instant t2 = T.plusSeconds(10);
        MapRecord<String, String, String> b = StreamConsumerTest.envelope(s, "aircraft", "region", t2, StreamConsumerTest.aircraftPayload("a00002", t2));
        String trimmedId = T.plusSeconds(20).toEpochMilli() + "-0";
        c.handle(a); // 저장 중(영수증을 저장기가 쥐고 있다)
        c.flushAcks();
        assertThat(acked).isEmpty();

        org.springframework.data.redis.connection.stream.Consumer who =
                org.springframework.data.redis.connection.stream.Consumer.from(StreamConsumer.GROUP, StreamConsumer.CONSUMER);
        java.util.function.Function<String, org.springframework.data.redis.connection.stream.PendingMessage> pm = id ->
                new org.springframework.data.redis.connection.stream.PendingMessage(RecordId.of(id), who, java.time.Duration.ofSeconds(5), 1);
        String aId = a.getId().getValue(), bId = b.getId().getValue();
        when(ops.pending(org.mockito.ArgumentMatchers.eq(s), any(org.springframework.data.redis.connection.stream.Consumer.class),
                any(org.springframework.data.domain.Range.class), org.mockito.ArgumentMatchers.anyLong()))
                .thenReturn(new org.springframework.data.redis.connection.stream.PendingMessages(StreamConsumer.GROUP, List.of(pm.apply(aId), pm.apply(bId), pm.apply(trimmedId))))
                .thenReturn(new org.springframework.data.redis.connection.stream.PendingMessages(StreamConsumer.GROUP, List.of(pm.apply(trimmedId)))); // 경계(포함)만 — 끝
        when(ops.range(org.mockito.ArgumentMatchers.eq(s), any(org.springframework.data.domain.Range.class))).thenAnswer(inv -> {
            org.springframework.data.domain.Range<String> r = inv.getArgument(1);
            String id = r.getLowerBound().getValue().orElseThrow();
            return id.equals(aId) ? List.of(a) : id.equals(bId) ? List.of(b) : List.of(); // 잘린 엔트리는 없다
        });

        c.drainPending(s);
        c.flushAcks();
        assertThat(meters.counter("wakeline_stream_messages_total", "result", "ok").count()).as("a 한 번 + b 한 번 — a 를 다시 다루지 않았다").isEqualTo(2.0);
        assertThat(meters.counter("wakeline_stream_messages_total", "result", "trimmed").count()).isEqualTo(1.0);
        assertThat(acked).as("b(다시 다룸) · 잘린 것은 ACK, a 는 아직 저장 중").containsExactlyInAnyOrder(bId, trimmedId);

        writer.getFirst().release(); // 저장 끝 — 한 번만 ACK
        c.flushAcks();
        assertThat(acked).containsExactlyInAnyOrder(bId, trimmedId, aId);
        assertThat(c.unacked()).isZero();
        c.stop();
    }

    /**
     * ACK 는 스트림별로 ACK_BATCH(1,000)개 이하씩 묶어 보낸다 — 명령 하나가 커지지 않게. 한 번의 flush 는 ACK_BATCH 이상 남아 있는 동안 묶음을 이어 보내고,
     * 그보다 적게 남은 꼬리는 다음 flush 에 간다(소비 루프는 읽을 때마다 — BLOCK 2 s — flush 하고, 종료 때는 루프 끝 · StreamAckFinalizer 가 한 번씩).
     */
    @Test
    @SuppressWarnings("unchecked")
    void acknowledgementsAreSentInBatchesOfAtMostAckBatch() throws Exception {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        StreamOperations<String, Object, Object> ops = streamOps(redis);
        doReturn(RecordId.of("1-0")).when(ops).add(any(MapRecord.class)); // DLQ 쓰기 성공
        List<Integer> batches = new ArrayList<>();
        StreamConsumer c = new StreamConsumer(redis, new SchemaValidator(), new SnapshotStore(), new SigmetStore(), new RadarStore(), e -> { },
                JsonMapper.builder().build(), meters) {
            @Override void acknowledge(String stream, List<String> ids) { batches.add(ids.size()); acked.addAll(ids); }
        };
        int n = 2 * StreamConsumer.ACK_BATCH + 5;
        for (int i = 0; i < n; i++)
            c.handle(StreamConsumerTest.envelope(StreamConsumer.S_AIRCRAFT, "aircraft", "region", T.plusMillis(i), "{\"states\":[{\"hex\":\"zz\"}]}"));
        c.flushAcks();
        assertThat(batches).containsExactly(StreamConsumer.ACK_BATCH, StreamConsumer.ACK_BATCH);
        c.flushAcks(); // 다음 flush 가 꼬리를 보낸다
        assertThat(batches).containsExactly(StreamConsumer.ACK_BATCH, StreamConsumer.ACK_BATCH, 5);
        assertThat(acked).hasSize(n).doesNotHaveDuplicates();
    }
}
