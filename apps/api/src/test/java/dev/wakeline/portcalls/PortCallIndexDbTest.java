package dev.wakeline.portcalls;

import dev.wakeline.DbTestSupport;
import dev.wakeline.PlanCapture;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.jdbc.core.simple.JdbcClient;
import tools.jackson.databind.JsonNode;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 입출항 색인 읽기(ADR-022 개정 · V15)를 실제 PostgreSQL 에서 api 계정으로: 수집기가 실제 전체 기록을 해석한 공유 행(fixtures/portcall_row_V7A3884.json)을
 * 넣고 PortCallIndex · PortCallReader 가 그대로 읽는지, 30일 창 · 최근 순 · 호출부호 인덱스를 쓰는지, '기록 없음' 이 완전한 색인에서만인지.
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class PortCallIndexDbTest {
    static final Instant NOW = Instant.parse("2026-09-29T13:00:00Z"); // 22:00 KST
    static final LocalDate FROM = LocalDate.parse("2026-08-30"), TO = LocalDate.parse("2026-09-29");
    static final Instant READ = Instant.parse("2026-09-29T12:45:00Z");
    JdbcClient admin;

    @BeforeEach
    void setUp() {
        DbTestSupport.reset();
        admin = DbTestSupport.admin();
    }

    /** 공유 fixture 행을 넣는다(수집기가 쓰는 모양 — 열 이름이 같다). cs · listed · entry 는 바꿔 넣을 수 있다. */
    void insert(String cs, String co, LocalDate listed, Instant entry, Instant exit) {
        JsonNode r = PortCallFixtures.rowJson();
        admin.sql("""
                INSERT INTO port_call (prt_ag_cd, clsgn, etrypt_year, etrypt_co, listed_date, prt_ag_nm, vssl_nm, nationality_cd, nationality_nm, kind_cd,
                  kind_nm, purpose_nm, first_port_cd, first_port_nm, prev_port_cd, prev_port_nm, next_port_cd, next_port_nm, dest_port_cd, dest_port_nm,
                  entry_at, entry_revision, exit_at, exit_revision, berth, fetched_at, updated_at)
                VALUES (:pa, :cs, :y, :co, :listed, :pan, :vn, :ncd, :nnm, :kcd, :knm, :pur, :fpc, :fpn, :ppc, :ppn, :npc, :npn, :dpc, :dpn,
                  :entry, :er, :exit, :xr, :berth, :fetched, :fetched)""")
                .param("pa", r.path("prt_ag_cd").asString()).param("cs", cs).param("y", r.path("etrypt_year").asString()).param("co", co)
                .param("listed", listed).param("pan", r.path("prt_ag_nm").asString()).param("vn", r.path("vssl_nm").asString())
                .param("ncd", r.path("nationality_cd").asString()).param("nnm", r.path("nationality_nm").asString())
                .param("kcd", r.path("kind_cd").asString()).param("knm", r.path("kind_nm").asString()).param("pur", r.path("purpose_nm").asString())
                .param("fpc", r.path("first_port_cd").asString()).param("fpn", r.path("first_port_nm").asString())
                .param("ppc", r.path("prev_port_cd").asString()).param("ppn", r.path("prev_port_nm").asString())
                .param("npc", r.path("next_port_cd").asString()).param("npn", r.path("next_port_nm").asString())
                .param("dpc", r.path("dest_port_cd").asString()).param("dpn", r.path("dest_port_nm").asString())
                .param("entry", entry == null ? null : Timestamp.from(entry)).param("er", entry == null ? null : r.path("entry_revision").asString())
                .param("exit", exit == null ? null : Timestamp.from(exit)).param("xr", exit == null ? null : r.path("exit_revision").asString())
                .param("berth", r.path("berth").asString()).param("fetched", Timestamp.from(READ)).update();
    }

    void insertFixture() {
        JsonNode r = PortCallFixtures.rowJson();
        insert(r.path("clsgn").asString(), r.path("etrypt_co").asString(), LocalDate.parse(r.path("listed_date").asString()),
                Instant.parse(r.path("entry_at").asString()), Instant.parse(r.path("exit_at").asString()));
    }

    void coverAll(LocalDate from, LocalDate to, Instant refreshed) {
        for (var pa : PortCallReader.PORT_AUTHORITIES)
            admin.sql("INSERT INTO port_call_coverage (prt_ag_cd, covered_from, covered_to, refreshed_at, updated_at) VALUES (:pa, :f, :t, :r, now())")
                    .param("pa", pa.getKey()).param("f", from).param("t", to).param("r", Timestamp.from(refreshed)).update();
    }

    @Test
    void theSharedCollectorRowIsReadBackExactly_asTheApiRole() {
        insertFixture();
        PortCallIndex index = new PortCallIndex(DbTestSupport.apiClient());
        List<PortCallIndex.Row> rows = index.byCallSign("V7A3884", FROM, TO, 21);
        assertThat(rows).containsExactly(PortCallFixtures.row(READ));
        assertThat(index.byCallSign("v7a3884", FROM, TO, 21)).as("the index holds normalised call signs — the reader normalises first").isEmpty();
    }

    @Test
    void theWindowIsTheListedKstDate_andNewestComesFirst() {
        insert("D7AB2", "1", LocalDate.parse("2026-08-29"), Instant.parse("2026-08-29T01:00:00Z"), null); // 창 밖(하루 전)
        insert("D7AB2", "2", FROM, Instant.parse("2026-08-30T01:00:00Z"), Instant.parse("2026-09-02T01:00:00Z"));
        insert("D7AB2", "3", LocalDate.parse("2026-09-20"), Instant.parse("2026-09-20T01:00:00Z"), null);
        insert("D7AB2", "4", LocalDate.parse("2026-09-10"), null, null); // 시각 모름 — 뒤
        List<PortCallIndex.Row> rows = new PortCallIndex(DbTestSupport.apiClient()).byCallSign("D7AB2", FROM, TO, 21);
        assertThat(rows).extracting(PortCallIndex.Row::listedDate)
                .containsExactly(LocalDate.parse("2026-09-20"), FROM, LocalDate.parse("2026-09-10"));
        assertThat(new PortCallIndex(DbTestSupport.apiClient()).byCallSign("D7AB2", FROM, TO, 2)).hasSize(2);
    }

    @Test
    void coverageRowsAreMapped_withTheirHoleDaysInOrder() {
        coverAll(FROM, TO, NOW);
        admin.sql("UPDATE port_call_coverage SET hole_days = ARRAY[DATE '2026-09-28', DATE '2026-09-03'] WHERE prt_ag_cd = '030'").update();
        List<PortCallIndex.Coverage> cov = new PortCallIndex(DbTestSupport.apiClient()).coverage();
        assertThat(cov).hasSize(10).contains(new PortCallIndex.Coverage("020", FROM, TO, NOW),
                new PortCallIndex.Coverage("030", FROM, TO, NOW, List.of(LocalDate.parse("2026-09-03"), LocalDate.parse("2026-09-28"))));
        PortCallsInfo p = new PortCallReader(new PortCallIndex(DbTestSupport.apiClient()), List::of, NOW::toEpochMilli).forCallSign("D7AB2");
        assertThat(p.status()).as("a hole in the window — never 'none'").isEqualTo("incomplete");
        assertThat(p.index().gaps()).extracting(PortCallsInfo.Gap::unindexedDays).containsExactly(List.of("2026-09-03", "2026-09-28"));
    }

    /** 재현한 결함의 api 쪽: 색인에 있는 호출부호는 ok, 완전하고 새 색인에 없는 호출부호만 none, 한 곳이라도 빠지면 incomplete. */
    @Test
    void readerOverTheRealIndex_okForAListedShip_noneOnlyWithAFullFreshIndex() {
        insertFixture();
        coverAll(FROM.minusDays(3), TO, NOW.minusSeconds(900));
        PortCallReader reader = new PortCallReader(new PortCallIndex(DbTestSupport.apiClient()), List::of, NOW::toEpochMilli);
        PortCallsInfo ok = reader.forCallSign("V7A3884");
        assertThat(ok.status()).isEqualTo("ok");
        assertThat(ok.items().getFirst().exitAt()).isEqualTo(Instant.parse("2026-09-25T05:24:00Z"));
        assertThat(reader.forCallSign("D7AB2").status()).isEqualTo("none");
        admin.sql("DELETE FROM port_call_coverage WHERE prt_ag_cd = '700'").update();
        PortCallReader later = new PortCallReader(new PortCallIndex(DbTestSupport.apiClient()), List::of, NOW::toEpochMilli);
        PortCallsInfo inc = later.forCallSign("D7AB2");
        assertThat(inc.status()).isEqualTo("incomplete");
        assertThat(inc.index().gaps()).extracting(PortCallsInfo.Gap::portAuthorityCode).containsExactly("700");
    }

    /** 선택한 선박마다(15 s 에 한 번) 도는 조회 — 호출부호 인덱스(port_call_clsgn_idx)로 찾는다(색인 60일 · 하루 약 320건 ≈ 2만 행). */
    @Test
    void theCallSignLookupUsesTheCallSignIndex() {
        admin.sql("""
                INSERT INTO port_call (prt_ag_cd, clsgn, etrypt_year, etrypt_co, listed_date, fetched_at, updated_at)
                SELECT '020', 'Z' || upper(lpad(to_hex(g % 4000), 5, '0')), '2026', g::text, DATE '2026-09-29' - (g % 60), now(), now()
                FROM generate_series(1, 20000) g""").update();
        admin.sql("ANALYZE port_call").update();
        PlanCapture plans = new PlanCapture(DbTestSupport.apiDataSource(), "FROM port_call", PlanCapture.Mode.GENERIC);
        new PortCallIndex(JdbcClient.create(plans.dataSource())).byCallSign("Z003E8", FROM, TO, 21);
        assertThat(plans.last()).as(plans.last()).contains("\"Index Name\": \"port_call_clsgn_idx\"");
    }
}
