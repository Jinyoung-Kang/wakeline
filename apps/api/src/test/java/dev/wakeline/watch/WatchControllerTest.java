package dev.wakeline.watch;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.ships.core.ShipState;
import dev.wakeline.ships.core.ShipStatic;
import dev.wakeline.ships.core.AisStatus;
import dev.wakeline.ships.core.ShipStore;
import dev.wakeline.weather.core.Alert;
import dev.wakeline.weather.core.AlertStateMachine;
import dev.wakeline.weather.core.EngineEvents;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.data.AirportRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.hamcrest.Matchers.allOf;
import static org.hamcrest.Matchers.greaterThanOrEqualTo;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.lessThan;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 관심 대상 조회(계약 v5 §G50 · ADR-037): 입력 검사 · 50개 상한 · 항공기(열린 · 최근 닫힌 알림) · 선박 · 공항 · 모르는 대상은 found=false. */
class WatchControllerTest {
    final SnapshotStore snapshots = new SnapshotStore();
    final ShipStore ships = new ShipStore();
    final AisStatus aisStatus = new AisStatus(ships);
    final RecentClosedAlerts closed = new RecentClosedAlerts();
    final EngineService engine = mock(EngineService.class);
    final AirportRepository airports = mock(AirportRepository.class);
    MockMvc mvc;
    Instant now;

    static AircraftState ac(String hex, Instant seen) {
        return new AircraftState(hex, "KAL081", null, null, null, 37.4, 126.5, 30000, 450.0, 90.0, 0.0, false, "1200", seen, "adsb_lol", seen, 0, false);
    }

    static Alert alert(long id, String hex, String kind, Instant entered) {
        return new Alert(id, kind, hex, "KAL081", "S1", "RKRR", "TS", null, entered, null, null, null, null, 30000, Map.of(), false);
    }

    @BeforeEach
    void setUp() {
        now = Instant.now();
        snapshots.replaceIfNewer(new Snapshot(snapshots.nextVersion(), "region", "adsb_lol", now, now, "-", Map.of("71be01", ac("71be01", now.minusSeconds(3)))));
        ships.apply(List.of(new ShipState("440123456", 35.0, 129.0, 10.0, 90.0, 90, 0, 0, "pos", now.minusSeconds(40), "aisstream", "1", "A")),
                List.of(new ShipStatic("440123456", "HANBADA", null, null, 70, null, null, null, null, null, null, null, null, null, null, now, "aisstream")),
                now, "aisstream", now.toEpochMilli());
        mvc = MockMvcBuilders.standaloneSetup(new WatchController(snapshots, engine, closed, ships, aisStatus, airports)).setControllerAdvice(new ProblemAdvice()).build();
    }

