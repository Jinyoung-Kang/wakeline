package dev.wakeline.logs;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Set;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 계약 v5 §C4(api 조회): 최신 순 · 필터(서비스 여러 개 · 수준 · 글자 · fp · 요청 id · 기간) · cursor(마지막 항목 스트림 id) · limit,
 * 한 요청이 훑는 항목 3,000 이하(넘으면 scan_truncated), 읽을 때 스키마 검증(맞지 않으면 건너뛰고 invalid 로 센다)과 한 번 더 가림,
 * fp 묶음(count · suppressed 합 · 처음/마지막 · 표본), 항목 하나.
 */
class LogReaderTest {
    static final Instant T0 = Instant.parse("2026-09-29T00:00:00Z");

    /** 메모리 스트림: id(ms-seq) → 필드 e(없으면 null). XREVRANGE 와 같은 규칙(끝·시작 포함, 최신 순). */
    static final class MemStream implements LogReader.Source {
        final NavigableMap<long[], String> entries = new TreeMap<>((a, b) -> a[0] != b[0] ? Long.compareUnsigned(a[0], b[0]) : Long.compareUnsigned(a[1], b[1]));
        int calls;

        String add(long ms, long seq, String e) { entries.put(new long[]{ms, seq}, e); return ms + "-" + seq; }

        static long[] id(String s) { String[] p = s.split("-"); return new long[]{Long.parseUnsignedLong(p[0]), Long.parseUnsignedLong(p[1])}; }

        @Override
        public List<LogReader.Raw> reverse(String endInclusive, String startInclusive, int count) {
            calls++;
            var view = entries.descendingMap();
            List<LogReader.Raw> out = new ArrayList<>();
            for (var e : view.entrySet()) {
                long[] k = e.getKey();
                if (endInclusive != null && entries.comparator().compare(k, id(endInclusive)) > 0) continue;
                if (startInclusive != null && entries.comparator().compare(k, id(startInclusive)) < 0) break;
                out.add(new LogReader.Raw(Long.toUnsignedString(k[0]) + "-" + Long.toUnsignedString(k[1]), e.getValue()));
                if (out.size() >= count) break;
            }
            return out;
        }

        @Override
        public LogReader.Raw get(String id) {
            String e = entries.get(id(id));
            return e == null && !entries.containsKey(id(id)) ? null : new LogReader.Raw(id, e);
        }
    }

    final MemStream stream = new MemStream();
    final LogReader reader = new LogReader(stream);

    static String event(Instant ts, String service, String level, String logger, String message, String fp, String rid, String stack, int suppressed) {
        var ex = stack == null ? null : new LogEvents.Ex("java.io.IOException", "io", stack);
        var d = new LogEvents.Draft(ts, service, "h:1", level, logger, "t", message, ex, rid, Map.of(), "web-client".equals(service));
        return LogEvents.serialize(d, fp, suppressed);
    }

    static final String FP_A = "aaaaaaaaaaaaaaaa", FP_B = "bbbbbbbbbbbbbbbb";

    /** i 번째(1부터) 항목: ms = T0 + i s. */
    String addEvent(int i, String service, String level, String message, String fp) {
        Instant ts = T0.plusSeconds(i);
        return stream.add(ts.toEpochMilli(), 0, event(ts, service, level, "dev.wakeline.X", message, fp, null, null, 0));
    }

    static LogReader.Filter all() { return new LogReader.Filter(Set.of(), Set.of(), null, null, null, null, null); }

    static List<String> ids(LogReader.Page p) { return p.items().stream().map(n -> n.path("id").asString()).toList(); }

