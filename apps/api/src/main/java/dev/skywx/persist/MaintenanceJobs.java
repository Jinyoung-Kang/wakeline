package dev.skywx.persist;

import dev.skywx.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneOffset;

/**
 * 파티션 생성·삭제(매일 03:00 UTC), 1분 요약(매시, 관심 지역만 · 30일), 통계 집계(03:30). 기동 시 파티션 보장.
 * 보존 정책 ADR-007: 원해상도 72 h, 1분 요약 30일, 알림·SIGMET·통계 영구.
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class MaintenanceJobs {
    private static final Logger log = LoggerFactory.getLogger(MaintenanceJobs.class);
    private final JdbcClient db;
    private final AppProperties props;

    public MaintenanceJobs(JdbcClient db, AppProperties props) {
        this.db = db;
        this.props = props;
    }

    @Scheduled(initialDelay = 5_000, fixedDelay = 6 * 3600_000)
    public void ensurePartitions() {
        try {
            Integer n = db.sql("SELECT track_point_ensure_partitions(3)").query(Integer.class).single();
            if (n > 0) log.info("created {} track_point partitions", n);
        } catch (RuntimeException e) {
            log.warn("ensure partitions failed: {}", e.toString());
        }
    }

    @Scheduled(cron = "0 0 3 * * *", zone = "UTC")
    public void dropOldPartitions() {
        try {
            Integer n = db.sql("SELECT track_point_drop_old(:h)").param("h", props.trackRetentionHours()).query(Integer.class).single();
            log.info("dropped {} old track_point partitions (retention {} h)", n, props.trackRetentionHours());
            int m = db.sql("DELETE FROM track_point_1m WHERE ts_minute < now() - make_interval(days => :d)").param("d", props.summaryRetentionDays()).update();
            log.info("deleted {} track_point_1m rows older than {} d", m, props.summaryRetentionDays());
            db.sql("DELETE FROM metar_obs WHERE obs_time < now() - interval '30 days'").update();
            db.sql("DELETE FROM radar_frame WHERE frame_time < now() - interval '7 days'").update();
            db.sql("DELETE FROM ingest_run WHERE started_at < now() - interval '30 days'").update();
        } catch (RuntimeException e) {
            log.warn("retention job failed: {}", e.toString());
        }
    }

    /** 지난 1시간의 원해상도 항적을 관심 지역 bbox 안에서 1분 단위로 요약한다. (hex, ts_minute) 충돌은 무시. */
    @Scheduled(cron = "0 5 * * * *", zone = "UTC")
    public void summarize1m() {
        try {
            double dlat = props.regionRadiusNm() / 60.0, dlon = props.regionRadiusNm() / (60.0 * Math.cos(Math.toRadians(props.regionLat())));
            int n = db.sql("""
                    INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n)
                    SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(geom))), 4326), avg(alt_ft)::int, avg(gs_kt), count(*)
                    FROM track_point
                    WHERE ts >= date_trunc('hour', now()) - interval '1 hour' AND ts < date_trunc('hour', now())
                      AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                    GROUP BY hex, m
                    ON CONFLICT (hex, ts_minute) DO NOTHING""")
                    .param("lomin", props.regionLon() - dlon).param("lamin", props.regionLat() - dlat)
                    .param("lomax", props.regionLon() + dlon).param("lamax", props.regionLat() + dlat).update();
            log.info("1-minute summary: {} rows", n);
        } catch (RuntimeException e) {
            log.warn("summary job failed: {}", e.toString());
        }
    }

    @Scheduled(cron = "0 30 3 * * *", zone = "UTC")
    public void aggregateDaily() { aggregate(LocalDate.now(ZoneOffset.UTC).minusDays(1)); }

    /** 하루치 통계: FIR별·hazard별 SIGMET 수, 시간대별 관심 지역 트래픽, 알림 건수·평균 체류. 재실행해도 같은 값(upsert). */
    public void aggregate(LocalDate day) {
        try {
            db.sql("DELETE FROM stats_daily WHERE day = :d").param("d", day).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'sigmet_by_fir', fir_id, count(*) FROM sigmet WHERE valid_from::date <= :d AND valid_to::date >= :d GROUP BY fir_id""").param("d", day).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'sigmet_by_hazard', hazard, count(*) FROM sigmet WHERE valid_from::date <= :d AND valid_to::date >= :d GROUP BY hazard""").param("d", day).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'traffic_by_hour', lpad(extract(hour FROM ts)::text, 2, '0'), count(DISTINCT hex)
                    FROM track_point WHERE ts >= :d::timestamptz AND ts < (:d::date + 1)::timestamptz GROUP BY 3""").param("d", day).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'alerts_by_kind', kind, count(*) FROM alert_event WHERE entered_at::date = :d GROUP BY kind""").param("d", day).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'alert_dwell_avg_s', 'OBSERVED', coalesce(avg(extract(epoch FROM (left_at - entered_at))), 0)
                    FROM alert_event WHERE kind = 'OBSERVED' AND left_at IS NOT NULL AND entered_at::date = :d""").param("d", day).update();
            log.info("daily stats aggregated for {}", day);
        } catch (RuntimeException e) {
            log.warn("stats aggregation failed: {}", e.toString());
        }
    }
}
