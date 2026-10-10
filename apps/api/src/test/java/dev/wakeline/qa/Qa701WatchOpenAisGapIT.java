package dev.wakeline.qa;

import dev.wakeline.it.IntegrationTest;
import dev.wakeline.it.ItStack;
import dev.wakeline.ships.core.AisStatus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-701(출시 QA 2차 · 기능): GET /api/v1/watch 의 ais_last_gap 은 "마지막 AIS 수신 공백 {started_at, ended_at?, reason}"(계약 v5 §G50)이고
 * ADR-037 §3 은 선박 끊김 사건에 "열린 AIS 공백의 까닭"을 붙인다고 한다. 그런데 WatchController 는 ShipStore.lastGap()(끝난 공백만 — addGap 이 열린 공백을
 * 거절한다)을 실어, 지금 진행 중인 공백(상태 해시 gap_open_since — AisStatus)은 결코 나오지 않는다. 웹(lib/watch diffWatch)의 "AIS 수신 공백 중(까닭)"
 * 문구는 ended_at 이 없을 때만 붙으므로 영영 보이지 않는다.
 * 재현: 수집기(ais) 상태 해시에 열린 공백을 쓰고 api 가 읽은 뒤 /watch?ships=… → ais_last_gap 이 그 열린 공백(ended_at 없음)이어야 한다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa701WatchOpenAisGapIT extends IntegrationTest {
    static final HttpClient HTTP = HttpClient.newHttpClient();
    @Autowired AisStatus aisStatus;

    @Test
    void anOngoingAisGapIsReportedAsOpen() throws Exception {
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Instant since = now.minusSeconds(900);
        try {
            ItStack.hset(ItStack.ais(), AisStatus.KEY, Map.of("provider", "fixture", "connected", "0", "state", "reconnecting",
                    "updated_at", now.toString(), "last_msg_at", since.toString(), "gap_open_since", since.toString(), "gap_reason", "ws_closed"));
            long end = System.currentTimeMillis() + 20_000;
            while (aisStatus.current().openGaps().isEmpty() && System.currentTimeMillis() < end) Thread.sleep(200);
            assertThat(aisStatus.current().openGaps()).as("api read the open gap from the status hash").isNotEmpty();

            HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1/watch?ships=440700099"))
                    .timeout(Duration.ofSeconds(15)).build(), HttpResponse.BodyHandlers.ofString());
            assertThat(r.statusCode()).isEqualTo(200);
            JsonNode gap = JsonMapper.builder().build().readTree(r.body()).path("ais_last_gap");
            assertThat(gap.isMissingNode() || gap.isNull()).as("ais_last_gap present: %s", r.body()).isFalse();
            assertThat(Instant.parse(gap.path("started_at").asString())).isEqualTo(since);
            assertThat(gap.has("ended_at")).as("open gap has no ended_at: %s", gap).isFalse();
            assertThat(gap.path("reason").asString()).isEqualTo("ws_closed");
        } finally {
            ItStack.hset(ItStack.ais(), AisStatus.KEY, Map.of("connected", "1", "state", "live", "updated_at", Instant.now().toString(), "gap_open_since", ""));
        }
    }
}