    @Test
    void newestFirstWithCursorPaging() {
        List<String> ids = new ArrayList<>();
        for (int i = 1; i <= 5; i++) ids.add(addEvent(i, "api", "WARN", "m" + i, FP_A));
        LogReader.Page p1 = reader.list(all(), null, 2);
        assertThat(ids(p1)).containsExactly(ids.get(4), ids.get(3));
        assertThat(p1.nextCursor()).isEqualTo(ids.get(3));
        assertThat(p1.scanTruncated()).isFalse();
        JsonNode first = p1.items().getFirst();
        assertThat(first.path("message").asString()).isEqualTo("m5");
        assertThat(first.path("service").asString()).isEqualTo("api");
        assertThat(first.path("fp").asString()).isEqualTo(FP_A);
        LogReader.Page p2 = reader.list(all(), p1.nextCursor(), 2);
        assertThat(ids(p2)).containsExactly(ids.get(2), ids.get(1));
        LogReader.Page p3 = reader.list(all(), p2.nextCursor(), 2);
        assertThat(ids(p3)).containsExactly(ids.get(0));
        assertThat(p3.nextCursor()).as("no more entries").isNull();
        // 마지막 항목에서 정확히 끝나면 다음 쪽이 없다(빈 쪽을 한 번 더 부르게 하지 않는다)
        assertThat(reader.list(all(), ids.get(2), 2).nextCursor()).isNull();
    }

    @Test
    void cursorBoundaryWorksAcrossSequenceZero() {
        String a = stream.add(1000, 0, event(T0, "api", "WARN", "L", "a", FP_A, null, null, 0));
        String b = stream.add(1001, 0, event(T0, "api", "WARN", "L", "b", FP_A, null, null, 0));
        stream.add(1001, 1, event(T0, "api", "WARN", "L", "c", FP_A, null, null, 0));
        assertThat(ids(reader.list(all(), "1001-1", 10))).containsExactly(b, a);
        assertThat(ids(reader.list(all(), b, 10))).containsExactly(a);
        assertThat(reader.list(all(), "0-0", 10).items()).isEmpty();
        assertThat(LogReader.previousId("5-3")).isEqualTo("5-2");
        assertThat(LogReader.previousId("5-0")).isEqualTo("4-18446744073709551615");
        assertThat(LogReader.previousId("0-0")).isNull();
    }

    @Test
    void filtersByServicesLevelTextFpRequestIdAndTime() {
        addEvent(1, "api", "WARN", "slow query 1500 ms", FP_A);
        addEvent(2, "collector", "ERROR", "provider adsb_fi returned 503", FP_B);
        addEvent(3, "ais", "ERROR", "websocket closed (1006)", FP_B);
        Instant t4 = T0.plusSeconds(4);
        stream.add(t4.toEpochMilli(), 0, event(t4, "api", "ERROR", "dev.wakeline.ingest.StreamConsumer", "apply failed", FP_A,
                "0199a3b4c5d6e7f8a9b0c1d2", "java.io.IOException: io\n\tat dev.wakeline.ingest.Codec.aircraft(Codec.java:10)", 0));
        addEvent(5, "web-client", "ERROR", "TypeError: x is undefined", FP_B);

        assertThat(reader.list(new LogReader.Filter(Set.of("api", "ais"), Set.of(), null, null, null, null, null), null, 100).items())
                .extracting(n -> n.path("service").asString()).containsExactly("api", "ais", "api");
        assertThat(reader.list(new LogReader.Filter(Set.of(), Set.of("WARN"), null, null, null, null, null), null, 100).items())
                .extracting(n -> n.path("message").asString()).containsExactly("slow query 1500 ms");
        // 글자 검색: 대소문자 무시, 메시지 · 로거 · 예외(스택 포함)
        assertThat(reader.list(new LogReader.Filter(Set.of(), Set.of(), "ADSB_FI", null, null, null, null), null, 100).items()).hasSize(1);
        assertThat(reader.list(new LogReader.Filter(Set.of(), Set.of(), "codec.aircraft", null, null, null, null), null, 100).items()).hasSize(1);
        assertThat(reader.list(new LogReader.Filter(Set.of(), Set.of(), null, FP_B, null, null, null), null, 100).items()).hasSize(3);
        assertThat(reader.list(new LogReader.Filter(Set.of(), Set.of(), null, null, "0199a3b4c5d6e7f8a9b0c1d2", null, null), null, 100).items())
                .extracting(n -> n.path("message").asString()).containsExactly("apply failed");
        // 기간: 항목의 ts 기준, 양 끝 포함
        assertThat(reader.list(new LogReader.Filter(Set.of(), Set.of(), null, null, null, T0.plusSeconds(2), T0.plusSeconds(3)), null, 100).items())
                .extracting(n -> n.path("service").asString()).containsExactly("ais", "collector");
        // web-client 항목은 untrusted 표시가 그대로 나간다
        assertThat(reader.list(new LogReader.Filter(Set.of("web-client"), Set.of(), null, null, null, null, null), null, 100).items().getFirst()
                .path("untrusted").asBoolean()).isTrue();
    }

