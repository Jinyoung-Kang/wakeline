package dev.wakeline.portcalls;

import dev.wakeline.domain.ShipStatic;
import dev.wakeline.route.RouteInfoTest;
import org.junit.jupiter.api.Test;
import org.springframework.dao.QueryTimeoutException;
import tools.jackson.databind.JsonNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 입출항 읽기(ADR-022 개정): DB 색인을 AIS 호출부호로 찾고, '기록 없음' 은 10곳이 모두 30일 창을 덮고 2시간 안에 갱신됐을 때만 말한다.
 * 색인 · heartbeat 는 가짜(PortCallFixtures.FakeSource), 시계는 주입한다. 기준 행은 수집기가 실제 전체 기록을 해석한 공유 fixture(V7A3884).
 */
class PortCallReaderTest {
    static final Path VECTORS = Path.of("../../schemas/vectors/call-sign-cases.v1.json").toAbsolutePath().normalize();
    /** 2026-09-29 22:00 KST — 창 2026-08-30 ~ 2026-09-29. */
    static final Instant NOW = Instant.parse("2026-09-29T13:00:00Z");
    static final LocalDate FROM = LocalDate.parse("2026-08-30"), TO = LocalDate.parse("2026-09-29");

    final PortCallFixtures.FakeSource index = new PortCallFixtures.FakeSource();
    final AtomicReference<List<Object>> heartbeat = new AtomicReference<>(List.of());
    final AtomicLong clock = new AtomicLong(NOW.toEpochMilli());
    final PortCallReader reader = new PortCallReader(index, heartbeat::get, clock::get);

    static ShipStatic stat(String callSign) {
        return new ShipStatic("538012043", "AZAMARA PURSUIT", callSign, null, 60, null, null, null, null, null, null, null, null, null, null, NOW, "aisstream");
    }

    void fullFreshIndex() { index.coverage = PortCallFixtures.fullCoverage(FROM.minusDays(2), TO, NOW.minusSeconds(600)); }

    // ---- 호출부호 -------------------------------------------------------------------------------------------------

    @Test void callSignRuleMatchesTheSharedVectors() throws Exception {
        JsonNode doc = RouteInfoTest.JSON.readTree(Files.readString(VECTORS));
        assertThat(doc.path("version").asInt()).isEqualTo(1);
        assertThat(doc.path("cases").size()).isGreaterThanOrEqualTo(15);
        for (JsonNode c : doc.path("cases")) {
            String in = c.path("input").isNull() ? null : c.path("input").asString();
            String want = c.path("expected").isNull() ? null : c.path("expected").asString();
            assertThat(PortCallReader.normalizeCallSign(in)).as(String.valueOf(in)).isEqualTo(want);
        }
    }

    @Test void theTenAuthoritiesAreTheSharedVector_theCollectorIndexesExactlyThese() throws Exception {
        JsonNode doc = RouteInfoTest.JSON.readTree(Files.readString(PortCallFixtures.AUTHORITIES));
        List<Map.Entry<String, String>> want = new ArrayList<>();
        for (JsonNode a : doc.path("authorities")) want.add(Map.entry(a.path("code").asString(), a.path("name").asString()));
        assertThat(PortCallReader.PORT_AUTHORITIES).isEqualTo(want);
    }

    @Test void withoutAUsableCallSignTheIndexIsNotRead_andAMissingOneIsNotYetReceivedNotNone() {
        PortCallsInfo none = reader.forStatic(null);
        assertThat(none.status()).isEqualTo("no_call_sign");
        assertThat(none.callSignState()).as("static not received yet — '아직 받지 않음', not '없음'").isEqualTo("not_received");
        assertThat(reader.forStatic(stat(null)).callSignState()).isEqualTo("not_received");
        assertThat(reader.forStatic(stat("   ")).callSignState()).isEqualTo("not_received");
        assertThat(reader.forStatic(stat("AB-12")).callSignState()).as("received but outside the lookup format").isEqualTo("unusable");
        assertThat(reader.forCallSign("ab")).isEqualTo(PortCallsInfo.noCallSign("unusable"));
        assertThat(index.queries).isEmpty();
        assertThat(index.coverageReads.get()).isZero();
    }

