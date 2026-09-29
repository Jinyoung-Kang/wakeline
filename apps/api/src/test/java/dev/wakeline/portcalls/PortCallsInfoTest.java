package dev.wakeline.portcalls;

import dev.wakeline.route.RouteInfoTest;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 항만 입출항 캐시 값 다시 검사(ADR-022). 기준 값은 수집기가 실제 응답 fixture 로 만든 값(fixtures/portcalls_value_230025.json — 수집기 시험이
 * 같은 파일을 고정한다). 변형은 그 값의 필드만 바꾼 것이다(필드 이름을 지어내지 않는다).
 */
public class PortCallsInfoTest {
    static final JsonNodeFactory F = JsonNodeFactory.instance;
    static final Path SAMPLE = Path.of("../../fixtures/portcalls_value_230025.json").toAbsolutePath().normalize();

    /** 수집기가 fixture 로 만든 캐시 값(ok · 부산 1건). */
    public static ObjectNode sample() {
        try {
            return (ObjectNode) RouteInfoTest.JSON.readTree(Files.readString(SAMPLE)).get("value");
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static PortCallsInfo parse(JsonNode n) { return PortCallsInfo.fromCache("230025", n.toString(), RouteInfoTest.JSON); }

    @Test void sampleFromTheCollectorIsReadField_byField() {
        PortCallsInfo p = parse(sample());
        assertThat(p.status()).isEqualTo("ok");
        assertThat(p.callSign()).isEqualTo("230025");
        assertThat(p.fetchedAt()).isEqualTo(Instant.parse("2026-09-29T03:00:00.123Z"));
        assertThat(p.windowDays()).isEqualTo(30);
        assertThat(p.windowFrom()).isEqualTo("2026-08-30");
        assertThat(p.windowTo()).isEqualTo("2026-09-29");
        assertThat(p.source()).isEqualTo("해양수산부 선박운항정보(PORT-MIS)");
        assertThat(p.truncated()).isNull();
        assertThat(p.incomplete()).isNull();
        assertThat(p.items()).hasSize(1);
        PortCallsInfo.PortCall c = p.items().getFirst();
        assertThat(c.portAuthorityCode()).isEqualTo("020");
        assertThat(c.portAuthority()).isEqualTo("부산");
        assertThat(c.entryAt()).isEqualTo(Instant.parse("2026-09-28T15:00:00Z")); // 2026-09-29T00:00:00+09:00
        assertThat(c.exitAt()).isNull();
        assertThat(c.reports()).containsExactly(new PortCallsInfo.Report("입항", Instant.parse("2026-09-28T15:00:00Z"), "최초"));
        assertThat(c.purpose()).isEqualTo("양하");
        assertThat(c.prevPort()).isEqualTo(new PortCallsInfo.Port("KRYOC", "여천항"));
        assertThat(c.nextPort()).isEqualTo(new PortCallsInfo.Port("KRYOC", "여천항"));
        assertThat(c.destPort()).isEqualTo(new PortCallsInfo.Port("KRYOC", "여천항"));
        assertThat(c.reportedName()).isEqualTo("부광9호");
        assertThat(c.kind()).isEqualTo("석유제품 운반선");
        assertThat(c.nationality()).as("fixture 에 없는 필드 — 모름").isNull();
    }

    @Test void jsonOmitsUnknownValues_andKeepsTheRequiredKeys() {
        JsonNode out = RouteInfoTest.JSON.valueToTree(parse(sample()));
        assertThat(out.path("status").asString()).isEqualTo("ok");
        assertThat(out.path("window_days").asInt()).isEqualTo(30);
        assertThat(out.path("fetched_at").asString()).isEqualTo("2026-09-29T03:00:00.123Z");
        JsonNode item = out.path("items").get(0);
        assertThat(item.has("nationality")).isFalse();
        assertThat(item.has("exit_at")).isFalse();
        assertThat(item.path("prev_port").path("code").asString()).isEqualTo("KRYOC");
        assertThat(item.path("reported_name").asString()).isEqualTo("부광9호");
        assertThat(out.has("error_kind")).isFalse();
        JsonNode pending = RouteInfoTest.JSON.valueToTree(PortCallsInfo.pending("230025"));
        assertThat(pending.path("status").asString()).isEqualTo("pending");
        assertThat(pending.path("source").asString()).isEqualTo(PortCallsInfo.SOURCE);
        assertThat(pending.path("window_days").asInt()).isEqualTo(30);
        assertThat(pending.has("items")).isFalse();
    }

    @Test void missingValueIsPending_unreadableValuesAreCacheErrors_neverNone() {
        assertThat(PortCallsInfo.fromCache("230025", null, RouteInfoTest.JSON).status()).isEqualTo("pending");
        for (String raw : new String[]{"", "{", "[]", "null", "x".repeat(PortCallsInfo.MAX_RAW + 1)}) {
            PortCallsInfo p = PortCallsInfo.fromCache("230025", raw, RouteInfoTest.JSON);
            assertThat(p.status()).as(raw.length() > 20 ? "huge" : raw).isEqualTo("error");
            assertThat(p.errorKind()).isEqualTo("cache");
        }
        ObjectNode v2 = sample().put("v", 2);
        ObjectNode other = sample().put("call_sign", "230026");
        ObjectNode unknown = sample().put("status", "maybe");
        ObjectNode okEmpty = sample();
        okEmpty.set("items", F.arrayNode());
        ObjectNode okJunk = sample();
        okJunk.set("items", F.arrayNode().add(1).add("x"));
        for (ObjectNode n : new ObjectNode[]{v2, other, unknown, okEmpty, okJunk}) {
            assertThat(parse(n)).as(n.toString()).isEqualTo(PortCallsInfo.unreadable("230025"));
        }
    }

    @Test void noneKeepsTheWindow_andBadWindowsAreUnknown() {
        ObjectNode none = sample().put("status", "none");
        none.set("items", F.arrayNode());
        PortCallsInfo p = parse(none);
        assertThat(p.status()).isEqualTo("none");
        assertThat(p.items()).isNull();
        assertThat(p.windowFrom()).isEqualTo("2026-08-30");
        for (String[] w : new String[][]{{"2026-09-29", "2026-08-30"}, {"2026-02-30", "2026-09-29"}, {"20260830", "2026-09-29"}}) {
            ObjectNode n = sample();
            ((ObjectNode) n.get("window")).put("from", w[0]).put("to", w[1]);
            assertThat(parse(n).windowFrom()).as(String.join("/", w)).isNull();
        }
        ObjectNode days = sample();
        ((ObjectNode) days.get("window")).put("days", 7);
        assertThat(parse(days).windowTo()).isNull();
        ObjectNode noWindow = sample();
        noWindow.putNull("window");
        assertThat(parse(noWindow).windowFrom()).isNull();
    }

    @Test void errorCarriesOnlyThePublicKindAndCode_neverTheRawReason() {
        ObjectNode e = sample().put("status", "error").put("error", "daily budget exhausted (used=3000)")
                .put("error_kind", "budget").putNull("error_code");
        e.set("items", F.arrayNode());
        PortCallsInfo p = parse(e);
        assertThat(p.status()).isEqualTo("error");
        assertThat(p.errorKind()).isEqualTo("budget");
        assertThat(p.errorCode()).isNull();
        assertThat(RouteInfoTest.JSON.valueToTree(p).toString()).doesNotContain("3000").doesNotContain("exhausted");
        assertThat(parse(e.put("error_kind", "http").put("error_code", "503")).errorCode()).isEqualTo("503");
        assertThat(parse(e.put("error_code", "5 03")).errorCode()).as("shape-checked").isNull();
        assertThat(parse(e.put("error_kind", "cache")).errorKind()).as("only the api says cache").isEqualTo("internal");
        assertThat(parse(e.put("error_kind", "weird")).errorKind()).isEqualTo("internal");
        e.remove("error_kind");
        assertThat(parse(e).errorKind()).isEqualTo("internal");
    }

    @Test void disabledCarriesAKnownReasonAndNoFetchTime() {
        ObjectNode d = sample().put("status", "disabled").put("reason", "no_key");
        d.set("items", F.arrayNode());
        d.putNull("window");
        PortCallsInfo p = parse(d);
        assertThat(p.status()).isEqualTo("disabled");
        assertThat(p.disabledReason()).isEqualTo("no_key");
        assertThat(p.fetchedAt()).isNull();
        assertThat(parse(d.put("reason", "fixture")).disabledReason()).isEqualTo("fixture");
        assertThat(parse(d.put("reason", "operator")).disabledReason()).isEqualTo("operator");
        assertThat(parse(d.put("reason", "other")).disabledReason()).isNull();
    }

    /** 원소 사본(필드만 바꾼 것 — 이름은 fixture 값의 것 그대로). */
    static ObjectNode item(String code, String entryAt) {
        ObjectNode it = ((ObjectNode) sample().get("items").get(0)).deepCopy();
        it.put("port_authority_code", code);
        if (entryAt == null) it.putNull("entry_at");
        else it.put("entry_at", entryAt);
        it.set("reports", F.arrayNode());
        return it;
    }

    @Test void itemsAreSortedNewestFirst_unknownTimesLast_andCapped() {
        ObjectNode n = sample();
        ArrayNode items = F.arrayNode();
        items.add(item("030", null));
        items.add(item("620", "2026-09-01T00:00:00Z"));
        items.add(item("820", "2026-09-20T00:00:00Z"));
        n.set("items", items);
        assertThat(parse(n).items()).extracting(PortCallsInfo.PortCall::portAuthorityCode).containsExactly("820", "620", "030");

        ArrayNode many = F.arrayNode();
        for (int i = 0; i < 25; i++) many.add(item("020", Instant.parse("2026-09-01T00:00:00Z").plusSeconds(3600L * i).toString()));
        n.set("items", many);
        PortCallsInfo p = parse(n);
        assertThat(p.items()).hasSize(PortCallsInfo.MAX_ITEMS);
        assertThat(p.truncated()).isTrue();
        assertThat(p.items().getFirst().entryAt()).isEqualTo(Instant.parse("2026-09-02T00:00:00Z"));
        n.set("items", F.arrayNode().add(item("020", "2026-09-01T00:00:00Z")));
        assertThat(parse(n.put("truncated", true).put("incomplete", true))).satisfies(q -> {
            assertThat(q.truncated()).isTrue();
            assertThat(q.incomplete()).isTrue();
        });
    }

    @Test void itemFieldsAreShapeChecked_andTextIsCleaned() {
        ObjectNode it = item("20", "2026-09-29T00:00:00"); // 코드 모양 밖 · 시간대 없는 시각 → 모름
        it.put("port_authority", "부산‮\u0007");
        it.put("reported_name", "  부광9호​  ");
        it.put("purpose", "x".repeat(200));
        ((ObjectNode) it.get("prev_port")).put("code", "kryoc");
        ((ObjectNode) it.get("next_port")).put("code", "KRYOC").putNull("name");
        ObjectNode dest = (ObjectNode) it.get("dest_port");
        dest.putNull("code");
        dest.putNull("name");
        ArrayNode reports = F.arrayNode();
        for (int i = 0; i < 12; i++) reports.add(F.objectNode().put("kind", "입항").put("at", "2026-09-28T15:00:00Z").put("type", "최초"));
        reports.add(F.objectNode());
        reports.add("junk");
        it.set("reports", reports);
        ObjectNode n = sample();
        n.set("items", F.arrayNode().add(it));
        PortCallsInfo.PortCall c = parse(n).items().getFirst();
        assertThat(c.portAuthorityCode()).isNull();
        assertThat(c.entryAt()).isNull();
        assertThat(c.portAuthority()).isEqualTo("부산");
        assertThat(c.reportedName()).isEqualTo("부광9호");
        assertThat(c.purpose()).hasSize(PortCallsInfo.TEXT_MAX);
        assertThat(c.prevPort()).isEqualTo(new PortCallsInfo.Port(null, "여천항"));
        assertThat(c.nextPort()).isEqualTo(new PortCallsInfo.Port("KRYOC", null));
        assertThat(c.destPort()).as("neither code nor name").isNull();
        assertThat(c.reports()).hasSize(PortCallsInfo.MAX_REPORTS);
        assertThat(c.latest()).isEqualTo(Instant.parse("2026-09-28T15:00:00Z"));
        it.remove("reports");
        it.put("exit_at", "2026-09-30T01:00:00+09:00");
        assertThat(parse(n).items().getFirst().reports()).isNull();
        assertThat(parse(n).items().getFirst().latest()).isEqualTo(Instant.parse("2026-09-29T16:00:00Z"));
    }
}