    @Test
    void invalidEntriesAreSkippedAndCounted() {
        addEvent(1, "api", "WARN", "ok 1", FP_A);
        stream.add(T0.plusSeconds(2).toEpochMilli(), 0, "not json");
        stream.add(T0.plusSeconds(3).toEpochMilli(), 0, "{\"v\":1,\"service\":\"api\"}");          // 필수 필드 없음
        stream.add(T0.plusSeconds(4).toEpochMilli(), 0, null);                                      // 필드 e 없음
        stream.add(T0.plusSeconds(5).toEpochMilli(), 0, event(T0, "api", "WARN", "L", "x", "NOT-A-FP", null, null, 0));
        addEvent(6, "api", "WARN", "ok 6", FP_A);
        LogReader.Page p = reader.list(all(), null, 100);
        assertThat(p.items()).extracting(n -> n.path("message").asString()).containsExactly("ok 6", "ok 1");
        assertThat(p.invalid()).isEqualTo(4);
        assertThat(p.scanned()).isEqualTo(6);
    }

    @Test
    void readIsMaskedOnceMore_defensively() {
        LogMasker.registerSecrets("redis-pass-value");
        try {
            Instant ts = T0.plusSeconds(1);
            // 가리지 않고 실은 생산자(버그)라도 읽을 때 가린다
            stream.add(ts.toEpochMilli(), 0, event(ts, "collector", "ERROR", "L", "GET /x?serviceKey=SK123 auth redis-pass-value", FP_A, null,
                    "Traceback: password=hunter2", 0));
            Instant t2 = T0.plusSeconds(2);
            // 브라우저가 보낸 component(로거) · 이름 칸도 다시 가린다
            var d = new LogEvents.Draft(t2, "web-client", "h:1", "ERROR", "MapView token=abc123", "t secret=s3", "m",
                    new LogEvents.Ex("E password=pw9", null, "s"), null, Map.of(), true);
            stream.add(t2.toEpochMilli(), 0, LogEvents.serialize(d, FP_B, 0));
            JsonNode w = reader.list(all(), null, 10).items().getFirst();
            assertThat(w.path("logger").asString()).isEqualTo("MapView token=***");
            assertThat(w.path("thread").asString()).isEqualTo("t secret=***");
            assertThat(w.path("exception").path("type").asString()).isEqualTo("E password=***");
            JsonNode n = reader.list(all(), null, 10).items().get(1);
            assertThat(n.path("message").asString()).isEqualTo("GET /x?serviceKey=*** auth ***");
            assertThat(n.path("exception").path("stack").asString()).isEqualTo("Traceback: password=***");
            // 가린 글자로만 찾는다(비밀값으로 검색해 존재를 알아내지 못하게)
            assertThat(reader.list(new LogReader.Filter(Set.of(), Set.of(), "hunter2", null, null, null, null), null, 10).items()).isEmpty();
        } finally {
            LogMasker.clearSecrets();
        }
    }

