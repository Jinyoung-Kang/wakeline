package dev.wakeline.qa;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.watch.RecentClosedAlerts;
import dev.wakeline.watch.WatchController;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.data.AirportRepository;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.CannotGetJdbcConnectionException;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * QA-600(출시 QA 2차 · 신뢰성): GET /api/v1/watch 는 항공기 · 선박 · 알림을 메모리에서, 공항(최신 METAR)만 DB 에서 답한다(ADR-037 §2). DB 가 안 되면
 * 공항 조회 하나 때문에 응답 전체가 503 — 메모리 값(관심 항공기의 진입 · 예측 진입 · 신호 끊김)까지 잃는다. 숨은 탭 알림(ADR-037 §5)이 바로 이 응답에 기댄다.
 * 다른 공개 조회는 DB 가 없으면 실시간 값만 주고 meta.db_unavailable = true 로 답한다(ProblemAdvice.answeredWithoutStore — 선박 검색 · 상세).
 * 기대: 200 · 항공기 줄은 그대로 · meta.db_unavailable = true.
 */
class Qa600WatchDbDownTest {
    @Test
    void aircraftAreStillAnsweredWhenTheAirportLookupHasNoDb() throws Exception {
        Instant now = Instant.now();
        SnapshotStore snapshots = new SnapshotStore();
        snapshots.replaceIfNewer(new Snapshot(snapshots.nextVersion(), "region", "adsb_lol", now, now, "-", Map.of("71be01",
                new AircraftState("71be01", "KAL081", null, null, null, 37.4, 126.5, 30000, 450.0, 90.0, 0.0, false, "1200", now, "adsb_lol", now, 0, false))));
        EngineService engine = mock(EngineService.class);
        when(engine.activeAlerts(null)).thenReturn(List.of());
        AirportRepository airports = mock(AirportRepository.class);
        when(airports.latestFor(any())).thenThrow(new CannotGetJdbcConnectionException("db down"));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new WatchController(snapshots, engine, new RecentClosedAlerts(), new ShipStore(), airports))
                .setControllerAdvice(new ProblemAdvice()).build();
        mvc.perform(get("/api/v1/watch").param("aircraft", "71be01").param("airports", "RKSI"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.aircraft[0].hex").value("71be01"))
                .andExpect(jsonPath("$.aircraft[0].found").value(true))
                .andExpect(jsonPath("$.meta.db_unavailable").value(true));
    }
}
