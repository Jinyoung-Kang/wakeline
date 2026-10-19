package dev.wakeline.weather.web;

import dev.wakeline.DbTestSupport;
import dev.wakeline.airspace.AirspaceFixtures;
import dev.wakeline.airspace.core.AirspaceRecord;
import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.airspace.core.AirspaceZones;
import dev.wakeline.airspace.data.AirspaceRefresher;
import dev.wakeline.platform.data.OrderedWriter;
import dev.wakeline.weather.core.SigmetRecord;
import dev.wakeline.weather.core.SigmetStore;
import dev.wakeline.weather.data.AlertRepository;
import dev.wakeline.weather.data.SigmetRepository;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 메모리 사본(AlertCopies — 열린 알림의 사본을 DB 에서 못 읽을 때)이 DB 사본(AlertRepository.sigmetCopy · airspaceCopy)과 같은 키 · 같은 순서 · 같은 값인가를
 * 실제 PostGIS 의 같은 행으로 대조한다 — DB 사본에 열이 늘면 여기서 깨진다(웹 근거 화면은 두 길을 같은 모양으로 읽는다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class AlertCopiesDbTest {
    static final Instant T0 = Instant.now().truncatedTo(ChronoUnit.SECONDS);

    @Test
    void memoryCopiesHaveTheSameKeysAndValuesAsTheStoredCopies() {
        DbTestSupport.reset();
        JdbcClient api = DbTestSupport.apiClient();
        AlertRepository alerts = new AlertRepository(api, DbTestSupport.JSON, mock(SigmetRepository.class), new SigmetStore(), mock(OrderedWriter.class),
                new SimpleMeterRegistry());

        SigmetRepository sigmets = new SigmetRepository(api, DbTestSupport.JSON, mock(OrderedWriter.class));
        for (SigmetRecord s : List.of(
                new SigmetRecord("RKRR:C1", "RKRR", "INCHEON FIR", "RKSI", "C1", "TS", "EMBD", 0, 40_000, T0.minusSeconds(600), T0.plusSeconds(3600), null,
                        null, null, null, null, "RKRR SIGMET C1 VALID EMBD TS OBS", "awc_isigmet", T0, SigmetRecord.BASE_JSON, SigmetRecord.TOP_RAW_TEXT_LOWER_BOUND),
                new SigmetRecord("RKRR:C2", "RKRR", null, "RKSI", "C2", "ICE", null, 0, null, T0.minusSeconds(600), T0.plusSeconds(3600), null,
                        null, null, null, null, "RKRR SIGMET C2 VALID SEV ICE", "awc_isigmet", T0, SigmetRecord.BASE_ASSUMED_SURFACE, SigmetRecord.TOP_UNKNOWN))) {
            sigmets.upsert(s);
            Map<String, Object> stored = alerts.sigmetCopy(s.id());
            Map<String, Object> memory = AlertCopies.sigmet(s);
            assertThat(List.copyOf(memory.keySet())).as(s.id()).isEqualTo(List.copyOf(stored.keySet()));
            assertThat(memory).as(s.id()).isEqualTo(stored);
        }

        String sha = "%064x".formatted(System.nanoTime());
        AirspaceFixtures.insertEdition(sql -> DbTestSupport.admin().sql(sql).update(), sha, "합성 시험", true, AirspaceFixtures.defaults());
        AirspaceStore store = new AirspaceStore();
        new AirspaceRefresher(api, store, DbTestSupport.JSON, new AirspaceZones(store)).refresh();
        AirspaceStore.Snapshot snap = store.snapshot();
        assertThat(snap.records()).hasSize(AirspaceFixtures.defaults().size());
        for (AirspaceRecord r : snap.records()) {
            Map<String, Object> stored = alerts.airspaceCopy(r.id());
            Map<String, Object> memory = AlertCopies.airspace(snap, r.id());
            assertThat(List.copyOf(memory.keySet())).as(r.label()).isEqualTo(List.copyOf(stored.keySet()));
            assertThat(memory).as(r.label()).isEqualTo(stored);
        }
    }
}
