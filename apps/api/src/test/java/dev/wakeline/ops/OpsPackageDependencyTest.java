package dev.wakeline.ops;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 패키지 의존 방향(계약 v5 §G13 리뷰): logs → ops 한 방향만 — 로그 조회(LogsController)가 해결 기록(ResolutionService)을 읽고, ops 는 logs 를
 * 모른다. fp 모양처럼 둘이 함께 쓰는 규칙은 ops 쪽({@link Resolution#FP})에 둔다. 이 시험은 ops 소스가 dev.wakeline.logs 를 가져오지 않음을 본다.
 */
class OpsPackageDependencyTest {
    static final Path OPS = Path.of("src/main/java/dev/wakeline/ops");

    @Test
    void opsDoesNotImportTheLogsPackage() throws IOException {
        assertThat(OPS).as("run from apps/api (gradle test working directory)").isDirectory();
        List<String> offenders;
        try (Stream<Path> files = Files.list(OPS)) {
            offenders = files.filter(p -> p.toString().endsWith(".java")).filter(OpsPackageDependencyTest::importsLogs)
                    .map(p -> p.getFileName().toString()).sorted().toList();
        }
        assertThat(offenders).as("ops → logs would close a cycle with logs → ops (LogsController → ResolutionService)").isEmpty();
    }

    private static boolean importsLogs(Path p) {
        try {
            return Files.readAllLines(p, StandardCharsets.UTF_8).stream().map(String::strip)
                    .anyMatch(l -> l.startsWith("import dev.wakeline.logs.") || l.startsWith("import static dev.wakeline.logs."));
        } catch (IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
    }
}
