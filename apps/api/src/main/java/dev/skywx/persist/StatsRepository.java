package dev.skywx.persist;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/** 통계 조회(stats_daily) — 집계는 MaintenanceJobs 가 일 1회 수행한다. */
@Repository
public class StatsRepository {
    private final JdbcClient db;

    public StatsRepository(JdbcClient db) { this.db = db; }

    public List<Map<String, Object>> sigmet(LocalDate from, LocalDate to, String group) {
        return db.sql("SELECT day, dim, value FROM stats_daily WHERE metric = :m AND day BETWEEN :f AND :t ORDER BY day, dim")
                .param("m", "sigmet_by_" + group).param("f", from).param("t", to).query().listOfRows();
    }

    /** dim = 시(00~23). 'hour' 는 SQL 예약어라 별칭을 쓰지 않는다. */
    public List<Map<String, Object>> traffic(LocalDate day) {
        return db.sql("SELECT day, dim, value FROM stats_daily WHERE metric = 'traffic_by_hour' AND day = :d ORDER BY dim")
                .param("d", day).query().listOfRows();
    }

    public List<Map<String, Object>> alerts(LocalDate from, LocalDate to) {
        return db.sql("SELECT day, metric, dim, value FROM stats_daily WHERE metric IN ('alerts_by_kind','alert_dwell_avg_s') AND day BETWEEN :f AND :t ORDER BY day, metric, dim")
                .param("f", from).param("t", to).query().listOfRows();
    }
}