    @Test
    void oneRequestScansAtMost3000Entries() {
        for (int i = 1; i <= 3_500; i++) stream.add(T0.toEpochMilli() + i, 0, event(T0, "api", "WARN", "L", "m", FP_A, null, null, 0));
        var f = new LogReader.Filter(Set.of("ais"), Set.of(), null, null, null, null, null); // 아무것도 맞지 않는다
        LogReader.Page p = reader.list(f, null, 100);
        assertThat(p.items()).isEmpty();
        assertThat(p.scanned()).isEqualTo(3_000);
        assertThat(p.scanTruncated()).isTrue();
        assertThat(p.nextCursor()).as("continue where the scan stopped").isEqualTo((T0.toEpochMilli() + 501) + "-0");
        LogReader.Page rest = reader.list(f, p.nextCursor(), 100);
        assertThat(rest.scanned()).isEqualTo(500);
        assertThat(rest.scanTruncated()).isFalse();
        assertThat(rest.nextCursor()).isNull();
    }

    @Test
    void groupsByFingerprintWithCountsSuppressedAndTimes() {
        Instant t1 = T0.plusSeconds(1), t2 = T0.plusSeconds(2), t3 = T0.plusSeconds(3), t4 = T0.plusSeconds(4);
        stream.add(t1.toEpochMilli(), 0, event(t1, "api", "ERROR", "dev.wakeline.A", "timeout 1", FP_A, null, "s", 0));
        stream.add(t2.toEpochMilli(), 0, event(t2, "collector", "WARN", "wakeline_collector.x", "slow", FP_B, null, null, 0));
        stream.add(t3.toEpochMilli(), 0, event(t3, "api", "ERROR", "dev.wakeline.A", "timeout 3", FP_A, null, "s", 5));
        String last = stream.add(t4.toEpochMilli(), 0, event(t4, "collector", "WARN", "wakeline_collector.x", "slow again", FP_B, null, null, 2));
        stream.add(T0.plusSeconds(5).toEpochMilli(), 0, "garbage");
        LogReader.Groups g = reader.groups(all());
        assertThat(g.groups()).hasSize(2);
        LogReader.Group b = g.groups().getFirst(); // 가장 최근 것부터
        assertThat(b.fp()).isEqualTo(FP_B);
        assertThat(b.service()).isEqualTo("collector");
        assertThat(b.level()).isEqualTo("WARN");
        assertThat(b.logger()).isEqualTo("wakeline_collector.x");
        assertThat(b.exceptionType()).isNull();
        assertThat(b.sampleMessage()).isEqualTo("slow again");
        assertThat(b.count()).isEqualTo(2);
        assertThat(b.suppressed()).isEqualTo(2);
        assertThat(b.firstAt()).isEqualTo("2026-09-29T00:00:02.000Z");
        assertThat(b.lastAt()).isEqualTo("2026-09-29T00:00:04.000Z");
        assertThat(b.lastId()).isEqualTo(last);
        LogReader.Group a = g.groups().get(1);
        assertThat(a.count()).isEqualTo(2);
        assertThat(a.suppressed()).isEqualTo(5);
        assertThat(a.exceptionType()).isEqualTo("java.io.IOException");
        assertThat(g.invalid()).isEqualTo(1);
        assertThat(g.scanned()).isEqualTo(5);
        assertThat(g.scanTruncated()).isFalse();
        // 서비스 · 수준 · 기간으로 좁힌다
        assertThat(reader.groups(new LogReader.Filter(Set.of("api"), Set.of(), null, null, null, null, null)).groups())
                .extracting(LogReader.Group::fp).containsExactly(FP_A);
        assertThat(reader.groups(new LogReader.Filter(Set.of(), Set.of("ERROR"), null, null, null, null, null)).groups()).hasSize(1);
        LogReader.Groups since3 = reader.groups(new LogReader.Filter(Set.of(), Set.of(), null, null, null, t3, null));
        assertThat(since3.groups()).extracting(LogReader.Group::count).containsExactly(1L, 1L);
    }

