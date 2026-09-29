package dev.wakeline.portcalls;

import dev.wakeline.route.RouteInfoTest;
import tools.jackson.databind.JsonNode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 입출항 색인 시험 자료(ADR-022 개정). 기준 행은 수집기가 실제 전체 기록(fixtures/portmis_info5_busan_V7A3884.xml)을 해석한 것 —
 * fixtures/portcall_row_V7A3884.json(수집기 시험이 해석 결과와 같은지 본다. 손으로 고치지 않는다). 변형은 그 행의 값만 바꾼 것이다.
 */
public final class PortCallFixtures {
    public static final Path ROW = Path.of("../../fixtures/portcall_row_V7A3884.json").toAbsolutePath().normalize();
    public static final Path AUTHORITIES = Path.of("../../schemas/vectors/port-authorities.v1.json").toAbsolutePath().normalize();

    private PortCallFixtures() {}

    /** 공유 fixture 의 행(열 이름 → 값 — 날짜 · 시각은 ISO 문자열, 모르면 null). */
    public static JsonNode rowJson() {
        try {
            return RouteInfoTest.JSON.readTree(Files.readString(ROW)).get("row");
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 공유 fixture 를 색인 행으로(read_at = fetchedAt). */
    public static PortCallIndex.Row row(Instant fetchedAt) {
        JsonNode r = rowJson();
        return new PortCallIndex.Row(s(r, "prt_ag_cd"), s(r, "prt_ag_nm"), s(r, "clsgn"), LocalDate.parse(s(r, "listed_date")), s(r, "vssl_nm"),
                s(r, "nationality_nm"), s(r, "kind_nm"), s(r, "purpose_nm"), s(r, "first_port_cd"), s(r, "first_port_nm"), s(r, "prev_port_cd"),
                s(r, "prev_port_nm"), s(r, "next_port_cd"), s(r, "next_port_nm"), s(r, "dest_port_cd"), s(r, "dest_port_nm"), t(r, "entry_at"),
                s(r, "entry_revision"), t(r, "exit_at"), s(r, "exit_revision"), s(r, "berth"), fetchedAt);
    }

    /** 10곳 모두 [from, to] 를 덮고 refreshed 에 꼬리 갱신을 끝낸 범위. */
    public static List<PortCallIndex.Coverage> fullCoverage(LocalDate from, LocalDate to, Instant refreshed) {
        List<PortCallIndex.Coverage> out = new ArrayList<>();
        for (Map.Entry<String, String> pa : PortCallReader.PORT_AUTHORITIES) out.add(new PortCallIndex.Coverage(pa.getKey(), from, to, refreshed));
        return out;
    }

    private static String s(JsonNode r, String k) { return r.path(k).isString() ? r.path(k).asString() : null; }

    private static Instant t(JsonNode r, String k) { return r.path(k).isString() ? Instant.parse(r.path(k).asString()) : null; }

    /** 가짜 색인: 범위 · 행(호출부호 → 행들) · 호출 수 · 실패 스위치. */
    public static final class FakeSource implements PortCallReader.Source {
        public volatile List<PortCallIndex.Coverage> coverage = List.of();
        public final Map<String, List<PortCallIndex.Row>> rows = new java.util.concurrent.ConcurrentHashMap<>();
        public final List<String> queries = new CopyOnWriteArrayList<>();
        public final AtomicInteger coverageReads = new AtomicInteger();
        public volatile RuntimeException fail;
        /** 있으면 byCallSign 이 풀릴 때까지 기다린다(느린 DB · 풀 소진 흉내). */
        public volatile java.util.concurrent.CountDownLatch hold;

        @Override public List<PortCallIndex.Coverage> coverage() {
            coverageReads.incrementAndGet();
            if (fail != null) throw fail;
            return coverage;
        }

        @Override public List<PortCallIndex.Row> byCallSign(String callSign, LocalDate from, LocalDate to, int limit) {
            queries.add(callSign + " " + from + ".." + to + " limit " + limit);
            java.util.concurrent.CountDownLatch h = hold;
            if (h != null) {
                try {
                    if (!h.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new IllegalStateException("not released");
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                }
            }
            if (fail != null) throw fail;
            List<PortCallIndex.Row> all = rows.getOrDefault(callSign, List.of());
            return all.subList(0, Math.min(all.size(), limit));
        }
    }
}