    // ---- 재현한 결함: clsgn 필터가 놓친 선박도 색인에서는 찾는다 ---------------------------------------------------------------

    /**
     * 배포 뒤 결함(docs/review/evidence 마지막 절): PORT-MIS 가 clsgn 으로 거르지 않아 V7A3884 가 '최근 30일 기록 없음' 이었다. 색인은 clsgn 없이
     * 받은 행을 가지므로 AIS 호출부호로 찾으면 ok — 입항 · 출항(tkoffDt) · 선석 · 판 · 항로가 실제 기록 그대로.
     */
    @Test void aShipTheClsgnFilterMissedIsFoundInTheIndex() {
        fullFreshIndex();
        index.rows.put("V7A3884", List.of(PortCallFixtures.row(NOW.minusSeconds(900))));
        PortCallsInfo p = reader.forStatic(stat(" v7a3884 "));
        assertThat(p.status()).isEqualTo("ok");
        assertThat(p.callSign()).isEqualTo("V7A3884");
        assertThat(index.queries).containsExactly("V7A3884 2026-08-30..2026-09-29 limit 21");
        assertThat((p.windowFrom() + ".." + p.windowTo())).isEqualTo("2026-08-30..2026-09-29");
        PortCallsInfo.PortCall c = p.items().getFirst();
        assertThat(c.portAuthorityCode()).isEqualTo("020");
        assertThat(c.portAuthority()).isEqualTo("부산");
        assertThat(c.listedDate()).isEqualTo("2026-09-24");
        assertThat(c.entryAt()).isEqualTo(Instant.parse("2026-09-23T23:17:00Z"));
        assertThat(c.entryRevision()).isEqualTo("최종");
        assertThat(c.exitAt()).as("from the 출항 report's tkoffDt").isEqualTo(Instant.parse("2026-09-25T05:24:00Z"));
        assertThat(c.exitRevision()).isEqualTo("최종");
        assertThat(c.berth()).isEqualTo("북항크루즈터미널 2선석");
        assertThat(c.purpose()).isEqualTo("여객상륙");
        assertThat(c.firstPort()).isEqualTo(new PortCallsInfo.Port("JPUKB", "KOBE"));
        assertThat(c.prevPort()).isEqualTo(new PortCallsInfo.Port("JPSMN", "SAKAIMINATO"));
        assertThat(c.nextPort()).isEqualTo(new PortCallsInfo.Port("JPHIJ", "HIROSHIMA"));
        assertThat(c.destPort()).isEqualTo(new PortCallsInfo.Port("JPHIJ", "HIROSHIMA"));
        assertThat(c.reportedName()).isEqualTo("AZAMARA PURSUIT");
        assertThat(c.kind()).isEqualTo("크루즈선");
        assertThat(c.nationality()).isEqualTo("마샬 제도");
        assertThat(c.readAt()).isEqualTo(NOW.minusSeconds(900));
        assertThat(p.index().complete()).isTrue();
        assertThat(p.index().refreshedAt()).isEqualTo(NOW.minusSeconds(600));
    }

    @Test void foundItemsAreOkEvenWhenTheIndexIsIncomplete_theGapsTravelAlong() {
        index.coverage = List.of(new PortCallIndex.Coverage("020", LocalDate.parse("2026-09-20"), TO, NOW.minusSeconds(60)));
        index.rows.put("V7A3884", List.of(PortCallFixtures.row(NOW)));
        PortCallsInfo p = reader.forCallSign("V7A3884");
        assertThat(p.status()).as("a record in the index is a record").isEqualTo("ok");
        assertThat(p.index().complete()).isFalse();
        assertThat(p.index().gaps()).hasSize(10);
        assertThat(p.index().gaps().getFirst().issues()).containsExactly("partial");
    }

