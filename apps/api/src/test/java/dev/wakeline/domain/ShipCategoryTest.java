package dev.wakeline.domain;

import dev.wakeline.DbTestSupport;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 선종 분류 표(계약 v2 §B3, USCG AIS Guide) — api 의 한 곳(ShipCategory). web(lib/ships.ts)과 같은 표 파일
 * (apps/web/tests/fixtures/ship-category-uscg.json)로 두 쪽이 따로 단위 시험한다: 한쪽만 고치면 그쪽 시험이 깨진다.
 */
class ShipCategoryTest {

    @Test void contractTable() {
        assertThat(ShipCategory.of(30)).isEqualTo(ShipCategory.FISHING);
        for (int c : new int[]{31, 32, 52}) assertThat(ShipCategory.of(c)).as("code " + c).isEqualTo(ShipCategory.TUG);
        for (int c : new int[]{36, 37}) assertThat(ShipCategory.of(c)).isEqualTo(ShipCategory.PLEASURE);
        for (int c = 40; c <= 49; c++) assertThat(ShipCategory.of(c)).isEqualTo(ShipCategory.HSC);
        for (int c : new int[]{50, 51, 53, 54, 55, 58}) assertThat(ShipCategory.of(c)).isEqualTo(ShipCategory.SPECIAL);
        assertThat(ShipCategory.of(35)).isEqualTo(ShipCategory.MILITARY);
        for (int c = 60; c <= 69; c++) assertThat(ShipCategory.of(c)).isEqualTo(ShipCategory.PASSENGER);
        for (int c = 70; c <= 79; c++) assertThat(ShipCategory.of(c)).isEqualTo(ShipCategory.CARGO);
        for (int c = 80; c <= 89; c++) assertThat(ShipCategory.of(c)).isEqualTo(ShipCategory.TANKER);
        // 없음·기본값·형식 오류 → 미상(색을 지어내지 않는다)
        assertThat(ShipCategory.of(null)).isEqualTo(ShipCategory.UNKNOWN);
        assertThat(ShipCategory.of(0)).isEqualTo(ShipCategory.UNKNOWN);
        assertThat(ShipCategory.of(-1)).isEqualTo(ShipCategory.UNKNOWN);
        // 표에 없는 코드 → 기타
        for (int c : new int[]{1, 20, 29, 33, 34, 38, 39, 56, 57, 59, 90, 99, 100, 255})
            assertThat(ShipCategory.of(c)).as("code " + c).isEqualTo(ShipCategory.OTHER);
    }

    @Test void keysAndOrderMatchTheWebList() {
        // web lib/ships.ts SHIP_CATEGORIES 와 같은 이름·순서(격자 대표 분류의 동률 규칙이 같도록)
        assertThat(java.util.Arrays.stream(ShipCategory.values()).map(ShipCategory::key).toList())
                .containsExactly("cargo", "tanker", "passenger", "fishing", "tug", "pleasure", "hsc", "special", "military", "other", "unknown");
        assertThat(ShipCategory.count()).isEqualTo(11);
        assertThat(ShipCategory.at(0)).isEqualTo(ShipCategory.CARGO);
    }

    /**
     * 계약 v5 §B2: 격자 칸의 선종별 수 배열([n0..n10])은 이 순서를 따른다 — 순서의 원본은 저장소의 schemas/vectors/ship-categories.v1.json 하나
     * (web SHIP_CATEGORIES 도 같은 파일로 시험한다). 열거 선언 순서가 바뀌면 여기서 깨진다.
     */
    @Test void declarationOrderMatchesTheSharedVector() throws Exception {
        Path f = DbTestSupport.repoFile("schemas/vectors/ship-categories.v1.json");
        JsonNode v = JsonMapper.builder().build().readTree(Files.readString(f));
        assertThat(v.path("version").asInt()).isEqualTo(1);
        List<String> order = new java.util.ArrayList<>();
        for (JsonNode k : v.path("order")) order.add(k.asString());
        assertThat(java.util.Arrays.stream(ShipCategory.values()).map(ShipCategory::key).toList()).isEqualTo(order);
        for (int i = 0; i < order.size(); i++) assertThat(ShipCategory.at(i).key()).isEqualTo(order.get(i));
    }

    /** 공유 표 파일: 목록에 있는 코드는 그 분류, 1–255 의 나머지는 default, null 은 null_category. */
    @Test void sharedFixtureTable() throws Exception {
        Path f = DbTestSupport.repoFile("apps/web/tests/fixtures/ship-category-uscg.json");
        JsonNode t = JsonMapper.builder().build().readTree(Files.readString(f));
        Map<Integer, String> listed = new HashMap<>();
        for (Map.Entry<String, JsonNode> e : t.path("categories").properties()) {
            for (JsonNode c : e.getValue()) listed.put(c.asInt(), e.getKey());
        }
        assertThat(listed).isNotEmpty();
        String def = t.path("default").asString();
        for (int c = 0; c <= 255; c++) {
            String expected = listed.getOrDefault(c, def);
            assertThat(ShipCategory.of(c).key()).as("code " + c).isEqualTo(expected);
        }
        assertThat(ShipCategory.of(null).key()).isEqualTo(t.path("null_category").asString());
        assertThat(List.of(ShipCategory.values()).stream().map(ShipCategory::key).toList()).containsAll(listed.values());
    }
}
