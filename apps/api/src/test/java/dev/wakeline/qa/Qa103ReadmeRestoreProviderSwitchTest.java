package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-103 재현(문서): README '백업·복원' 은 "운영 화면의 공급자 켜기/끄기는 Redis 에만 있어 다시 설정해야 합니다" 라고 하지만, 공급자 스위치의 원본은
 * V11 부터 DB provider_switch 다(ProviderSwitchService · R-94 — 기동 · 60 s 마다 DB → Redis 미러). 스택 B 에서 opensky 를 끈 채 백업 → 새 볼륨에
 * 복원 → Redis 필드를 지운 뒤 기동하자 스위치가 DB 에서 그대로 돌아오고 Redis 에도 다시 미러됐다(evidence/reliability/backup-restore).
 * 운영자가 복원 뒤 '다시 설정' 하라는 안내를 따르면 할 필요 없는 일을 하고, 거꾸로 "백업에 없다" 고 믿게 된다.
 */
class Qa103ReadmeRestoreProviderSwitchTest {
    @Test
    void readmeBackupSectionDoesNotSayProviderSwitchesLiveOnlyInRedis() throws Exception {
        String readme = Files.readString(DbTestSupport.repoFile("README.md"));
        assertThat(Files.isRegularFile(DbTestSupport.repoFile("apps/api/src/main/resources/db/migration/V11__provider_switch.sql")))
                .as("공급자 스위치 원본 표(V11)").isTrue();
        int start = readme.indexOf("### 백업·복원");
        int end = readme.indexOf("\n### ", start + 1);
        String section = readme.substring(start, end < 0 ? readme.length() : end);
        assertThat(section).as("README '백업·복원' — 공급자 스위치는 DB(provider_switch)에 있어 백업 · 복원된다")
                .doesNotContain("공급자 켜기/끄기는 Redis 에만 있어");
    }
}