    // ---- 'none' 은 완전하고 새 색인에서만 --------------------------------------------------------------------------------

    @Test void noneOnlyWhenAllTenAuthoritiesCoverTheWholeWindowAndWereRefreshedWithinTwoHours() {
        fullFreshIndex();
        PortCallsInfo p = reader.forCallSign("D7AB2");
        assertThat(p.status()).isEqualTo("none");
        assertThat(p.items()).isNull();
        assertThat(p.index().complete()).isTrue();
        assertThat(p.index().gaps()).isEmpty();
        assertThat(p.index().authorities()).isEqualTo(10);
        assertThat(p.index().staleAfterS()).isEqualTo(7_200);
    }

    @Test void aMissingAuthorityMakesItIncomplete_notNone() {
        index.coverage = new ArrayList<>(PortCallFixtures.fullCoverage(FROM, TO, NOW));
        index.coverage.removeIf(c -> c.portAuthority().equals("700"));
        PortCallsInfo p = reader.forCallSign("D7AB2");
        assertThat(p.status()).isEqualTo("incomplete");
        assertThat(p.index().gaps()).containsExactly(new PortCallsInfo.Gap("700", "포항", List.of("not_indexed"), null, null, null));
        assertThat(p.index().refreshedAt()).as("not every authority has refreshed — no single 'as of'").isNull();
    }

    @Test void aBackfillInProgressIsPartial() {
        index.coverage = new ArrayList<>(PortCallFixtures.fullCoverage(FROM, TO, NOW));
        index.coverage.set(0, new PortCallIndex.Coverage("020", FROM.plusDays(1), TO, NOW));
        PortCallsInfo p = reader.forCallSign("D7AB2");
        assertThat(p.status()).isEqualTo("incomplete");
        assertThat(p.index().gaps()).containsExactly(new PortCallsInfo.Gap("020", "부산", List.of("partial"), "2026-08-31", "2026-09-29", NOW));
    }

    @Test void staleness_isTwoHours_orNoRefreshYet_orAFutureRefresh_andACoverageEndingBeforeTodayIsBehind() {
        index.coverage = new ArrayList<>(PortCallFixtures.fullCoverage(FROM, TO, NOW));
        index.coverage.set(1, new PortCallIndex.Coverage("030", FROM, TO, NOW.minusSeconds(7_200))); // 경계 — 아직 새것
        assertThat(reader.forCallSign("D7AB2").status()).isEqualTo("none");
        clock.addAndGet(PortCallReader.TTL_MS);
        index.coverage.set(1, new PortCallIndex.Coverage("030", FROM, TO, NOW.minusSeconds(7_201 - PortCallReader.TTL_MS / 1000)));
        index.coverage.set(2, new PortCallIndex.Coverage("200", FROM, TO, null));
        index.coverage.set(3, new PortCallIndex.Coverage("300", FROM, TO.minusDays(1), NOW)); // 갱신은 오늘인데 범위는 어제까지
        index.coverage.set(4, new PortCallIndex.Coverage("500", FROM, TO, NOW.plusSeconds(3_600))); // 시계가 어긋났다
        PortCallsInfo p = reader.forCallSign("D7AB3");
        assertThat(p.status()).isEqualTo("incomplete");
        assertThat(p.index().gaps()).extracting(PortCallsInfo.Gap::portAuthorityCode).containsExactly("030", "200", "300", "500");
        assertThat(p.index().gaps()).extracting(PortCallsInfo.Gap::issues)
                .containsExactly(List.of("stale"), List.of("stale"), List.of("behind"), List.of("stale"));
        assertThat(p.index().refreshedAt()).isNull();
    }

