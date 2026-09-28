package dev.wakeline.domain;

import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * UN/LOCODE 항구 표(계약 v4 §B): 합성 TSV 로 읽기 규칙(머리글·형식 오류·중복·항구만)을, 실린 표(resources/data/unlocode-ports.tsv)로
 * 머리 주석(출처·라이선스·내려받은 날·행 수)과 몇 항목을 확인한다.
 */
class UnlocodePortsTest {
    static final String HEADER = "code\tname\tcountry\tsubdivision\tfunction\tname_collision";

    static UnlocodePorts read(String text) throws IOException {
        return UnlocodePorts.read(new BufferedReader(new StringReader(text)));
    }

    /** 테스트용 작은 표. */
    static UnlocodePorts sample() {
        try {
            return read(String.join("\n",
                    "# 합성 표",
                    HEADER,
                    "KRPUS\tBusan\tKR\t26\t1234567-\t0",
                    "CAVAN\tVancouver\tCA\tBC\t1--45---\t1",
                    "NLRTM\tRotterdam\tNL\tZH\t12345---\t0",
                    "DEDUI\tDuisburg\tDE\tNW\t--3--68-\t0",   // 내륙항(8)
                    "SGSIN\tSingapore\tSG\t\t1--45---\t0",
                    "JP8QX\tNumbered\tJP\t\t1-------\t0",   // 코드 셋째 자리 이후 숫자
                    ""));
        } catch (IOException e) {
            throw new AssertionError(e);
        }
    }

    @Test void readsRowsAndLooksUpByCode() {
        UnlocodePorts p = sample();
        assertThat(p.size()).isEqualTo(6);
        assertThat(p.skipped()).isZero();
        assertThat(p.find("KRPUS")).isEqualTo(new UnlocodePorts.Port("KRPUS", "Busan", "KR", "26", false));
        assertThat(p.find("CAVAN").nameCollision()).isTrue();
        assertThat(p.find("SGSIN").subdivision()).as("empty subdivision is unknown").isNull();
        assertThat(p.find("DEDUI").name()).isEqualTo("Duisburg");
        assertThat(p.find("JP8QX").country()).isEqualTo("JP");
        assertThat(p.find("KRINC")).isNull();
        assertThat(p.find(null)).isNull();
        assertThat(p.find("krpus")).as("lookup is on the normalized code only").isNull();
        assertThat(p.find("KRPU")).isNull();
        assertThat(p.find("KR PUS")).isNull();
    }

    @Test void skipsMalformedDuplicateAndNonPortRows() throws IOException {
        UnlocodePorts p = read(String.join("\n",
                HEADER,
                "KRPUS\tBusan\tKR\t26\t1234567-\t0",
                "KRPUS\tPusan duplicate\tKR\t26\t1234567-\t0", // 중복 코드 — 첫 행만
                "krinc\tIncheon\tKR\t28\t123-----\t0",         // 소문자 코드
                "KRINC\tIncheon\tJP\t28\t123-----\t0",         // 나라가 코드와 다름
                "KRULS\t \tKR\t31\t1-------\t0",               // 이름 없음
                "KRKAN\tGwangyang\tKR\t46\t--3-----\t0",        // 항구가 아님
                "KRMAS\tMasan\tKR\t48\t1234----\t2",            // collision 값 오류
                "KRPTK\tPyeongtaek\tKR\t4100\t1-------\t0",     // 행정구역 형식 오류
                "KROKP\tMokpo\tKR\t46\t1-------",               // 열 부족
                "KRUSN\tUlsan\tKR\t31\t12--\t0",                // 기능 형식 오류
                "KRTSN\t" + "x".repeat(121) + "\tKR\t\t1-------\t0")); // 이름이 너무 길다
        assertThat(p.size()).isEqualTo(1);
        assertThat(p.skipped()).isEqualTo(10);
        assertThat(p.find("KRPUS").name()).isEqualTo("Busan");
    }

    @Test void headerIsRequired() {
        assertThatThrownBy(() -> read("# only comments\n")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> read("code\tname\nKRPUS\tBusan\n")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> UnlocodePorts.loadResource("data/missing.tsv")).isInstanceOf(IllegalStateException.class);
    }

    @Test void keyIsBase36AndOrdered() {
        assertThat(UnlocodePorts.key("00000")).isZero();
        assertThat(UnlocodePorts.key("ZZZZZ")).isEqualTo(60_466_175);
        assertThat(UnlocodePorts.key("KRPUS")).isLessThan(UnlocodePorts.key("KRPUT"));
        assertThat(UnlocodePorts.key("JP8QX")).isLessThan(UnlocodePorts.key("JPAAA"));
        assertThat(UnlocodePorts.isPort("1-------")).isTrue();
        assertThat(UnlocodePorts.isPort("-------8")).isTrue();
        assertThat(UnlocodePorts.isPort("-1------")).isFalse();
    }

    /** 실린 표: 머리 주석의 행 수 = 읽은 항목 수, 형식 오류 0, 출처·라이선스·내려받은 날이 적혀 있다. */
    @Test void bundledTableMatchesItsHeader() throws IOException {
        List<String> head = new ArrayList<>();
        try (InputStream in = UnlocodePorts.class.getClassLoader().getResourceAsStream(UnlocodePorts.RESOURCE)) {
            assertThat(in).isNotNull();
            BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String line;
            while ((line = r.readLine()) != null && line.startsWith("#")) head.add(line);
            assertThat(line).isEqualTo(HEADER);
        }
        UnlocodePorts p = UnlocodePorts.bundled();
        assertThat(p.skipped()).isZero();
        assertThat(head).anyMatch(l -> l.equals("# rows: " + p.size()));
        assertThat(head).anyMatch(l -> l.startsWith("# source: https://raw.githubusercontent.com/datasets/un-locode/"));
        assertThat(head).anyMatch(l -> l.equals("# licence: ODC-PDDL-1.0"));
        assertThat(head).anyMatch(l -> l.matches("^# downloaded: \\d{4}-\\d{2}-\\d{2}$"));
        assertThat(p.size()).isGreaterThan(10_000);
        assertThat(p.find("KRPUS").name()).isEqualTo("Busan");
        assertThat(p.find("CAVAN").nameCollision()).as("CA VAN reads as the place name Cavan too").isTrue();
        assertThat(p.find("KRPUS").nameCollision()).isFalse();
        assertThat(UnlocodePorts.bundled()).as("loaded once").isSameAs(p);
    }
}
