package dev.wakeline.logs;

import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.utility.DockerImageName;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 측정(리뷰 cto-2026-10 P3 · api-review §4 P5 — docs/PERF.md §13): 운영 로그 화면의 폴링(15 s — web useLogFeed)마다 LogReader 가 두 스트림을
 * 처음부터 다시 훑는 비용. 묶음 보기(groups)는 늘 끝까지(두 스트림 합 4,200건), 목록은 필터에 맞는 항목이 쪽(100)을 채우지 못하면 끝까지 훑는다.
 * 항목은 리뷰와 같은 모양: 서버 3,100건(세 건에 하나는 150줄 스택) · 브라우저 오류 1,100건.
 * <ul>
 *   <li>메모리 스트림(LogReaderTest.MemStream) — 해석(스키마 검증 · 파싱 · 가림) 비용만.</li>
 *   <li>실제 Redis(redis:8-alpine, Testcontainers) + 운영 생성자(StringRedisTemplate — XREVRANGE 200건씩 · TIME) — 운영 요청 하나의 값.</li>
 * </ul>
 * 실행: {@code ./gradlew --offline perfTest --tests 'dev.wakeline.logs.LogReaderScanPerfTest'} — 가운데 값(데우기 5번 뒤 11번).
 * 결과는 표준 출력과 build/perf/log-reader.txt.
 */
@Tag("perf")
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class LogReaderScanPerfTest {
    static final int SERVER = 3_100, CLIENT = 1_100, RUNS = 11;
    static final String STACK = "java.io.IOException: io\n" + "\tat dev.wakeline.x.Y.z(Y.java:1)\n".repeat(150);
    static final LogReader.Filter NOTHING = new LogReader.Filter(Set.of(), Set.of(), null, null, "zzzzzzzzzzzz", null, null); // 맞는 것 없음 → 끝까지
    static final LogReader.Filter ALL = new LogReader.Filter(Set.of(), Set.of(), null, null, null, null, null);

    static String server(long base, int i) {
        return LogReaderTest.event(Instant.ofEpochMilli(base + i), "api", "ERROR", "dev.wakeline.ingest.StreamConsumer", "apply failed " + i,
                String.format("%016x", i % 40), null, i % 3 == 0 ? STACK : null, 0);
    }

    static String client(long base, int i) {
        return LogReaderTest.event(Instant.ofEpochMilli(base + i), "web-client", "ERROR", "browser", "TypeError " + i, String.format("%016x", 100 + i % 10),
                null, null, 0);
    }

    @Test
    void measure() throws Exception {
        List<String> out = new ArrayList<>();
        long base = Instant.now().minusSeconds(3_600).toEpochMilli();
        LogReaderTest.MemStream server = new LogReaderTest.MemStream(), client = new LogReaderTest.MemStream();
        long bytes = 0;
        for (int i = 0; i < SERVER; i++) {
            String e = server(base, i);
            server.add(base + i, 0, e);
            bytes += e.length();
        }
        for (int i = 0; i < CLIENT; i++) {
            String e = client(base, i);
            client.add(base + i, 1, e);
            bytes += e.length();
        }
        out.add(String.format("entries %,d server + %,d client · %,d chars of JSON", SERVER, CLIENT, bytes));
        rows(out, "memory", new LogReader(server, client));

        try (GenericContainer<?> redis = new GenericContainer<>(DockerImageName.parse("redis:8-alpine")).withExposedPorts(6379)) {
            redis.start();
            LettuceConnectionFactory f = new LettuceConnectionFactory(new RedisStandaloneConfiguration(redis.getHost(), redis.getMappedPort(6379)));
            f.afterPropertiesSet();
            f.start();
            try {
                StringRedisTemplate t = new StringRedisTemplate(f);
                for (int i = 0; i < SERVER; i++) t.opsForStream().add(LogStream.SERVER.key(), Map.of("e", server(base, i)));
                for (int i = 0; i < CLIENT; i++) t.opsForStream().add(LogStream.CLIENT.key(), Map.of("e", client(base, i)));
                rows(out, "redis", new LogReader(t));
                LogReader.Source s = LogReader.redisSource(t, LogStream.SERVER), c = LogReader.redisSource(t, LogStream.CLIENT);
                out.add(row("redis", "XREVRANGE only (both streams, 200 per call)", median(() -> readAll(s) + readAll(c))));
            } finally {
                f.destroy();
            }
        }
        out.forEach(System.out::println);
        Path p = Path.of("build/perf/log-reader.txt");
        Files.createDirectories(p.getParent());
        Files.write(p, out);
    }

    static void rows(List<String> out, String where, LogReader r) {
        LogReader.Resolver none = LogReader.Resolver.NONE;
        assertThat(r.list(NOTHING, null, 100).scanned()).isEqualTo(SERVER + CLIENT);
        assertThat(r.groups(ALL).scanned()).isEqualTo(SERVER + CLIENT);
        out.add(row(where, "list first page, no filter (100 of 4,200)", median(() -> r.list(ALL, null, 100, none, true).items().size())));
        out.add(row(where, "list, filter matching nothing (full scan)", median(() -> r.list(NOTHING, null, 100, none, true).scanned())));
        out.add(row(where, "groups (full scan)", median(() -> r.groups(ALL, none, true).groups().size())));
    }

    static int readAll(LogReader.Source s) {
        int n = 0;
        String upper = null;
        while (true) {
            List<LogReader.Raw> chunk = s.reverse(upper, null, LogReader.CHUNK);
            n += chunk.size();
            if (chunk.size() < LogReader.CHUNK) return n;
            upper = LogReader.previousId(chunk.getLast().id());
        }
    }

    static String row(String where, String what, double ms) { return String.format("%-6s | %-46s | %7.1f ms", where, what, ms); }

    static double median(Supplier<Object> w) {
        for (int i = 0; i < 5; i++) w.get();
        double[] t = new double[RUNS];
        for (int i = 0; i < RUNS; i++) {
            long t0 = System.nanoTime();
            w.get();
            t[i] = (System.nanoTime() - t0) / 1e6;
        }
        Arrays.sort(t);
        return t[RUNS / 2];
    }
}