    /**
     * 리뷰 재현(2026-09-29): 자정 직후 창의 끝은 오늘(KST)인데 범위는 어제까지다 — 오늘 목록은 아직 받지 않았다. 전날 밤 갱신이 새것이어도 'none' 이 아니다
     * (00:00 뒤 입항해 오늘 목록에 오른 선박을 '기록 없음' 으로 말하게 된다). 자정 뒤 꼬리 갱신이 오늘까지 덮으면 다시 none.
     */
    @Test void justAfterKstMidnightTodaysListIsNotIndexedYet_soNotNone() {
        clock.set(Instant.parse("2026-09-29T15:10:00Z").toEpochMilli()); // 2026-09-30 00:10 KST — 창 2026-08-31 ~ 2026-09-30
        index.coverage = PortCallFixtures.fullCoverage(FROM, TO, Instant.parse("2026-09-29T14:50:00Z")); // 23:50 KST 에 9-29 까지 갱신
        PortCallsInfo p = reader.forCallSign("D7AB2");
        assertThat(p.status()).as("today's list has not been fetched — not a definite 'none'").isEqualTo("incomplete");
        assertThat(p.windowFrom()).isEqualTo("2026-08-31");
        assertThat(p.windowTo()).isEqualTo("2026-09-30");
        assertThat(p.index().gaps()).hasSize(10).allSatisfy(g -> {
            assertThat(g.issues()).containsExactly("behind");
            assertThat(g.coveredTo()).isEqualTo("2026-09-29");
        });
        assertThat(p.index().refreshedAt()).isEqualTo(Instant.parse("2026-09-29T14:50:00Z"));
        clock.addAndGet(PortCallReader.TTL_MS);
        index.coverage = PortCallFixtures.fullCoverage(FROM, TO.plusDays(1), Instant.parse("2026-09-29T15:05:00Z")); // 00:05 KST 꼬리 갱신이 끝났다
        assertThat(reader.forCallSign("D7AB2").status()).isEqualTo("none");
    }

    /**
     * 리뷰 재현(2026-09-29): 수집기가 끝까지 색인하지 못한 날(빈 곳 — 색인할 수 없는 item 등)이 창 안에 있으면 그 항만청은 unindexed_days 와 그 날짜들 —
     * 'none' 이 아니다. 창 밖(창 첫날 전)의 빈 곳은 보지 않는다. 기록을 찾으면 여전히 ok(빈 곳은 함께 간다).
     */
    @Test void aHoleInsideTheWindowBlocksNone_andIsListed_butAHoleBeforeTheWindowDoesNot() {
        index.coverage = new ArrayList<>(PortCallFixtures.fullCoverage(FROM, TO, NOW.minusSeconds(600)));
        index.coverage.set(0, new PortCallIndex.Coverage("020", FROM, TO, NOW.minusSeconds(600),
                List.of(LocalDate.parse("2026-09-28"), FROM.minusDays(1), LocalDate.parse("2026-09-12"))));
        index.coverage.set(9, new PortCallIndex.Coverage("820", FROM.minusDays(5), TO, NOW.minusSeconds(600), List.of(FROM.minusDays(2))));
        PortCallsInfo p = reader.forCallSign("D7AB2");
        assertThat(p.status()).isEqualTo("incomplete");
        assertThat(p.index().gaps()).containsExactly(new PortCallsInfo.Gap("020", "부산", List.of("unindexed_days"), "2026-08-30", "2026-09-29",
                NOW.minusSeconds(600), List.of("2026-09-12", "2026-09-28")));
        JsonNode json = RouteInfoTest.JSON.valueToTree(p);
        assertThat(json.path("index").path("gaps").get(0).path("unindexed_days").toString()).isEqualTo("[\"2026-09-12\",\"2026-09-28\"]");
        clock.addAndGet(PortCallReader.TTL_MS);
        index.rows.put("V7A3884", List.of(PortCallFixtures.row(NOW)));
        PortCallsInfo ok = reader.forCallSign("V7A3884");
        assertThat(ok.status()).isEqualTo("ok");
        assertThat(ok.index().complete()).isFalse();
        assertThat(ok.index().gaps()).extracting(PortCallsInfo.Gap::portAuthorityCode).containsExactly("020");
    }

