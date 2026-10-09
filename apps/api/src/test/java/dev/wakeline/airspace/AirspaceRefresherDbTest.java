package dev.wakeline.airspace;

import dev.wakeline.DbTestSupport;
import dev.wakeline.airspace.core.AirspaceRecord;
import dev.wakeline.airspace.core.AirspaceStore;
import dev.wakeline.airspace.data.AirspaceRefresher;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.locationtech.jts.geom.Polygon;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.json.JsonMapper;

import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 공역 읽기(ADR-034)를 실제 PostGIS(api 계정 wakeline_api — SELECT 만)로: 켜진 차수만 읽고, 차수가 바뀔 때만 다시 읽고, 판정용 도형(다각형) ·
 * 표시용 GeoJSON · 고도 한계를 옮기며, 읽기가 실패하면 이전 스냅숏을 둔다. 다른 DB 시험과 섞이지 않게 제 DB(wakeline_airspace)를 쓴다.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class AirspaceRefresherDbTest {
    static final String DB = "wakeline_airspace";
    static JdbcClient api;

    @BeforeAll
    static void db() {
        DbTestSupport.createMigratedDatabase(DB);
        api = JdbcClient.create(new DriverManagerDataSource(DbTestSupport.jdbcUrl(DB), "wakeline_api", DbTestSupport.API_PW));
    }

    @Test
    void loadsOnlyTheActiveEditionAndReloadsOnlyWhenItChanges_keepingTheSnapshotWhenTheDatabaseFails() {
        AirspaceStore store = new AirspaceStore();
        AirspaceRefresher r = new AirspaceRefresher(api, store, JsonMapper.builder().build());
        r.refresh();
        assertThat(store.snapshot()).isSameAs(AirspaceStore.Snapshot.EMPTY);

        AirspaceFixtures.insertEdition(sql -> DbTestSupport.exec(DB, sql), AirspaceFixtures.sha('1'), "합성 1차", false, AirspaceFixtures.defaults());
        r.refresh();
        assertThat(store.snapshot().edition()).as("꺼진 차수는 읽지 않는다").isNull();

        DbTestSupport.exec(DB, "UPDATE airspace_edition SET active = true WHERE source_sha256 = '" + AirspaceFixtures.sha('1') + "'");
        r.refresh();
        AirspaceStore.Snapshot first = store.snapshot();
        assertThat(first.edition().label()).isEqualTo("합성 1차");
        assertThat(first.edition().tag()).isEqualTo(first.edition().id() + "-111111111111");
        Map<String, AirspaceRecord> byIdent = first.records().stream().collect(Collectors.toMap(AirspaceRecord::label, Function.identity()));
        assertThat(byIdent).hasSize(6);
        AirspaceRecord p = byIdent.get("RK P99");
        assertThat(p.geometry()).isInstanceOf(Polygon.class);
        assertThat(p.geometry().getSRID()).isEqualTo(4326);
        assertThat(p.lower()).isEqualTo(new AirspaceRecord.Limit(0, "SFC", "Ground"));
        assertThat(p.upper()).isEqualTo(new AirspaceRecord.Limit(null, "UNL", "Unlimited"));
        assertThat(p.display().path("type").asString()).isEqualTo("Polygon");
        AirspaceRecord route = byIdent.get("Z999");
        assertThat(route.geometry()).as("선은 판정하지 않는다 — 도형을 싣지 않음").isNull();
        assertThat(route.display().path("type").asString()).isEqualTo("LineString");

        r.refresh();
        assertThat(store.snapshot()).as("같은 차수 — 다시 읽지 않는다").isSameAs(first);

        AirspaceFixtures.insertEdition(sql -> DbTestSupport.exec(DB, sql), AirspaceFixtures.sha('2'), "합성 2차", true, AirspaceFixtures.defaults().subList(0, 2));
        r.refresh();
        assertThat(store.snapshot().edition().label()).isEqualTo("합성 2차");
        assertThat(store.snapshot().records()).hasSize(2);

        AirspaceStore.Snapshot kept = store.snapshot();
        JdbcClient broken = JdbcClient.create(new DriverManagerDataSource(DbTestSupport.jdbcUrl(DB), "wakeline_api", "wrong-password"));
        new AirspaceRefresher(broken, store, JsonMapper.builder().build()).refresh();
        assertThat(store.snapshot()).as("DB 실패 — 이전 스냅숏").isSameAs(kept);

        DbTestSupport.exec(DB, "UPDATE airspace_edition SET active = false WHERE active");
        r.refresh();
        assertThat(store.snapshot()).as("켜진 차수가 없어지면 비운다").isSameAs(AirspaceStore.Snapshot.EMPTY);
    }
}
