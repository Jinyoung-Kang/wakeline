package dev.wakeline.persist;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 통계 조회(stats_daily) — 집계는 MaintenanceJobs 가 일 1회(+ 따라잡기) 수행한다.
 * day 는 KST 날짜(계약 v5 §G19 — {@link MaintenanceJobs#DAY_ZONE}) 문자열 "YYYY-MM-DD" 로 낸다(R-45 — DB 가 만든다: JVM 기본 시간대의 자정 시각으로
 * 바뀌지 않는다). V16 전의 UTC 날짜 행은 보관 표(stats_daily_utc_legacy)에 있고 여기서 읽지 않는다 — 다른 하루를 KST 날짜로 내지 않는다.
 * 집계를 마쳤는지는 계열별 완료 표식(MaintenanceJobs.MARKER)으로 밝힌다 — 행이 없는 날이 '자료 없음' 인지 '집계 전' 인지 구분한다.
 */
@Repository
public class StatsRepository {
    private final JdbcClient db;

    public StatsRepository(JdbcClient db) { this.db = db; }

    public List<Map<String, Object>> sigmet(LocalDate from, LocalDate to, String group) {
        return Sql.publicRead(db, "SELECT to_char(day, 'YYYY-MM-DD') AS day, dim, value FROM stats_daily WHERE metric = :m AND day BETWEEN :f AND :t ORDER BY 1, dim")
                .param("m", "sigmet_by_" + group).param("f", from).param("t", to).query().listOfRows();
    }

    /**
     * 시간대별 트래픽. items: dim = KST 시(00~23 — 그 KST 날짜의 시) — 'hour' 는 SQL 예약어라 별칭을 쓰지 않는다. 자료가 없는 시간은 행이 없다.
     * region: 그날 집계가 센 관심 지역({center:[lat,lon], radius_nm, bbox:[lomin,lamin,lomax,lamax]}). bbox 는 집계가 실제로 쓴 사각형 —
     * 저장된 중심·반경에서 집계와 같은 식(RegionSettings.Region.bbox)으로 결정적으로 다시 만든다(DH-10: 화면이 '관심 지역' 이라고만 쓰지 않고
     * 센 범위를 밝힐 수 있게). 지역 기록이 없는 날(이 기능 전 집계 — 전세계 표본이 섞였을 수 있음)은 null.
     * aggregated: 그날의 교통량 집계를 마쳤는가(완료 표식) — false 면 빈 items 는 '0 대' 가 아니라 '아직 모름'.
     */
    public record Traffic(List<Map<String, Object>> items, Map<String, Object> region, boolean aggregated) {}

    public Traffic traffic(LocalDate day) {
        var items = Sql.publicRead(db, "SELECT to_char(day, 'YYYY-MM-DD') AS day, dim, value FROM stats_daily WHERE metric = 'traffic_by_hour' AND day = :d ORDER BY dim")
                .param("d", day).query().listOfRows();
        Map<String, Number> reg = new LinkedHashMap<>();
        for (var r : Sql.publicRead(db, "SELECT dim, value FROM stats_daily WHERE metric = 'traffic_region' AND day = :d").param("d", day).query().listOfRows())
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
        boolean aggregated = Boolean.TRUE.equals(Sql.publicRead(db, "SELECT EXISTS (SELECT 1 FROM stats_daily WHERE day = :d AND metric = :m AND dim = :f)")
                .param("d", day).param("m", MaintenanceJobs.MARKER).param("f", MaintenanceJobs.FAMILY_TRAFFIC).query(Boolean.class).single());
        return new Traffic(items, region, aggregated);
    }

    public List<Map<String, Object>> alerts(LocalDate from, LocalDate to) {
        return Sql.publicRead(db, "SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, dim, value FROM stats_daily WHERE metric IN ('alerts_by_kind','alert_dwell_avg_s') AND day BETWEEN :f AND :t ORDER BY 1, metric, dim")
                .param("f", from).param("t", to).query().listOfRows();
    }

    /**
     * [from, to] 의 날마다 {day: "YYYY-MM-DD", aggregated: 그 계열의 집계를 마쳤는가}(날짜순). 행이 없는 날이 '자료 없음'(aggregated = true)인지
     * '집계 전'(false — 오늘, 아직 돌지 않은 날, 원본이 사라지기 전에 집계하지 못한 날)인지 구분한다(R-45).
     */
    public List<Map<String, Object>> days(LocalDate from, LocalDate to, String family) {
        return Sql.publicRead(db, """
                SELECT to_char(d, 'YYYY-MM-DD') AS day,
                       EXISTS (SELECT 1 FROM stats_daily s WHERE s.day = d::date AND s.metric = :m AND s.dim = :f) AS aggregated
                FROM generate_series(:from::date, :to::date, interval '1 day') d ORDER BY d""")
                .param("from", from).param("to", to).param("m", MaintenanceJobs.MARKER).param("f", family).query().listOfRows();
    }
}