    @Test void theOldestRefreshIsTheIndexAsOf() {
        index.coverage = new ArrayList<>(PortCallFixtures.fullCoverage(FROM, TO, NOW.minusSeconds(60)));
        index.coverage.set(9, new PortCallIndex.Coverage("820", FROM, TO, NOW.minusSeconds(3_000)));
        assertThat(reader.forCallSign("D7AB2").index().refreshedAt()).isEqualTo(NOW.minusSeconds(3_000));
    }

    // ---- 꺼짐 · 오류 ------------------------------------------------------------------------------------------------

    @Test void aFreshCollectorHeartbeatThatSaysOffIsDisabled_withoutReadingTheIndex() {
        heartbeat.set(List.of("no_key", NOW.minusSeconds(30).toString()));
        assertThat(reader.forCallSign("V7A3884")).isEqualTo(PortCallsInfo.disabled("V7A3884", "no_key"));
        assertThat(index.queries).isEmpty();
        clock.addAndGet(PortCallReader.TTL_MS);
        heartbeat.set(List.of("operator_off", NOW.toString()));
        assertThat(reader.forCallSign("V7A3884").disabledReason()).isEqualTo("operator");
        clock.addAndGet(PortCallReader.TTL_MS);
        heartbeat.set(List.of("fixture", NOW.toString()));
        assertThat(reader.forCallSign("V7A3884").disabledReason()).isEqualTo("fixture");
    }

    @Test void aStaleOrActiveOrUnreadableHeartbeatFallsThroughToTheIndex() {
        fullFreshIndex();
        heartbeat.set(List.of("no_key", NOW.minusSeconds(121).toString())); // 오래된 heartbeat — 지금도 꺼져 있는지 모른다
        assertThat(reader.forCallSign("D7AB2").status()).isEqualTo("none");
        clock.addAndGet(PortCallReader.TTL_MS);
        heartbeat.set(List.of("active", NOW.toString()));
        assertThat(reader.forCallSign("D7AB2").status()).isEqualTo("none");
        clock.addAndGet(PortCallReader.TTL_MS);
        heartbeat.set(java.util.Arrays.asList("no_key", "not a time"));
        assertThat(reader.forCallSign("D7AB2").status()).isEqualTo("none");
        PortCallReader broken = new PortCallReader(index, () -> { throw new IllegalStateException("redis down"); }, clock::get);
        assertThat(broken.forCallSign("D7AB2").status()).isEqualTo("none");
    }

    @Test void anIndexReadFailureIsAnError_neverNone_andIsCachedForTheTtl() {
        fullFreshIndex();
        index.fail = new QueryTimeoutException("slow");
        PortCallsInfo p = reader.forCallSign("V7A3884");
        assertThat(p).isEqualTo(PortCallsInfo.error("V7A3884"));
        index.fail = null;
        assertThat(reader.forCallSign("V7A3884").status()).as("the same TTL — not hammering a struggling DB").isEqualTo("error");
        clock.addAndGet(PortCallReader.TTL_MS);
        assertThat(reader.forCallSign("V7A3884").status()).isEqualTo("none");
    }

    // ---- 캐시 · 항목 ------------------------------------------------------------------------------------------------

    @Test void resultsAreCachedPerCallSign_andTheCoverageIsSharedByAllShips() {
        fullFreshIndex();
        reader.forCallSign("D7AB2");
        reader.forCallSign("D7AB2");
        reader.forCallSign("D7AB3");
        assertThat(index.queries).hasSize(2);
        assertThat(index.coverageReads.get()).isEqualTo(1);
        clock.addAndGet(PortCallReader.TTL_MS);
        reader.forCallSign("D7AB2");
        assertThat(index.queries).hasSize(3);
        assertThat(index.coverageReads.get()).isEqualTo(2);
        assertThat(reader.cached()).isEqualTo(2);
    }

