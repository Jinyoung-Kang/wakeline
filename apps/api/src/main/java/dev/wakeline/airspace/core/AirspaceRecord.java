package dev.wakeline.airspace.core;

import org.locationtech.jts.geom.Geometry;
import tools.jackson.databind.JsonNode;

import java.util.Set;

/**
 * 공역 하나(V18 airspace 행 — 국토교통부 공역정보 지도자료, ADR-034). 정규화 규칙은 수집기 airspace.limit 이 정했다: basis 는
 * MSL(해면) · FL(ft = FL×100) · AGL(지면 기준) · SFC(0) · UNL(무제한, ft 없음) · UNKNOWN(기준 모름, ft 없음). raw 는 원문 그대로.
 *
 * @param geometry 판정용 원래 도형(다각형만 — 선은 null)
 * @param display  표시용 GeoJSON geometry(단순화한 것)
 */
public record AirspaceRecord(long id, String category, String typeKo, String folder, String typeCode, String ident, String name,
                             String classCode, String remarks, String kind, Limit lower, Limit upper, Geometry geometry, JsonNode display) {

    public record Limit(Integer ft, String basis, String raw) {
        /** 고도를 비교할 수 있는 기준 — 지면 기준(AGL)은 지형 높이를 몰라 비교하지 않고, 모르는 기준은 짐작하지 않는다. */
        static final Set<String> COMPARABLE = Set.of("MSL", "FL", "SFC", "UNL");

        public boolean comparable() { return COMPARABLE.contains(basis); }
    }

    /** 화면 이름표: 식별자(예: RK P73)가 있으면 그것, 없으면 이름. */
    public String label() { return ident != null && !ident.isBlank() ? ident : name; }
}
