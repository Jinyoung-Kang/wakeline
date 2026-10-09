package dev.wakeline.airspace;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * 시험용 공역 차수(V18) — 가짜 이름 · 가짜 좌표(동해 먼바다). 수집기의 가져오기와 같은 열 · 같은 정규화 값을 직접 넣는다(실제 AIP 자료는 저장소에 없다 — ADR-034).
 */
public final class AirspaceFixtures {
    private AirspaceFixtures() {}

    /** 사각형 WKT. */
    public static String box(double lon, double lat, double w, double h) {
        return "POLYGON((%s %s,%s %s,%s %s,%s %s,%s %s))".formatted(lon, lat, lon + w, lat, lon + w, lat + h, lon, lat + h, lon, lat);
    }

    public record Row(String category, String typeKo, String ident, String name, Integer lowerFt, String lowerBasis, String lowerRaw,
                      Integer upperFt, String upperBasis, String upperRaw, String kind, String wkt) {}

    /** 판정 · 표시 시험의 기본 공역 여섯(금지 · 원전 · 제한 FL180 · 제한 5,000 ft · 위험(지면 기준) · 항로 선). */
    public static List<Row> defaults() {
        return List.of(
                new Row("prohibited", "비행금지구역", "RK P99", "시험 금지구역 A", 0, "SFC", "Ground", null, "UNL", "Unlimited", "polygon", box(132.0, 36.0, 0.2, 0.2)),
                new Row("nuclear", "원전 임시비행금지구역", "P99A", "시험 원전 가", 0, "SFC", "SFC", 10_000, "FL", "100 FL ALT", "polygon", box(132.5, 37.0, 0.1, 0.1)),
                new Row("restricted", "비행제한구역", "RK R991", "시험 제한구역 B", 0, "SFC", "Surface", 18_000, "FL", "180 Flight Level Altitude", "polygon", box(132.3, 36.0, 0.3, 0.3)),
                new Row("restricted", "비행제한구역", "RK R992", "시험 제한구역 C", 0, "SFC", "Ground", 5_000, "MSL", "5000 Feet Altitude", "polygon", box(132.7, 36.0, 0.2, 0.2)),
                new Row("danger", "위험구역", "RK D999", "시험 위험구역 D", 0, "SFC", "Ground", 2_000, "AGL", "2000 Feet Height", "polygon", box(132.0, 36.5, 0.3, 0.3)),
                new Row("route", "항공로", "Z999", "Z999", 8_000, "MSL", "8000 Feet Altitude", 60_000, "FL", "600 Flight Level Altitude", "line",
                        "LINESTRING(131.0 37.0,132.0 37.5)"));
    }

    /** 차수 하나를 넣는 SQL(켜려면 active). exec 는 superuser 연결 등 — 수집기 계정의 쓰기 권한은 RolePrivilegesDbTest 가 본다. */
    public static void insertEdition(Consumer<String> exec, String sha, String label, boolean active, List<Row> rows) {
        if (active) exec.accept("UPDATE airspace_edition SET active = false WHERE active");
        exec.accept("INSERT INTO airspace_edition (label, document_name, source_sha256, active, counts, skipped) VALUES ('%s', '합성 시험 공역', '%s', %s, '{}', '{}')"
                .formatted(label, sha, active));
        List<String> values = new ArrayList<>();
        for (Row r : rows) {
            values.add("((SELECT id FROM airspace_edition WHERE source_sha256 = '%s'), '%s', '%s', '시험', %s, '%s', '%s', %s, '%s', '%s', %s, '%s', '%s', '%s', ST_GeomFromText('%s', 4326), ST_GeomFromText('%s', 4326))"
                    .formatted(sha, r.category(), r.typeKo(), r.ident() == null ? "NULL" : "'" + r.ident() + "'", r.name(), r.kind(),
                            r.lowerFt(), r.lowerBasis(), r.lowerRaw(), r.upperFt(), r.upperBasis(), r.upperRaw(), r.kind().equals("line") ? "Conventional" : "Other", r.wkt(), r.wkt()));
        }
        exec.accept("INSERT INTO airspace (edition_id, category, type_ko, folder, ident, name, kind, lower_ft, lower_basis, lower_raw, upper_ft, upper_basis, upper_raw, type_code, geom, geom_display) VALUES "
                + String.join(",", values));
    }

    /** 64자 SHA 자리(시험마다 다른 값). */
    public static String sha(char c) { return String.valueOf(c).repeat(64); }
}