    @Test void moreThanTwentyRecordsAreTruncated_andRowsOfAnotherCallSignAreIgnored() {
        fullFreshIndex();
        List<PortCallIndex.Row> many = new ArrayList<>();
        PortCallIndex.Row base = PortCallFixtures.row(NOW);
        many.add(copy(base, "OTHER1", "부산"));
        for (int i = 0; i < 21; i++) many.add(copy(base, "V7A3884", "부산"));
        index.rows.put("V7A3884", many);
        PortCallsInfo p = reader.forCallSign("V7A3884");
        assertThat(p.items()).hasSize(20);
        assertThat(p.truncated()).isTrue();
        assertThat(p.items()).allSatisfy(c -> assertThat(c.reportedName()).isEqualTo("AZAMARA PURSUIT"));
    }

    @Test void itemValuesAreCheckedAgain_textCleaned_codesShapeChecked_revisionOnlyWithATime() {
        PortCallIndex.Row r = PortCallFixtures.row(NOW);
        PortCallIndex.Row bad = new PortCallIndex.Row("20", "부‮산​ ", r.callSign(), r.listedDate(), "A".repeat(90), r.nationality(), r.kind(),
                r.purpose(), "jpukb", "KOBE", null, null, "JPHIJ", "  ", null, null, r.entryAt(), "변경", null, "최종", "\t", r.fetchedAt());
        PortCallsInfo.PortCall c = PortCallReader.item(bad);
        assertThat(c.portAuthorityCode()).isNull();
        assertThat(c.portAuthority()).isEqualTo("부산");
        assertThat(c.reportedName()).hasSize(80);
        assertThat(c.firstPort()).isEqualTo(new PortCallsInfo.Port(null, "KOBE"));
        assertThat(c.prevPort()).isNull();
        assertThat(c.nextPort()).isEqualTo(new PortCallsInfo.Port("JPHIJ", null));
        assertThat(c.entryRevision()).as("unknown revision name").isNull();
        assertThat(c.exitAt()).isNull();
        assertThat(c.exitRevision()).as("a revision without a time says nothing").isNull();
        assertThat(c.berth()).isNull();
    }

    @Test void jsonShape_okCarriesIndexAndItems_noCallSignCarriesOnlyItsState() {
        fullFreshIndex();
        index.rows.put("V7A3884", List.of(PortCallFixtures.row(NOW)));
        JsonNode ok = RouteInfoTest.JSON.valueToTree(reader.forCallSign("V7A3884"));
        assertThat(ok.path("status").asString()).isEqualTo("ok");
        assertThat(ok.path("index").path("gaps").isArray()).isTrue();
        assertThat(ok.path("index").path("complete").asBoolean()).isTrue();
        assertThat(ok.path("items").get(0).path("read_at").asString()).isEqualTo(NOW.toString());
        assertThat(ok.has("truncated")).isFalse();
        assertThat(ok.has("disabled_reason")).isFalse();
        JsonNode ncs = RouteInfoTest.JSON.valueToTree(reader.forStatic(null));
        List<String> keys = new ArrayList<>();
        ncs.propertyNames().forEach(keys::add);
        assertThat(keys).containsExactlyInAnyOrder("status", "call_sign_state", "window_days", "source");
    }

    static PortCallIndex.Row copy(PortCallIndex.Row r, String cs, String pa) {
        return new PortCallIndex.Row(r.portAuthorityCode(), pa, cs, r.listedDate(), r.reportedName(), r.nationality(), r.kind(), r.purpose(),
                r.firstPortCode(), r.firstPortName(), r.prevPortCode(), r.prevPortName(), r.nextPortCode(), r.nextPortName(), r.destPortCode(),
                r.destPortName(), r.entryAt(), r.entryRevision(), r.exitAt(), r.exitRevision(), r.berth(), r.fetchedAt());
    }
}
