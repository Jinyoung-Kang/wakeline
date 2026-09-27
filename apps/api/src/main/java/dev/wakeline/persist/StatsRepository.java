package dev.wakeline.persist;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 통계 조회(stats_daily) — 집계는 MaintenanceJobs 가 일 1회(+ 따라잡기) 수행한다. */
@Repository
public class StatsRepository {
    private final JdbcClient db;

    public StatsRepository(JdbcClient db) { this.db = db; }

    public List<Map<String, Object>> sigmet(LocalDate from, LocalDate to, String group) {
        return db.sql("SELECT day, dim, value FROM stats_daily WHERE metric = :m AND day BETWEEN :f AND :t ORDER BY day, dim")
                .param("m", "sigmet_by_" + group).param("f", from).param("t", to).query().listOfRows();
    }

    /**
     * 시간대별 트래픽. items: dim = 시(00~23) — 'hour' 는 SQL 예약어라 별칭을 쓰지 않는다. 자료가 없는 시간은 행이 없다.
     * region: 그날 집계가 센 관심 지역({center:[lat,lon], radius_nm, bbox:[lomin,lamin,lomax,lamax]}). bbox 는 집계가 실제로 쓴 사각형 —
     * 저장된 중심·반경에서 집계와 같은 식(RegionSettings.Region.bbox)으로 결정적으로 다시 만든다(DH-10: 화면이 '관심 지역' 이라고만 쓰지 않고
     * 센 범위를 밝힐 수 있게). 지역 기록이 없는 날(이 기능 전 집계 — 전세계 표본이 섞였을 수 있음)은 null.
     */
    public record Traffic(List<Map<String, Object>> items, Map<String, Object> region) {}

    public Traffic traffic(LocalDate day) {
        var items = db.sql("SELECT day, dim, value FROM stats_daily WHERE metric = 'traffic_by_hour' AND day = :d ORDER BY dim")
                .param("d", day).query().listOfRows();
        Map<String, Number> reg = new LinkedHashMap<>();
        for (var r : db.sql("SELECT dim, value FROM stats_daily WHERE metric = 'traffic_region' AND day = :d").param("d", day).query().listOfRows())
            reg.put(String.valueOf(r.get("dim")), (Number) r.get("value"));
        Map<String, Object> region = null;
        if (reg.containsKey("center_lat") && reg.containsKey("center_lon") && reg.containsKey("radius_nm")) {
            region = new LinkedHashMap<>();
            var r = new dev.wakeline.ops.RegionSettings.Region(reg.get("center_lat").doubleValue(), reg.get("center_lon").doubleValue(),
                    reg.get("radius_nm").intValue());
            var b = r.bbox();
            region.put("center", r.center());
            region.put("radius_nm", r.radiusNm());
            region.put("bbox", List.of(b.lomin(), b.lamin(), b.lomax(), b.lamax()));
        }
        return new Traffic(items, region);
    }

    public List<Map<String, Object>> alerts(LocalDate from, LocalDate to) {
        return db.sql("SELECT day, metric, dim, value FROM stats_daily WHERE metric IN ('alerts_by_kind','alert_dwell_avg_s') AND day BETWEEN :f AND :t ORDER BY day, metric, dim")
                .param("f", from).param("t", to).query().listOfRows();
    }
}