    @Test
    void groupsScanAtMost3000() {
        for (int i = 1; i <= 3_100; i++) stream.add(T0.toEpochMilli() + i, 0, event(T0, "api", "WARN", "L", "m", FP_A, null, null, 0));
        LogReader.Groups g = reader.groups(all());
        assertThat(g.scanned()).isEqualTo(3_000);
        assertThat(g.scanTruncated()).isTrue();
        assertThat(g.groups().getFirst().count()).isEqualTo(3_000);
    }

    /**
     * 계약 v5 §C4 · §C6: 읽을 때 한 번 더 가리는 비용이 항목 크기에 비례한다. 누구나 보낼 수 있는 브라우저 오류로 되짚기가 많은 글(낱말 글자열 ·
     * 'eyJ' 반복 · ':' 로 이어진 URL · 보조 평면 글자)을 3,000건 심어도 한 번 훑기가 몇 초 안에 끝난다(고치기 전: 300건에 groups 48 s ·
     * 'eyJ' 200건에 97 s — 웹 /logs 는 15 s 마다 새로 읽는다). 가리는 글의 길이는 스키마 검증(가리기 전)이 이미 묶는다:
     * message ≤ 4000 · 예외 메시지 ≤ 2000 · stack ≤ 12000 · context 값 ≤ 200(코드 포인트).
     */
    @Test
    void rescanningAdversarialBrowserReportsStaysFast() {
        String astral = "\uD835\uDC00"; // 𝐀
        String[] messages = {"eyJ".repeat(660), "B".repeat(1990), "a://x:".repeat(330), astral.repeat(900)};
        String[] stacks = {"A".repeat(6000), "eyJ".repeat(2000), astral.repeat(1500), "a://x:".repeat(1000)};
        for (int i = 0; i < LogReader.SCAN_MAX; i++) {
            Instant ts = T0.plusMillis(i);
            var d = new LogEvents.Draft(ts, "web-client", "h:1", "ERROR", "browser", null, messages[i % 4], new LogEvents.Ex("", null, stacks[(i / 4) % 4]),
                    null, Map.of("path", "/" + "p".repeat(150), "user_agent", "U".repeat(200)), true);
            stream.add(ts.toEpochMilli(), 0, LogEvents.serialize(d, FP_A, 0));
        }
        long t0 = System.nanoTime();
        LogReader.Groups g = reader.groups(all());
        LogReader.Page p = reader.list(new LogReader.Filter(Set.of(), Set.of(), "no such text", null, null, null, null), null, 100);
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertThat(g.scanned()).isEqualTo(3_000);
        assertThat(g.invalid()).isZero();
        assertThat(g.groups()).singleElement().extracting(LogReader.Group::count).isEqualTo(3_000L);
        assertThat(p.scanned()).isEqualTo(3_000);
        assertThat(p.items()).isEmpty();
        // 선형이면 두 번 훑기(6,000건 · 검증 포함)가 1–2 s 다. 부하가 큰 기계에서도 흔들리지 않게 넉넉히 — 고치기 전에는 몇 분
        assertThat(ms).as("groups + list over 3,000 adversarial entries took %d ms", ms).isLessThan(20_000);
    }

    @Test
    void oneEntryById() {
        String id = addEvent(1, "api", "ERROR", "boom", FP_A);
        String bad = stream.add(T0.plusSeconds(2).toEpochMilli(), 0, "{}");
        JsonNode n = reader.get(id);
        assertThat(n.path("id").asString()).isEqualTo(id);
        assertThat(n.path("message").asString()).isEqualTo("boom");
        assertThat(reader.get("1-0")).as("trimmed").isNull();
        assertThat(reader.get(bad)).as("schema-invalid").isNull();
    }
}
