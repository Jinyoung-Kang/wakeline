package dev.wakeline.qa;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.api.model.ContainerPort;
import dev.wakeline.DbTestSupport;
import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import dev.wakeline.platform.data.Sql;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.testcontainers.DockerClientFactory;

import java.net.URI;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-104 재현: 공개 조회 문장 상한 3 s(R-62 · Sql.PUBLIC_READ_TIMEOUT_S)는 DB 서버가 답하지 않으면(멈춘 VM · 끊긴 망 — 여기서는 docker pause) 지켜지지 않는다.
 * 공유 풀에는 pgjdbc socketTimeout 이 없어(application.yml spring.datasource.hikari — 선택 조회 읽기 풀 ReadPool 만 SOCKET_TIMEOUT_S) 드라이버가 보내는
 * 취소가 서버에 닿을 때까지 읽기가 소켓에서 기다린다. 스택 B: /api/v1/replay 가 elapsed_ms=45078(pause 45 s 내내) · edge 는 30 s 에 504(Retry-After 없음),
 * 공개 조회 허가 · 공유 풀 연결도 그동안 묶였다(evidence/reliability/db-frozen-reads).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa104FrozenDbPublicReadIT extends IntegrationTest {
    static final long PAUSE_MS = 15_000;

    private static String dbContainerId() {
        int mapped = URI.create(DbTestSupport.jdbcUrl(ItStack.DB).substring("jdbc:".length())).getPort();
        DockerClient docker = DockerClientFactory.instance().client();
        for (Container c : docker.listContainersCmd().exec())
            for (ContainerPort p : c.getPorts())
                if (p.getPublicPort() != null && p.getPublicPort() == mapped) return c.getId();
        throw new IllegalStateException("db test container not found on port " + mapped);
    }

    @Test
    void aPublicReadInFlightWhenTheDatabaseStopsAnsweringEndsWithinItsStatementLimit() throws Exception {
        assertThat(Sql.publicRead(db, "qa.frozen_warmup", "SELECT 1").query(Integer.class).single()).isEqualTo(1);
        DockerClient docker = DockerClientFactory.instance().client();
        String id = dbContainerId();
        long t0 = System.nanoTime();
        CompletableFuture<String> read = CompletableFuture.supplyAsync(() -> {
            try {
                return "ok " + Sql.publicRead(db, "qa.frozen_read", "SELECT 1 FROM pg_sleep(1)").query(Integer.class).single();
            } catch (RuntimeException e) {
                return "failed " + e.getClass().getSimpleName();
            }
        });
        Thread.sleep(300); // 문장이 서버에 간 뒤에 멈춘다
        docker.pauseContainerCmd(id).exec();
        String outcome;
        long tookMs;
        try {
            outcome = read.get(PAUSE_MS, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException e) {
            outcome = "still waiting";
        } finally {
            docker.unpauseContainerCmd(id).exec();
        }
        if ("still waiting".equals(outcome)) outcome = "still waiting → " + read.get(30, TimeUnit.SECONDS);
        tookMs = (System.nanoTime() - t0) / 1_000_000;
        assertThat(tookMs).as("공개 조회(문장 상한 %d s)가 DB 가 멈춘 동안 끝나야 한다 — 결과: %s, 걸린 시간 %d ms(pause %d ms)",
                Sql.PUBLIC_READ_TIMEOUT_S, outcome, tookMs, PAUSE_MS).isLessThan(Sql.PUBLIC_READ_TIMEOUT_S * 1000L + 3_000);
    }
}
