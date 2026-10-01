package dev.wakeline.qa;

import dev.wakeline.aircraft.core.AircraftState;
import dev.wakeline.aircraft.core.Snapshot;
import dev.wakeline.aircraft.core.SnapshotStore;
import dev.wakeline.aircraft.data.AircraftRepository;
import dev.wakeline.aircraft.data.TrackRepository;
import dev.wakeline.aircraft.web.AircraftController;
import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.platform.web.ProblemAdvice;
import dev.wakeline.route.RouteInfoTest;
import dev.wakeline.route.RouteReader;
import dev.wakeline.weather.core.EngineService;
import dev.wakeline.weather.core.SigmetStore;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * QA-206(QA 2026-10 기능): GET /api/v1/aircraft/search 는 등록번호 앞부분으로도 찾지만(AircraftController.search — hex · 호출부호 · 등록번호),
 * 실시간 항목은 lite 인코딩(AircraftJson.encode(a, "lite") — registration · type_code 없음)으로 싣는다. 그래서 "B-" 로 찾은 실시간 항공기에
 * 맞은 근거(registration)가 응답에 없고, 웹 검색 목록의 '등록번호' 칸(components/AircraftSearch.tsx — h.registration ?? "—")은 서버가 아는 값을
 * '모름(—)' 으로 그린다. 같은 hex 의 DB 항목(registration 있음)은 실시간 항목 뒤라 버려진다(seen). 격리 스택 A: q=B- 의 20건 중 실시간 항목 모두 registration 없음.
 */
class Qa206AircraftSearchHidesRegistrationTest {
    static final AppProperties PROPS = new AppProperties("", "36.5,127.8", 250, 120, 200, 5, 10, 30, 2500, 0, "classpath:schemas", 72, 30,
            120, List.of("http://localhost:8700"), List.of());

    @Test
    void aLiveHitFoundByRegistrationCarriesItsRegistration() throws Exception {
        SnapshotStore snapshots = new SnapshotStore();
        Instant now = Instant.now();
        AircraftState a = new AircraftState("780b7a", null, "B-9971", "A321", "A3", 36.9, 123.0, 30100, null, 287.0, null, false, null,
                now.minusSeconds(3), "adsb_lol", now, 1, false);
        snapshots.replaceIfNewer(new Snapshot(snapshots.nextVersion(), "region", "adsb_lol", now, now, "-", Map.of(a.hex(), a)));
        AircraftRepository noDb = new AircraftRepository(null, null) {
            @Override public List<Map<String, Object>> search(String prefix, int limit) { return List.of(); }
        };
        var engine = new EngineService(snapshots, new SigmetStore(), e -> { }, new SimpleMeterRegistry());
        var controller = new AircraftController(snapshots, engine, noDb, new TrackRepository(null), PROPS,
                new RouteReader(k -> null, RouteInfoTest.JSON, System::currentTimeMillis));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new ProblemAdvice()).build();

        mvc.perform(get("/api/v1/aircraft/search").param("q", "B-99"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].hex").value("780b7a"))
                .andExpect(jsonPath("$.items[0].live").value(true))
                .andExpect(jsonPath("$.items[0].registration").value("B-9971"));
    }
}
