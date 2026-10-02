package dev.wakeline.it;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.api.model.ContainerPort;
import dev.wakeline.DbTestSupport;
import dev.wakeline.aircraft.data.TrackWriter;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import org.testcontainers.DockerClientFactory;

import java.net.URI;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * DB 가 돌아오면 백오프로 쉬던 저장기가 곧바로 다시 쓴다(QA 2026-10 신뢰성 개선 제안 5 · ADR-032 개정). 저장기는 일시 장애마다 백오프(항적 2 s → 30 s)로
 * 쉬는데, 예전에는 DB 가 돌아와도 그 쉼을 끝까지 기다렸다 — QA db-pause-60: 'retry in 30000 ms' 뒤 첫 쓰기까지 30 s, ADR-032 재검증 db-pause-75:
 * writer_backlog 가 풀리기까지 22 s.
 * <p>이 시험: DB 컨테이너를 멈추고(docker pause) 항공기 스냅샷을 1 s 마다 넣어 항적 저장기에 행을 쌓는다. 가장 오래된 미기록 행이 35 s 를 넘으면(저장기가
 * 이미 긴 백오프에 들어가 있다) 다시 풀고, 쌓인 행이 모두 쓰일 때까지 걸린 시간을 잰다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class DbPausedWriterRecoveryIT extends IntegrationTest {
    /** 다시 푼 뒤 저장기가 다시 쓰기까지의 상한 — 백오프 상한(30 s)이 아니라 확인 간격(2 s) + 쓰기. */
    static final long RECOVERY_MAX_MS = 6_000;
    static final long PAUSED_BACKLOG_MS = 35_000;

    @Autowired TrackWriter tracks;

    private static String dbContainerId() {
        int mapped = URI.create(DbTestSupport.jdbcUrl(ItStack.DB).substring("jdbc:".length())).getPort();
        DockerClient docker = DockerClientFactory.instance().client();
        for (Container c : docker.listContainersCmd().exec())
            for (ContainerPort p : c.getPorts())
                if (p.getPublicPort() != null && p.getPublicPort() == mapped) return c.getId();
        throw new IllegalStateException("db test container not found on port " + mapped);
    }

    private static void snapshot(int i) {
        Instant fr = Streams.nextFetchedAt();
        Streams.xadd(Streams.AIRCRAFT, Streams.aircraft("region", fr, List.of(
                Streams.state(String.format("db%04x", i), 36.0 + i * 0.001, 128.0, 30000, fr, fr))));
    }

    @Test
    void writersInBackoffWriteAgainSoonAfterTheDatabaseAnswers() throws Exception {
        await("track writer idle before the pause", java.time.Duration.ofSeconds(20), () -> tracks.oldestPendingAtMs() == -1);
        DockerClient docker = DockerClientFactory.instance().client();
        String id = dbContainerId();
        long unpausedAt;
        int sent = 0;
        docker.pauseContainerCmd(id).exec();
        try {
            long deadline = System.currentTimeMillis() + 120_000;
            while (System.currentTimeMillis() < deadline) {
                snapshot(sent++);
                long at = tracks.oldestPendingAtMs();
                if (at > 0 && System.currentTimeMillis() - at >= PAUSED_BACKLOG_MS) break;
                Thread.sleep(1_000);
            }
            assertThat(System.currentTimeMillis() - tracks.oldestPendingAtMs()).as("rows waited while the database was paused").isGreaterThanOrEqualTo(PAUSED_BACKLOG_MS);
        } finally {
            docker.unpauseContainerCmd(id).exec();
            unpausedAt = System.currentTimeMillis();
        }
        long deadline = unpausedAt + 60_000;
        while (tracks.oldestPendingAtMs() != -1 && System.currentTimeMillis() < deadline) Thread.sleep(50);
        long recoveryMs = System.currentTimeMillis() - unpausedAt;
        System.out.printf("db paused: %d snapshots queued, backlog cleared %d ms after unpause%n", sent, recoveryMs);
        assertThat(tracks.oldestPendingAtMs()).as("backlog cleared within 60 s").isEqualTo(-1);
        assertThat(recoveryMs).as("the writer does not sleep out its backoff (up to 30 s) once the database answers").isLessThan(RECOVERY_MAX_MS);
    }
}
