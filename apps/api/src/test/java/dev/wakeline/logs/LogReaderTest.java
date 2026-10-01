package dev.wakeline.logs;

import dev.wakeline.platform.support.LogMasker;
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
 * 한 요청이 훑는 항목 상한(넘으면 scan_truncated), 읽을 때 스키마 검증(맞지 않으면 건너뛰고 invalid 로 센다)과 한 번 더 가림,
 * fp 묶음(count · suppressed 합 · 처음/마지막 · 표본), 항목 하나.
 * §G2: 서버 로그(wakeline:logs)와 브라우저 오류(wakeline:logs:client)를 id 순으로 합쳐 최신 순 — 항목마다 stream, cursor 는 두 스트림을 함께 이어 가고
 * (같은 id 는 server 가 앞), 훑기 상한은 스트림마다 MAXLEN + 노드 하나의 합(4,200), 묶음도 두 스트림, 항목 하나는 server → client 순으로 찾는다.
 * 첫 쪽 · 묶음은 두 스트림의 한 시점(Redis TIME 앞 밀리초까지) — 두 스트림 읽기 사이에 실린 항목도 첫 쪽에 있거나 첫 쪽 맨 위보다 새 것이다.
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
    /** 브라우저 오류 스트림(§G2). */
    final MemStream client = new MemStream();
    final LogReader reader = new LogReader(stream, client);

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

    /** "stream:id" — 두 스트림을 합친 목록의 항목 식별. */
    static List<String> keys(LogReader.Page p) { return p.items().stream().map(n -> n.path("stream").asString() + ":" + n.path("id").asString()).toList(); }

    /** 브라우저 오류 스트림에 i 번째(1부터) 항목: ms = T0 + i s. */
    String addClient(int i, String message) {
        Instant ts = T0.plusSeconds(i);
        return client.add(ts.toEpochMilli(), 0, event(ts, "web-client", "ERROR", "browser", message, FP_B, null, null, 0));
    }

    @Test
    void newestFirstWithCursorPaging() {
        List<String> ids = new ArrayList<>();
        for (int i = 1; i <= 5; i++) ids.add(addEvent(i, "api", "WARN", "m" + i, FP_A));
        LogReader.Page p1 = reader.list(all(), null, 2);
        assertThat(ids(p1)).containsExactly(ids.get(4), ids.get(3));
        assertThat(p1.nextCursor()).isEqualTo("server:" + ids.get(3));
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
        assertThat(reader.list(all(), "server:" + ids.get(2), 2).nextCursor()).isNull();
        // §G2 전의 커서(스트림 id 만)는 서버 스트림의 것 — 그대로 이어 읽는다
        assertThat(ids(reader.list(all(), ids.get(3), 2))).containsExactly(ids.get(2), ids.get(1));
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
    void oneRequestScansAtMostTheSumOfBothStreamCaps() {
        assertThat(LogReader.SCAN_MAX).as("wakeline:logs ~3000 + wakeline:logs:client ~1000, each plus one redis stream node").isEqualTo(4_200);
        for (int i = 1; i <= 4_500; i++) stream.add(T0.toEpochMilli() + i, 0, event(T0, "api", "WARN", "L", "m", FP_A, null, null, 0));
        var f = new LogReader.Filter(Set.of("ais"), Set.of(), null, null, null, null, null); // 아무것도 맞지 않는다
        LogReader.Page p = reader.list(f, null, 100);
        assertThat(p.items()).isEmpty();
        assertThat(p.scanned()).isEqualTo(4_200);
        assertThat(p.scanTruncated()).isTrue();
        assertThat(p.nextCursor()).as("continue where the scan stopped").isEqualTo("server:" + (T0.toEpochMilli() + 301) + "-0");
        LogReader.Page rest = reader.list(f, p.nextCursor(), 100);
        assertThat(rest.scanned()).isEqualTo(300);
        assertThat(rest.scanTruncated()).isFalse();
        assertThat(rest.nextCursor()).isNull();
    }

    /** §G2: 두 스트림을 id 순으로 합쳐 최신 순 — 항목마다 stream(server | client). */
    @Test
    void mergesBothStreamsNewestFirstAndTagsEachEntryWithItsStream() {
        String s1 = addEvent(1, "api", "WARN", "s1", FP_A);
        String c2 = addClient(2, "c2");
        String s3 = addEvent(3, "collector", "ERROR", "s3", FP_A);
        String c4 = addClient(4, "c4");
        String s5 = addEvent(5, "ais", "ERROR", "s5", FP_A);
        LogReader.Page p = reader.list(all(), null, 100);
        assertThat(keys(p)).containsExactly("server:" + s5, "client:" + c4, "server:" + s3, "client:" + c2, "server:" + s1);
        assertThat(p.items().get(1).path("message").asString()).isEqualTo("c4");
        assertThat(p.items().get(1).path("untrusted").asBoolean()).isTrue();
        assertThat(p.scanned()).isEqualTo(5);
        assertThat(p.nextCursor()).isNull();
        // 필터는 두 스트림에 똑같이
        assertThat(keys(reader.list(new LogReader.Filter(Set.of("web-client"), Set.of(), null, null, null, null, null), null, 100)))
                .containsExactly("client:" + c4, "client:" + c2);
        assertThat(keys(reader.list(new LogReader.Filter(Set.of(), Set.of(), null, null, null, T0.plusSeconds(3), T0.plusSeconds(4)), null, 100)))
                .containsExactly("client:" + c4, "server:" + s3);
        // 브라우저 오류가 없으면 서버 로그만(스트림이 없어도 된다)
        assertThat(new LogReader(stream, new MemStream()).list(all(), null, 100).items()).hasSize(3);
    }

    /** §G2: cursor 는 두 스트림을 함께 이어 간다 — 쪽을 어디서 끊어도 빠지거나 겹치는 항목이 없다. */
    @Test
    void cursorContinuesAcrossBothStreamsWithoutGapsOrRepeats() {
        List<String> all = new ArrayList<>();
        for (int i = 1; i <= 11; i++) all.add(i % 3 == 0 ? "client:" + addClient(i, "c" + i) : "server:" + addEvent(i, "api", "WARN", "s" + i, FP_A));
        List<String> newestFirst = new ArrayList<>(all.reversed());
        for (int limit = 1; limit <= 4; limit++) {
            List<String> got = new ArrayList<>();
            String cursor = null;
            int pages = 0;
            do {
                LogReader.Page p = reader.list(all(), cursor, limit);
                got.addAll(keys(p));
                cursor = p.nextCursor();
                if (cursor != null) assertThat(cursor).as("cursor names the stream of the last entry").isEqualTo(keys(p).getLast());
                assertThat(++pages).isLessThanOrEqualTo(11);
            } while (cursor != null);
            assertThat(got).as("limit " + limit).containsExactlyElementsOf(newestFirst);
        }
    }

    /** 합친 순서(api 목록 순서 — 웹 entryCmp 와 같다)에서 a 가 b 보다 새 것인가: 스트림 id 가 크거나, 같으면 server 가 앞. */
    static boolean newer(JsonNode a, JsonNode b) {
        int c = LogReader.compareIds(a.path("id").asString(), b.path("id").asString());
        return c != 0 ? c > 0 : "server".equals(a.path("stream").asString()) && "client".equals(b.path("stream").asString());
    }

    static String key(JsonNode n) { return n.path("stream").asString() + ":" + n.path("id").asString(); }

    /**
     * 웹 /logs 가 첫 쪽을 보인 뒤 항목을 보게 되는 길은 셋이다: 그 첫 쪽, 자동 새로 고침의 "새 항목"(다시 읽은 첫 쪽에서 보이는 맨 위보다 새 것 —
     * lib/logs.ts pendingEntries), '이전 항목 더 보기'(next_cursor 로 이어 읽기). 나중에 두 스트림 전체를 읽었을 때 모든 항목이 이 셋 중
     * 하나로 — 한 번씩 — 보여야 한다.
     */
    static void assertEveryEntryIsReachableFrom(LogReader.Page page1, LogReader later) {
        List<String> seen = new ArrayList<>(keys(page1));
        JsonNode top = page1.items().getFirst();
        for (JsonNode n : later.list(all(), null, 200).items()) if (newer(n, top)) seen.add(key(n)); // 새 항목 N건
        for (String cursor = page1.nextCursor(); cursor != null; ) {                                       // 이전 항목 더 보기
            LogReader.Page p = later.list(all(), cursor, 2);
            seen.addAll(keys(p));
            cursor = p.nextCursor();
        }
        List<String> everything = keys(later.list(all(), null, 200));
        assertThat(seen).as("page 1 %s, then new entries and older pages", keys(page1)).containsExactlyInAnyOrderElementsOf(everything);
    }

    /** 스트림 하나 앞에 끼워 넣어, 처음 읽힐 때 한 번만 일을 한다(두 스트림 읽기 사이에 다른 항목이 실리는 경우). */
    static LogReader.Source onFirstRead(LogReader.Source src, Runnable arrive) {
        return new LogReader.Source() {
            boolean fired;

            @Override
            public List<LogReader.Raw> reverse(String endInclusive, String startInclusive, int count) {
                if (!fired) { fired = true; arrive.run(); }
                return src.reverse(endInclusive, startInclusive, count);
            }

            @Override
            public LogReader.Raw get(String id) { return src.get(id); }
        };
    }

    /**
     * §G2 첫 쪽은 두 스트림의 한 시점 모습이어야 한다. 두 스트림은 XREVRANGE 를 따로 부르므로 그 사이에(api 싱크가 [S, C] 한 묶음을
     * 차례로 XADD) 서버 항목 S 와 그보다 새 브라우저 오류 C 가 실리면, 고치기 전에는 첫 쪽에 C 만 있고 S 는 C 보다 오래돼 "새 항목"에도,
     * cursor 아래에도 없었다(리뷰 RaceProbe). Redis 는 TIME 뒤에 실린 항목에 그 시각 이상의 id 를 준다 — 첫 쪽을 TIME 앞 밀리초까지로 자르면
     * 그 뒤에 실린 것은 모두 첫 쪽 맨 위보다 새 것이다.
     */
    @Test
    void anEntryArrivingBetweenTheTwoStreamReadsIsOnPage1OrNewerThanItsTop() {
        long now = T0.plusSeconds(100).toEpochMilli(); // Redis TIME(첫 쪽을 읽기 전)
        addEvent(1, "api", "WARN", "old 1", FP_A);
        addClient(2, "old 2");
        addEvent(3, "api", "WARN", "old 3", FP_A);
        Instant at = Instant.ofEpochMilli(now);
        // 서버 스트림을 읽은 뒤 · 브라우저 오류 스트림을 읽기 전에 두 항목이 실린다(TIME 뒤이므로 id 의 ms ≥ now)
        LogReader racy = new LogReader(stream, onFirstRead(client, () -> {
            stream.add(now, 0, event(at, "api", "ERROR", "L", "S (server, arrives mid-read)", FP_A, null, null, 0));
            client.add(now + 1, 0, event(at, "web-client", "ERROR", "browser", "C (client, arrives mid-read)", FP_B, null, null, 0));
        }), () -> now);
        LogReader.Page page1 = racy.list(all(), null, 100);
        assertEveryEntryIsReachableFrom(page1, new LogReader(stream, client, () -> now + 60_000));
        // 쪽이 작아 cursor 로 이어 읽어도 같다
        stream.entries.clear();
        client.entries.clear();
        for (int i = 1; i <= 7; i++) { if (i % 2 == 0) addClient(i, "old " + i); else addEvent(i, "api", "WARN", "old " + i, FP_A); }
        LogReader racy2 = new LogReader(stream, onFirstRead(client, () -> {
            stream.add(now, 0, event(at, "api", "ERROR", "L", "S", FP_A, null, null, 0));
            client.add(now + 1, 0, event(at, "web-client", "ERROR", "browser", "C", FP_B, null, null, 0));
        }), () -> now);
        assertEveryEntryIsReachableFrom(racy2.list(all(), null, 3), new LogReader(stream, client, () -> now + 60_000));
    }

    /**
     * 두 스트림은 순번을 따로 매기므로, 같은 밀리초 안에서는 나중에 실린 항목의 id 가 다른 스트림에 먼저 실린 항목보다 작을 수 있다
     * (브라우저 오류 T-0 … T-4 뒤에 서버 T-0). 그래서 첫 쪽은 TIME 의 밀리초를 통째로 뺀다 — 그 밀리초의 항목은 다음 새로 고침에 "새 항목"으로.
     */
    @Test
    void entriesOfTheCurrentMillisecondWaitForTheNextRefresh() {
        long now = T0.plusSeconds(100).toEpochMilli();
        Instant at = Instant.ofEpochMilli(now);
        addEvent(1, "api", "WARN", "old 1", FP_A);
        stream.add(now - 1, 0, event(at, "api", "WARN", "L", "just before", FP_A, null, null, 0));
        for (int seq = 0; seq < 5; seq++) client.add(now, seq, event(at, "web-client", "ERROR", "browser", "same ms " + seq, FP_B, null, null, 0));
        // 브라우저 오류 스트림을 읽을 때 서버 스트림에 같은 밀리초의 첫 항목(now-0)이 실린다 — 브라우저 오류 now-4 보다 id 가 작다
        LogReader racy = new LogReader(stream, onFirstRead(client, () ->
                stream.add(now, 0, event(at, "api", "ERROR", "L", "server, same ms", FP_A, null, null, 0))), () -> now);
        LogReader.Page page1 = racy.list(all(), null, 100);
        assertThat(keys(page1)).as("nothing at or after the Redis time").allMatch(k -> LogReader.compareIds(k.substring(k.indexOf(':') + 1), now + "-0") < 0);
        assertEveryEntryIsReachableFrom(page1, new LogReader(stream, client, () -> now + 1));
        // 묶음도 같은 시점까지(첫 쪽과 같은 모습)
        assertThat(new LogReader(stream, client, () -> now).groups(all()).scanned()).isEqualTo(2);
    }

    /**
     * 첫 쪽을 Redis TIME 으로 자르는 것은 스트림 id 가 Redis 시계를 따른다는 전제다. id 가 시계보다 앞서면(Redis 호스트 시계가 뒤로 감 — Redis 는
     * 그동안 마지막 id 의 ms 를 이어 쓴다 · id 를 지정한 XADD) 자르기가 새 항목을 시계가 따라잡을 때까지 숨긴다. 시계 차이 여유(SKEW_MS) 안이면
     * 잠깐 숨겼다가 "새 항목"으로 보이고, 그보다 앞서면 자르지 않는다 — 새 오류를 오래 숨기지 않는다(그때는 두 스트림 읽기 사이의 경합을 막지 못한다).
     */
    @Test
    void streamIdsFarAheadOfTheRedisClockAreNotHidden() {
        long now = T0.plusSeconds(100).toEpochMilli();
        Instant at = Instant.ofEpochMilli(now);
        addEvent(1, "api", "WARN", "old 1", FP_A);
        addClient(2, "old 2");
        long ahead = now + LogReader.SKEW_MS + 1;
        stream.add(ahead, 0, event(at, "api", "ERROR", "L", "clock stepped back", FP_A, null, null, 0));
        stream.add(ahead, 1, event(at, "api", "ERROR", "L", "clock stepped back, next", FP_A, null, null, 0));
        LogReader.Page p = new LogReader(stream, client, () -> now).list(all(), null, 100);
        assertThat(keys(p)).containsExactly("server:" + ahead + "-1", "server:" + ahead + "-0", "client:" + T0.plusSeconds(2).toEpochMilli() + "-0",
                "server:" + T0.plusSeconds(1).toEpochMilli() + "-0");
        assertThat(new LogReader(stream, client, () -> now).groups(all()).scanned()).isEqualTo(4);
        // 여유 안(시계가 몇 초 뒤로 간 정도)이면 잠깐 숨긴다 — 시계가 지나가면 첫 쪽 맨 위보다 새 것으로 보인다
        stream.entries.clear();
        addEvent(1, "api", "WARN", "old 1", FP_A);
        long near = now + LogReader.SKEW_MS;
        stream.add(near, 0, event(at, "api", "ERROR", "L", "a few seconds ahead", FP_A, null, null, 0));
        LogReader.Page q = new LogReader(stream, client, () -> now).list(all(), null, 100);
        assertThat(keys(q)).doesNotContain("server:" + near + "-0");
        assertEveryEntryIsReachableFrom(q, new LogReader(stream, client, () -> near + 1));
    }

    /**
     * §G2: 두 스트림은 id 를 따로 매기므로 같은 id 가 둘 다에 있을 수 있다(같은 밀리초 · 같은 순번). 같은 id 는 server 가 앞 —
     * 쪽이 그 둘 사이에서 끊겨도(server 다음) 다음 쪽이 client 쪽을 빠뜨리지 않고, client 다음이면 server 쪽을 다시 싣지 않는다.
     */
    @Test
    void theSameIdInBothStreamsIsServerFirstAndTheCursorSplitsThePairExactly() {
        Instant t = T0.plusSeconds(10);
        stream.add(t.toEpochMilli(), 0, event(t, "api", "ERROR", "L", "server twin", FP_A, null, null, 0));
        client.add(t.toEpochMilli(), 0, event(t, "web-client", "ERROR", "browser", "client twin", FP_B, null, null, 0));
        String older = addEvent(1, "api", "WARN", "older", FP_A);
        String id = t.toEpochMilli() + "-0";
        LogReader.Page p1 = reader.list(all(), null, 1);
        assertThat(keys(p1)).containsExactly("server:" + id);
        assertThat(p1.nextCursor()).isEqualTo("server:" + id);
        LogReader.Page p2 = reader.list(all(), p1.nextCursor(), 1);
        assertThat(keys(p2)).containsExactly("client:" + id);
        assertThat(p2.nextCursor()).isEqualTo("client:" + id);
        LogReader.Page p3 = reader.list(all(), p2.nextCursor(), 1);
        assertThat(keys(p3)).containsExactly("server:" + older);
        assertThat(p3.nextCursor()).isNull();
        // 스트림 id 만 있는 옛 커서는 server 의 것 — client 쪽 쌍둥이부터
        assertThat(keys(reader.list(all(), id, 10))).containsExactly("client:" + id, "server:" + older);
        assertThat(LogReader.parseCursor("client:" + id)).isEqualTo(new LogReader.Cursor(LogStream.CLIENT, id));
        assertThat(LogReader.parseCursor(id)).isEqualTo(new LogReader.Cursor(LogStream.SERVER, id));
        for (String bad : new String[]{"edge:" + id, "client:", "client:x-1", ":" + id, "18446744073709551616-0", null})
            assertThat(LogReader.parseCursor(bad)).as(String.valueOf(bad)).isNull();
    }

    /**
     * §G2 의 목적: 누구나 보낼 수 있는 브라우저 오류가 가득(모두 가장 최근)이어도 한 번 훑기가 서버 로그를 모두 본다 — 익명 입력이 서버 로그의 몫을
     * 쓰지 못한다. "가득"은 MAXLEN ~ 의 근사 트림 그대로: Redis 는 내부 노드(stream-node-max-entries 기본 100) 통째로만 자르므로 한 스트림이
     * MAXLEN + 99 건까지 남는다(실제 Redis 에서 3,300 · 1,150 건을 실으면 3,000 · 1,050 — 리뷰 · LogsIT). 두 스트림 모두 그 끝(3,099 · 1,099)이어도.
     */
    @Test
    void aFullClientStreamDoesNotCrowdServerEntriesOutOfOneScan() {
        int serverFull = 3_099, clientFull = 1_099; // MAXLEN ~ 3000 · ~ 1000 이 남길 수 있는 가장 많은 수
        for (int i = 1; i <= serverFull; i++) stream.add(T0.toEpochMilli() + i, 0, event(T0, "api", "ERROR", "L", "server " + i + ".", FP_A, null, null, 0));
        for (int i = 1; i <= clientFull; i++) client.add(T0.toEpochMilli() + 10_000 + i, 0, event(T0, "web-client", "ERROR", "browser", "flood " + i, FP_B, null, null, 0));
        LogReader.Groups g = reader.groups(new LogReader.Filter(Set.of("api"), Set.of(), null, null, null, null, null));
        assertThat(g.scanned()).isEqualTo(serverFull + clientFull);
        assertThat(g.scanTruncated()).isFalse();
        assertThat(g.groups()).singleElement().extracting(LogReader.Group::count).isEqualTo((long) serverFull);
        // 가장 오래된 서버 항목까지 한 번에 찾는다(§G2 전: 3,000건 상한 안에서 브라우저 오류 1,000건이 먼저 훑여 서버 로그 2,000건만 보였다 ·
        // 4,000건 상한이던 때는 두 스트림이 근사 트림 끝이면 가장 오래된 서버 항목 198건이 빠졌다)
        LogReader.Page p = reader.list(new LogReader.Filter(Set.of("api"), Set.of(), "server 1.", null, null, null, null), null, 200);
        assertThat(p.items()).extracting(n -> n.path("message").asString()).containsExactly("server 1.");
        assertThat(p.scanned()).isEqualTo(serverFull + clientFull);
        assertThat(p.scanTruncated()).isFalse();
        assertThat(p.nextCursor()).isNull();
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
    void groupsScanAtMostTheSumOfBothStreamCaps() {
        for (int i = 1; i <= 3_300; i++) stream.add(T0.toEpochMilli() + i, 0, event(T0, "api", "WARN", "L", "m", FP_A, null, null, 0));
        for (int i = 1; i <= 1_000; i++) client.add(T0.toEpochMilli() + 5_000 + i, 0, event(T0, "web-client", "ERROR", "browser", "c", FP_B, null, null, 0));
        LogReader.Groups g = reader.groups(all());
        assertThat(g.scanned()).isEqualTo(4_200);
        assertThat(g.scanTruncated()).isTrue();
        assertThat(g.groups()).extracting(LogReader.Group::count).containsExactly(1_000L, 3_200L);
    }

    /** §G2: 묶음은 두 스트림을 함께 — last_stream 이 last_id 가 어느 스트림의 id 인지 말한다. */
    @Test
    void groupsCoverBothStreams() {
        addEvent(1, "api", "ERROR", "timeout 1", FP_A);
        addClient(2, "TypeError: x");
        String lastServer = addEvent(3, "api", "ERROR", "timeout 3", FP_A);
        String lastClient = addClient(4, "TypeError: y");
        LogReader.Groups g = reader.groups(all());
        assertThat(g.scanned()).isEqualTo(4);
        assertThat(g.groups()).extracting(LogReader.Group::service).containsExactly("web-client", "api");
        LogReader.Group web = g.groups().getFirst();
        assertThat(web.count()).isEqualTo(2);
        assertThat(web.lastId()).isEqualTo(lastClient);
        assertThat(web.lastStream()).isEqualTo("client");
        assertThat(web.firstAt()).isEqualTo("2026-09-29T00:00:02.000Z");
        LogReader.Group api = g.groups().get(1);
        assertThat(api.count()).isEqualTo(2);
        assertThat(api.lastId()).isEqualTo(lastServer);
        assertThat(api.lastStream()).isEqualTo("server");
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
            // 브라우저 오류 스트림은 가득(1,000), 나머지는 서버 스트림(§G2 전에 실린 web-client 항목 · 서비스를 속인 항목)
            (i % 4 == 0 ? client : stream).add(ts.toEpochMilli(), 0, LogEvents.serialize(d, FP_A, 0));
        }
        long t0 = System.nanoTime();
        LogReader.Groups g = reader.groups(all());
        LogReader.Page p = reader.list(new LogReader.Filter(Set.of(), Set.of(), "no such text", null, null, null, null), null, 100);
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertThat(g.scanned()).isEqualTo(LogReader.SCAN_MAX);
        assertThat(g.invalid()).isZero();
        assertThat(g.groups()).singleElement().extracting(LogReader.Group::count).isEqualTo((long) LogReader.SCAN_MAX);
        assertThat(p.scanned()).isEqualTo(LogReader.SCAN_MAX);
        assertThat(p.items()).isEmpty();
        // 선형이면 두 번 훑기(8,000건 · 검증 포함)가 몇 초다. 부하가 큰 기계에서도 흔들리지 않게 넉넉히 — 고치기 전에는 몇 분
        assertThat(ms).as("groups + list over %d adversarial entries took %d ms", LogReader.SCAN_MAX, ms).isLessThan(20_000);
    }

    @Test
    void oneEntryById() {
        String id = addEvent(1, "api", "ERROR", "boom", FP_A);
        String bad = stream.add(T0.plusSeconds(2).toEpochMilli(), 0, "{}");
        JsonNode n = reader.get(id);
        assertThat(n.path("id").asString()).isEqualTo(id);
        assertThat(n.path("stream").asString()).isEqualTo("server");
        assertThat(n.path("message").asString()).isEqualTo("boom");
        assertThat(reader.get("1-0")).as("trimmed").isNull();
        assertThat(reader.get(bad)).as("schema-invalid").isNull();
    }

    /** §G2: 항목 하나는 server → client 순으로 찾는다. 스트림을 지정하면 그 스트림에서만(같은 id 가 둘 다에 있을 때 client 쪽을 여는 길). */
    @Test
    void oneEntryById_serverFirstThenClient() {
        String onlyClient = addClient(3, "only in the browser stream");
        JsonNode c = reader.get(onlyClient);
        assertThat(c.path("stream").asString()).isEqualTo("client");
        assertThat(c.path("message").asString()).isEqualTo("only in the browser stream");
        assertThat(reader.get(onlyClient, LogStream.SERVER)).isNull();
        Instant t = T0.plusSeconds(9);
        String twin = stream.add(t.toEpochMilli(), 0, event(t, "api", "ERROR", "L", "server twin", FP_A, null, null, 0));
        client.add(t.toEpochMilli(), 0, event(t, "web-client", "ERROR", "browser", "client twin", FP_B, null, null, 0));
        assertThat(reader.get(twin).path("message").asString()).isEqualTo("server twin");
        assertThat(reader.get(twin, LogStream.CLIENT).path("message").asString()).isEqualTo("client twin");
        assertThat(reader.get(twin, LogStream.CLIENT).path("stream").asString()).isEqualTo("client");
        // 서버 쪽이 스키마에 맞지 않으면 client 쪽을 본다(없는 것과 같다)
        String badServer = stream.add(T0.plusSeconds(20).toEpochMilli(), 0, "{}");
        client.add(T0.plusSeconds(20).toEpochMilli(), 0, event(T0.plusSeconds(20), "web-client", "ERROR", "browser", "valid twin", FP_B, null, null, 0));
        assertThat(reader.get(badServer).path("stream").asString()).isEqualTo("client");
    }

    // ---------------------------------------------------------------- 해결 표시(계약 v5 §G14)

    /** FP_A 를 T0 + upToS 초까지 해결한 것으로 본다(id 7, "ops"). */
    static LogReader.Resolver resolvedUpTo(long upToS) {
        LogReader.Resolved r = new LogReader.Resolved(7, T0.plusSeconds(upToS), "ops");
        return new LogReader.Resolver() {
            @Override public LogReader.Resolved of(String fp) { return FP_A.equals(fp) ? r : null; }
            @Override public String state() { return "ok"; }
        };
    }

    /**
     * upto 이하(같은 시각 포함)에 난 항목은 기본으로 가리고 그 수를 hidden_resolved 로 센다 — upto 뒤의 발생(재발)은 그대로 보이고 resolved 는 null.
     * resolved=show 면 모두 보이고 해결된 항목에만 resolved {id, upto, resolved_by}. 가린 항목은 쪽 크기(limit)를 쓰지 않고, 다른 필터에 걸린 항목은
     * 가림 수에 들지 않는다.
     */
    @Test
    void resolvedEntriesAreHiddenByDefault_countedAndNewerOccurrencesStayVisible() {
        List<String> a = new ArrayList<>();
        for (int i = 1; i <= 5; i++) a.add(addEvent(i, "api", "WARN", "m" + i, FP_A));
        String b = addEvent(6, "collector", "ERROR", "other", FP_B);
        LogReader.Page hide = reader.list(all(), null, 100, resolvedUpTo(3), true);
        assertThat(ids(hide)).containsExactly(b, a.get(4), a.get(3));
        assertThat(hide.hiddenResolved()).isEqualTo(3);
        assertThat(hide.resolutionState()).isEqualTo("ok");
        assertThat(hide.scanned()).isEqualTo(6);
        for (JsonNode n : hide.items()) assertThat(n.has("resolved") && n.get("resolved").isNull()).as("explicit null").isTrue();

        LogReader.Page show = reader.list(all(), null, 100, resolvedUpTo(3), false);
        assertThat(ids(show)).containsExactly(b, a.get(4), a.get(3), a.get(2), a.get(1), a.get(0));
        assertThat(show.hiddenResolved()).isZero();
        JsonNode resolved = show.items().get(3).get("resolved");
        assertThat(resolved.path("id").asLong()).isEqualTo(7);
        assertThat(resolved.path("upto").asString()).isEqualTo("2026-09-29T00:00:03Z");
        assertThat(resolved.path("resolved_by").asString()).isEqualTo("ops");
        assertThat(show.items().get(2).get("resolved").isNull()).as("after upto: a regression, not resolved").isTrue();

        // 쪽 크기는 보이는 항목만 센다 · 가린 항목도 훑은 수에는 든다
        LogReader.Page p1 = reader.list(all(), null, 2, resolvedUpTo(5), true);
        assertThat(ids(p1)).containsExactly(b);
        assertThat(p1.hiddenResolved()).isEqualTo(5);
        assertThat(p1.nextCursor()).isNull();
        // 다른 필터에 걸린 항목은 가림 수에 들지 않는다
        LogReader.Page errors = reader.list(new LogReader.Filter(Set.of(), Set.of("ERROR"), null, null, null, null, null), null, 100, resolvedUpTo(5), true);
        assertThat(ids(errors)).containsExactly(b);
        assertThat(errors.hiddenResolved()).isZero();
        // 해결을 모르는 호출(이전 서명)은 아무것도 가리지 않는다
        assertThat(reader.list(all(), null, 100).items()).hasSize(6);
        assertThat(reader.list(all(), null, 100).resolutionState()).isNull();
    }

    /**
     * 묶음: 기본(hide)은 해결된 항목을 빼고 센다 — 재발한 묶음은 upto 뒤의 항목만(count · first_at), resolved 는 null. 모두 해결된 묶음은 사라진다.
     * show 면 모두 세고, 묶음의 resolved 는 그 묶음의 모든 항목이 해결됐을 때만(하나라도 upto 뒤면 null — 뒤늦게 실린 항목은 ts 가 스트림 순서와
     * 다를 수 있어 맨 위 항목 하나로 판단하지 않는다).
     */
    @Test
    void groupsLeaveOutResolvedEntries_andAGroupIsResolvedOnlyWhenAllItsEntriesAre() {
        for (int i = 1; i <= 4; i++) addEvent(i, "api", "WARN", "m" + i, FP_A);
        addEvent(5, "collector", "ERROR", "other", FP_B);
        LogReader.Groups hide = reader.groups(all(), resolvedUpTo(2), true);
        assertThat(hide.groups()).extracting(LogReader.Group::fp).containsExactly(FP_B, FP_A);
        LogReader.Group a = hide.groups().get(1);
        assertThat(a.count()).isEqualTo(2);
        assertThat(a.firstAt()).isEqualTo("2026-09-29T00:00:03.000Z");
        assertThat(a.resolved()).isNull();
        assertThat(hide.hiddenResolved()).isEqualTo(2);
        assertThat(hide.resolutionState()).isEqualTo("ok");

        LogReader.Groups gone = reader.groups(all(), resolvedUpTo(4), true);
        assertThat(gone.groups()).extracting(LogReader.Group::fp).containsExactly(FP_B);
        assertThat(gone.hiddenResolved()).isEqualTo(4);

        LogReader.Groups showAll = reader.groups(all(), resolvedUpTo(4), false);
        assertThat(showAll.groups().get(1).count()).isEqualTo(4);
        assertThat(showAll.groups().get(1).resolved()).isEqualTo(new LogReader.Resolved(7, T0.plusSeconds(4), "ops"));
        assertThat(showAll.groups().get(0).resolved()).isNull();
        assertThat(reader.groups(all(), resolvedUpTo(3), false).groups().get(1).resolved()).as("one entry after upto").isNull();

        // 뒤늦게 실린 항목(스트림 맨 위지만 ts 는 더 이르다): 맨 위 항목이 해결 범위 안이어도 묶음 전체는 해결이 아니다
        Instant early = T0.plusSeconds(1);
        stream.add(T0.plusSeconds(9).toEpochMilli(), 0, event(early, "api", "WARN", "dev.wakeline.X", "trailing", FP_A, null, null, 1));
        LogReader.Groups trailing = reader.groups(all(), resolvedUpTo(3), false);
        assertThat(trailing.groups().getFirst().fp()).isEqualTo(FP_A);
        assertThat(trailing.groups().getFirst().resolved()).isNull();
    }

    @Test
    void oneEntryCarriesItsResolution() {
        String old = addEvent(1, "api", "ERROR", "boom", FP_A);
        String fresh = addEvent(5, "api", "ERROR", "boom again", FP_A);
        String other = addClient(6, "browser");
        assertThat(reader.get(old, null, resolvedUpTo(3)).path("resolved").path("id").asLong()).isEqualTo(7);
        assertThat(reader.get(fresh, null, resolvedUpTo(3)).get("resolved").isNull()).isTrue();
        assertThat(reader.get(other, LogStream.CLIENT, resolvedUpTo(30)).get("resolved").isNull()).as("another fp").isTrue();
        assertThat(reader.get(other, LogStream.SERVER, resolvedUpTo(30))).isNull();
        assertThat(reader.get("1-0", null, resolvedUpTo(30))).isNull();
        assertThat(reader.get(old).get("resolved").isNull()).as("without resolutions: explicit null").isTrue();
    }

    // ---------- 해석한 항목 캐시(리뷰 cto-2026-10 P3 · api-review §4 P5) ----------

    /** 폴링이 같은 항목을 다시 훑어도 다시 해석하지 않는다 — 새 항목은 보이고, 해결 표시는 그때의 해결 기록대로(캐시한 노드는 바뀌지 않는다). */
    @Test
    void decodedEntriesAreReusedWhileNewEntriesAndCurrentResolutionsStillShow() {
        Instant t = Instant.parse("2026-10-01T00:00:00Z");
        for (int i = 0; i < 50; i++) stream.add(t.toEpochMilli() + i, 0, event(t.plusMillis(i), "api", "ERROR", "L", "m" + i, "00000000000000aa", null, null, 0));
        for (int i = 0; i < 20; i++) client.add(t.toEpochMilli() + i, 1, event(t.plusMillis(i), "web-client", "ERROR", "browser", "c" + i, "00000000000000bb", null, null, 0));
        var all = new LogReader.Filter(Set.of(), Set.of(), null, null, null, null, null);
        assertThat(reader.groups(all).scanned()).isEqualTo(70);
        assertThat(reader.decodeCount()).isEqualTo(70);
        assertThat(reader.list(all, null, 100).items()).hasSize(70);
        assertThat(reader.groups(all).groups()).hasSize(2);
        assertThat(reader.decodeCount()).as("the same entries are not decoded again").isEqualTo(70);

        // 새 항목: 보이고, 그것만 해석한다
        stream.add(t.toEpochMilli() + 100, 0, event(t.plusMillis(100), "api", "WARN", "L", "fresh", "00000000000000cc", null, null, 0));
        var page = reader.list(all, null, 100);
        assertThat(page.items().getFirst().path("message").asString()).isEqualTo("fresh");
        assertThat(reader.decodeCount()).isEqualTo(71);

        // 해결 표시: 요청마다 그때의 해결 기록 — 가렸다가, 해결이 없어지면 다시 보이고 resolved 는 null(캐시한 노드에 붙지 않았다)
        LogReader.Resolved r = new LogReader.Resolved(7, t.plusSeconds(1), "ops");
        LogReader.Resolver aa = fp -> "00000000000000aa".equals(fp) ? r : null;
        var hidden = reader.list(all, null, 100, aa, true);
        assertThat(hidden.hiddenResolved()).isEqualTo(50);
        assertThat(hidden.items()).hasSize(21);
        var shown = reader.list(all, null, 100, aa, false);
        assertThat(shown.items().stream().filter(n -> n.path("resolved").path("id").asLong() == 7)).hasSize(50);
        var none = reader.list(all, null, 100, LogReader.Resolver.NONE, true);
        assertThat(none.items()).hasSize(71).allSatisfy(n -> assertThat(n.get("resolved").isNull()).isTrue());
        assertThat(shown.items().stream().filter(n -> n.path("resolved").path("id").asLong() == 7))
                .as("a page already returned is not changed by a later request (the cached node is shared)").hasSize(50);
        assertThat(reader.groups(all, aa, false).groups()).filteredOn(g -> "00000000000000aa".equals(g.fp())).singleElement()
                .satisfies(g -> assertThat(g.resolved()).isEqualTo(r));
        assertThat(reader.groups(all, LogReader.Resolver.NONE, false).groups()).allSatisfy(g -> assertThat(g.resolved()).isNull());
        String sid = (t.toEpochMilli() + 10) + "-0";
        assertThat(reader.get(sid, LogStream.SERVER, aa).path("resolved").path("id").asLong()).isEqualTo(7);
        assertThat(reader.get(sid, LogStream.SERVER, LogReader.Resolver.NONE).get("resolved").isNull()).isTrue();
        assertThat(reader.decodeCount()).isEqualTo(71);
    }

    /**
     * 두 스트림이 가득(각 keepMax — 한 번 훑는 상한 4,200)인 채 폴링마다 새 항목 몇 건이 들어오고(트림이 오래된 것을 자른다) 새 항목만 해석한다 — 캐시는
     * 스트림처럼 가장 작은 id 부터 버린다. 가장 오래 쓰지 않은 것부터 버리면 최신 순으로 훑는 다음 폴링이 바로 쓸 항목부터 버려 4,200건을 모두 다시
     * 해석했다(측정에서 찾음).
     */
    @Test
    void fullStreamsWithAFewNewEntriesPerPollDecodeOnlyTheNewOnes() {
        Instant t = Instant.parse("2026-10-01T00:00:00Z");
        int ns = (int) LogStream.SERVER.keepMax(), nc = (int) LogStream.CLIENT.keepMax();
        for (int i = 0; i < ns; i++) stream.add(t.toEpochMilli() + i, 0, event(t.plusMillis(i), "api", "WARN", "L", "m" + i, "00000000000000aa", null, null, 0));
        for (int i = 0; i < nc; i++) client.add(t.toEpochMilli() + i, 1, event(t.plusMillis(i), "web-client", "ERROR", "b", "c" + i, "00000000000000bb", null, null, 0));
        var all = new LogReader.Filter(Set.of(), Set.of(), null, null, null, null, null);
        assertThat(reader.groups(all).scanned()).isEqualTo(LogReader.SCAN_MAX);
        assertThat(reader.decodeCount()).isEqualTo(LogReader.SCAN_MAX);
        int next = ns;
        for (int poll = 0; poll < 3; poll++) {
            long before = reader.decodeCount();
            for (int i = 0; i < 10; i++, next++) stream.add(t.toEpochMilli() + next, 0, event(t.plusMillis(next), "api", "WARN", "L", "m" + next, "00000000000000aa", null, null, 0));
            while (stream.entries.size() > ns) stream.entries.pollFirstEntry(); // XADD … MAXLEN ~ 가 남기는 수(keepMax 이하)로 자른다
            var g = reader.groups(all);
            assertThat(g.scanned()).isEqualTo(LogReader.SCAN_MAX);
            assertThat(reader.decodeCount() - before).as("poll %d decodes only the new entries", poll).isEqualTo(10);
        }
    }

    /** 같은 스트림 · id 에 다른 원문(스트림을 지우고 같은 id 로 다시 실었을 때)은 다시 해석한다. 맞지 않는 항목도 기억해 다시 검증하지 않는다. */
    @Test
    void aDifferentEntryUnderTheSameIdIsDecodedAgain() {
        Instant t = Instant.parse("2026-10-01T00:00:00Z");
        String id = stream.add(t.toEpochMilli(), 0, event(t, "api", "ERROR", "L", "before", "00000000000000aa", null, null, 0));
        stream.add(t.toEpochMilli(), 1, "{\"not\":\"a log event\"}");
        var all = new LogReader.Filter(Set.of(), Set.of(), null, null, null, null, null);
        assertThat(reader.list(all, null, 10).items()).extracting(n -> n.path("message").asString()).containsExactly("before");
        assertThat(reader.list(all, null, 10).invalid()).isEqualTo(1);
        assertThat(reader.decodeCount()).isEqualTo(2);
        stream.entries.put(MemStream.id(id), event(t, "api", "ERROR", "L", "after", "00000000000000aa", null, null, 0));
        assertThat(reader.list(all, null, 10).items()).extracting(n -> n.path("message").asString()).containsExactly("after");
        assertThat(reader.get(id, LogStream.SERVER, LogReader.Resolver.NONE).path("message").asString()).isEqualTo("after");
        assertThat(reader.decodeCount()).isEqualTo(3);
    }

    /** 캐시 상한: 항목 수 · 원문 글자 합을 넘으면 가장 작은 id(스트림이 먼저 자르는 것)부터 버린다. 상한보다 큰 원문은 담지 않는다. */
    @Test
    void theDecodedCacheIsBoundedAndDropsTheSmallestIdsFirst() {
        LogReader.Decoded d = new LogReader.Decoded(3, 100);
        d.put("1-0", "x".repeat(30), null);
        d.put("2-0", "y".repeat(30), null);
        d.put("3-0", "z".repeat(30), null);
        assertThat(d.get("1-0", "x".repeat(30))).isNotNull(); // 최근에 썼어도
        d.put("4-0", "w".repeat(30), null);
        assertThat(d.size()).isEqualTo(3);
        assertThat(d.get("1-0", "x".repeat(30))).as("the smallest id goes first").isNull();
        assertThat(d.get("2-0", "y".repeat(30))).isNotNull();
        d.put("5-0", "v".repeat(60), null); // 글자 합 30 × 3 + 60 > 100 → 2-0, 3-0 이 빠진다
        assertThat(d.chars()).isEqualTo(90);
        assertThat(d.get("3-0", "z".repeat(30))).isNull();
        assertThat(d.get("4-0", "w".repeat(30))).isNotNull();
        assertThat(d.get("5-0", "v".repeat(60))).isNotNull();
        d.put("0-9", "s".repeat(20), null); // 가장 작은 id 가 넘치게 하면 그것이 빠진다
        assertThat(d.get("0-9", "s".repeat(20))).isNull();
        assertThat(d.get("5-0", "v".repeat(60))).isNotNull();
        d.put("6-0", "u".repeat(101), null);
        assertThat(d.get("6-0", "u".repeat(101))).isNull();
        assertThat(d.get("5-0", "v".repeat(59) + "!")).as("same length, other content").isNull();
        assertThat(d.get("not-an-id", "v")).isNull();
        d.put("not-an-id", "v", null);
        assertThat(d.size()).isEqualTo(2);
    }
}
