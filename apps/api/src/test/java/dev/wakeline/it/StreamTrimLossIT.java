package dev.wakeline.it;

import dev.wakeline.ingest.StreamConsumer;
import io.micrometer.core.instrument.MeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.connection.stream.StreamInfo;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * R-14(api 부분): api 가 멈춘 동안 스트림 보존 창(MAXLEN)을 넘어 읽지 못한 엔트리가 지워졌으면, 소비를 다시 시작할 때(첫 읽기 전)
 * 그룹이 읽지 않은 엔트리 수와 남은 엔트리 수를 비교해 손실로 센다(지표) · 구간을 기억한다. 조용히 건너뛰지 않는다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class StreamTrimLossIT extends IntegrationTest {
    static final Duration WAIT = Duration.ofSeconds(15);

    @Autowired StreamConsumer consumer;
    @Autowired MeterRegistry meters;

    double lossEvents(String stream) {
        var c = meters.find("wakeline_stream_trim_loss_events_total").tag("stream", stream).counters();
        return c.stream().mapToDouble(io.micrometer.core.instrument.Counter::count).sum();
    }

    static String lastDelivered(String stream) {
        StreamInfo.XInfoGroups groups = ItStack.admin().opsForStream().groups(stream);
        for (StreamInfo.XInfoGroup g : groups) if (StreamConsumer.GROUP.equals(g.groupName())) return g.lastDeliveredId();
        throw new AssertionError("no group " + StreamConsumer.GROUP + " on " + stream);
    }

    static Instant idTime(String id) { return Instant.ofEpochMilli(Long.parseLong(id.split("-")[0])); }

    @Test
    void entriesTrimmedBeforeTheApiReadThemAreCountedWithTheirWindowWhenConsumingResumes() throws Exception {
        String stream = Streams.RADAR;
        Instant f0 = Streams.nextFetchedAt();
        String first = Streams.xadd(stream, Streams.radar(f0, f0.getEpochSecond() - f0.getEpochSecond() % 600));
        await("first entry consumed", WAIT, () -> StreamConsumerIds.compare(lastDelivered(stream), first) >= 0);
        double before = lossEvents(stream);
        String lastRead;
        List<String> ids = new ArrayList<>();
        consumer.stop();
        try {
            lastRead = lastDelivered(stream);
            Thread.sleep(5); // 새 엔트리의 ms 가 마지막 전달 id 와 겹치지 않게
            for (int i = 0; i < 3; i++) {
                Instant f = Streams.nextFetchedAt();
                ids.add(Streams.xadd(stream, Streams.radar(f, f.getEpochSecond() - f.getEpochSecond() % 600)));
                Thread.sleep(2);
            }
            // api 가 멈춘 동안 수집기가 계속 발행해 보존 창(MAXLEN)이 넘친 것과 같다: 읽지 않은 앞의 두 엔트리가 지워진다
            ItStack.admin().opsForStream().trim(stream, 1);
        } finally {
            consumer.start();
        }
        await("trim loss counted", WAIT, () -> lossEvents(stream) >= before + 1);
        assertThat(lossEvents(stream)).isEqualTo(before + 1);
        StreamConsumer.TrimLoss loss = consumer.lastTrimLoss();
        assertThat(loss).isNotNull();
        assertThat(loss.stream()).isEqualTo(stream);
        assertThat(loss.from()).as("window starts at the last entry the api had read").isEqualTo(idTime(lastRead));
        assertThat(loss.to()).as("window ends at the first entry still in the stream (the lost ones were before it)").isEqualTo(idTime(ids.get(2)));
        assertThat(loss.kind()).isEqualTo("unread");
        assertThat(consumer.trimLossEvents()).isGreaterThanOrEqualTo(1);

        // 남은 엔트리는 그대로 소비된다 — 같은 손실을 다시 세지 않는다(소비 재시작)
        await("remaining entry consumed", WAIT, () -> StreamConsumerIds.compare(lastDelivered(stream), ids.get(2)) >= 0);
        consumer.stop();
        consumer.start();
        Thread.sleep(500);
        assertThat(lossEvents(stream)).as("no double count after a restart once the gap was passed").isEqualTo(before + 1);
    }

    /** 읽었지만 저장(ACK) 전에 잘린 PEL 엔트리도 손실 구간으로 센다(kind=pending) — 이전 프로세스가 읽고 죽은 경우. */
    @Test
    void aPendingEntryTrimmedBeforeItWasPersistedIsALossWindowToo() throws Exception {
        String stream = Streams.RADAR;
        double before = lossEvents(stream);
        String id;
        consumer.stop();
        try {
            Instant f = Streams.nextFetchedAt();
            id = Streams.xadd(stream, Streams.radar(f, f.getEpochSecond() - f.getEpochSecond() % 600));
            var read = ItStack.apiUser().opsForStream().read(org.springframework.data.redis.connection.stream.Consumer.from(StreamConsumer.GROUP, StreamConsumer.CONSUMER),
                    org.springframework.data.redis.connection.stream.StreamReadOptions.empty().count(10),
                    org.springframework.data.redis.connection.stream.StreamOffset.create(stream, org.springframework.data.redis.connection.stream.ReadOffset.lastConsumed()));
            assertThat(read).extracting(r -> r.getId().getValue()).contains(id);
            ItStack.admin().opsForStream().delete(stream, id); // MAXLEN 으로 잘린 것과 같다
        } finally {
            consumer.start();
        }
        await("pending trim loss counted", WAIT, () -> lossEvents(stream) >= before + 1);
        StreamConsumer.TrimLoss loss = consumer.lastTrimLoss();
        assertThat(loss.kind()).isEqualTo("pending");
        assertThat(loss.stream()).isEqualTo(stream);
        assertThat(loss.from()).isEqualTo(idTime(id));
        assertThat(loss.to()).isEqualTo(idTime(id));
    }

    /** 읽은 엔트리만 지워졌으면(평상시 MAXLEN 트림) 손실이 아니다. */
    @Test
    void trimmingOnlyAlreadyReadEntriesIsNotALoss() throws Exception {
        String stream = Streams.RADAR;
        Instant f = Streams.nextFetchedAt();
        String id = Streams.xadd(stream, Streams.radar(f, f.getEpochSecond() - f.getEpochSecond() % 600));
        await("consumed", WAIT, () -> StreamConsumerIds.compare(lastDelivered(stream), id) >= 0);
        double before = lossEvents(stream);
        consumer.stop();
        try {
            ItStack.admin().opsForStream().trim(stream, 0);
        } finally {
            consumer.start();
        }
        Thread.sleep(1000);
        assertThat(lossEvents(stream)).isEqualTo(before);
    }

    /** 스트림 id(ms-seq) 비교. */
    static final class StreamConsumerIds {
        static int compare(String a, String b) {
            String[] x = a.split("-"), y = b.split("-");
            int c = Long.compare(Long.parseLong(x[0]), Long.parseLong(y[0]));
            return c != 0 ? c : Long.compare(Long.parseLong(x[1]), Long.parseLong(y[1]));
        }
    }
}