    @Test
    void answersEachTargetWithItsCurrentStateAndAlerts() throws Exception {
        when(engine.activeAlerts(null)).thenReturn(List.of(alert(7, "71be01", "PREDICTED", now.minusSeconds(20)), alert(8, "a00001", "OBSERVED", now)));
        closed.onAlerts(new EngineEvents.AlertsChanged(List.of(new AlertStateMachine.Event(AlertStateMachine.EventType.LEFT,
                alert(5, "71be01", "OBSERVED", now.minusSeconds(300)).closed(now.minusSeconds(60), Alert.CLOSE_LEFT, null)))));
        Map<String, Object> rksi = new LinkedHashMap<>();
        rksi.put("icao", "RKSI"); rksi.put("name", "Incheon"); rksi.put("flight_cat", "IFR"); rksi.put("obs_time", now.minusSeconds(600));
        rksi.put("obs_age_s", 600L); rksi.put("stale", false);
        when(airports.latestFor(List.of("RKSI", "ZZZZ"))).thenReturn(List.of(rksi));
        mvc.perform(get("/api/v1/watch").param("aircraft", "71BE01, ffffff,71be01").param("ships", "440123456,440999999").param("airports", "rksi,ZZZZ"))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "max-age=5, private"))
                .andExpect(jsonPath("$.aircraft", hasSize(2)))
                .andExpect(jsonPath("$.aircraft[0].hex").value("71be01")).andExpect(jsonPath("$.aircraft[0].found").value(true))
                .andExpect(jsonPath("$.aircraft[0].fresh").value(true))
                .andExpect(jsonPath("$.aircraft[0].open_alerts", hasSize(1))).andExpect(jsonPath("$.aircraft[0].open_alerts[0].id").value(7))
                .andExpect(jsonPath("$.aircraft[0].open_alerts[0].kind").value("PREDICTED")).andExpect(jsonPath("$.aircraft[0].open_alerts[0].zone_type").value("sigmet"))
                .andExpect(jsonPath("$.aircraft[0].closed_alerts[0].id").value(5)).andExpect(jsonPath("$.aircraft[0].closed_alerts[0].close_reason").value("left"))
                .andExpect(jsonPath("$.aircraft[1].hex").value("ffffff")).andExpect(jsonPath("$.aircraft[1].found").value(false))
                .andExpect(jsonPath("$.aircraft[1].open_alerts", hasSize(0)))
                .andExpect(jsonPath("$.ships[0].found").value(true)).andExpect(jsonPath("$.ships[0].name").value("HANBADA"))
                .andExpect(jsonPath("$.ships[0].age_s", allOf(greaterThanOrEqualTo(40), lessThan(60)))).andExpect(jsonPath("$.ships[1].found").value(false))
                .andExpect(jsonPath("$.airports[0].icao").value("RKSI")).andExpect(jsonPath("$.airports[0].flight_cat").value("IFR"))
                .andExpect(jsonPath("$.airports[1].found").value(false))
                .andExpect(jsonPath("$.closed_window_s").value(900)).andExpect(jsonPath("$.meta.provider").value("memory"));
    }

    @Test
    void emptyListsNeedNoLookups() throws Exception {
        mvc.perform(get("/api/v1/watch")).andExpect(status().isOk()).andExpect(jsonPath("$.aircraft", hasSize(0)))
                .andExpect(jsonPath("$.ships", hasSize(0))).andExpect(jsonPath("$.airports", hasSize(0)));
        verify(airports, never()).latestFor(any());
    }

    @Test
    void rejectsBadIdsAndMoreThanFiftyTargets() throws Exception {
        mvc.perform(get("/api/v1/watch").param("aircraft", "xyz")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_HEX"));
        mvc.perform(get("/api/v1/watch").param("ships", "12345")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_MMSI"));
        mvc.perform(get("/api/v1/watch").param("airports", "RK")).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("BAD_ICAO"));
        StringBuilder hex = new StringBuilder();
        for (int i = 0; i < 30; i++) hex.append(i == 0 ? "" : ",").append(String.format("a%05x", i));
        StringBuilder mmsi = new StringBuilder();
        for (int i = 0; i < 21; i++) mmsi.append(i == 0 ? "" : ",").append(440000000 + i);
        mvc.perform(get("/api/v1/watch").param("aircraft", hex.toString()).param("ships", mmsi.toString()))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("TOO_MANY_TARGETS"));
        mvc.perform(get("/api/v1/watch").param("aircraft", ",".repeat(80))).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("TOO_MANY_TARGETS"));
    }

    /** QA-701: 지금 열린 AIS 수신 공백을 ended_at 없이 싣는다(전에는 끝난 공백만 — 열린 공백은 나오지 않았다). 열린 것이 없으면 마지막 끝난 공백. */
    @Test
    void anOpenAisGapComesFirst() throws Exception {
        Instant since = now.minusSeconds(600).truncatedTo(java.time.temporal.ChronoUnit.SECONDS);
        aisStatus.update(Map.of("provider", "aisstream", "connected", "0", "state", "reconnecting", "updated_at", now.toString(),
                "gap_open_since", since.toString(), "gap_reason", "ws_closed"));
        mvc.perform(get("/api/v1/watch").param("ships", "440123456"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ais_last_gap.started_at").value(since.toString()))
                .andExpect(jsonPath("$.ais_last_gap.ended_at").doesNotExist())
                .andExpect(jsonPath("$.ais_last_gap.reason").value("ws_closed"))
                .andExpect(jsonPath("$.meta.db_unavailable").doesNotExist());
    }
}
