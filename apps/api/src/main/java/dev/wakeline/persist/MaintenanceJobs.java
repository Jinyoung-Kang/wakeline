package dev.wakeline.persist;

import dev.wakeline.config.AppProperties;
import dev.wakeline.domain.Bbox;
import dev.wakeline.ops.RegionSettings;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

/**
 * 파티션 생성·삭제·보존 삭제(매일 03:00 UTC), 1분 요약(매시 :05, 관심 지역만 · 30일), 통계 집계(03:30). 기동 시 파티션 보장.
 * 보존 정책 ADR-007: 원해상도 72 h, 1분 요약 30일, 알림·SIGMET·통계 영구.
 * 관심 지역은 런타임 설정(collector 와 같은 값, {@link RegionSettings})에서 읽는다(COR-12).
 * 따라잡기(REL-18): cron 은 놓친 시각을 다시 돌리지 않는다 — 기동 1분 뒤와 그 뒤 3시간마다 최근 24시간 중 요약이 없는 시간과
 * 최근 7일 중 통계가 없는 날을 채운다(둘 다 멱등).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class MaintenanceJobs {
    private static final Logger log = LoggerFactory.getLogger(MaintenanceJobs.class);
    static final int CATCH_UP_HOURS = 24;
    static final int CATCH_UP_DAYS = 7;
    private final JdbcClient db;
    private final AppProperties props;
    private final RegionSettings region;
    private final TransactionTemplate tx;

    public MaintenanceJobs(JdbcClient db, AppProperties props, RegionSettings region, TransactionTemplate tx) {
        this.db = db;
        this.props = props;
        this.region = region;
        this.tx = tx;
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

    /** 보존 삭제. 문장마다 따로 시도한다 — 하나가 실패해도(권한·잠금) 나머지는 돈다(REL-11). */
    @Scheduled(cron = "0 0 3 * * *", zone = "UTC")
    public void dropOldPartitions() {
        retention("track_point partitions", () -> db.sql("SELECT track_point_drop_old(:h)").param("h", props.trackRetentionHours()).query(Integer.class).single());
        retention("track_point_1m", () -> db.sql("DELETE FROM track_point_1m WHERE ts_minute < now() - make_interval(days => :d)").param("d", props.summaryRetentionDays()).update());
        retention("metar_obs", () -> db.sql("DELETE FROM metar_obs WHERE obs_time < now() - interval '30 days'").update());
        retention("radar_frame", () -> db.sql("DELETE FROM radar_frame WHERE frame_time < now() - interval '7 days'").update());
        retention("quality_event", () -> db.sql("DELETE FROM quality_event WHERE created_at < now() - interval '30 days'").update());
        retention("ingest_run", () -> db.sql("DELETE FROM ingest_run WHERE started_at < now() - interval '30 days'").update());
        retention("quality_rule_count", () -> db.sql("DELETE FROM quality_rule_count WHERE day < CURRENT_DATE - 90").update());
    }

    private void retention(String what, java.util.function.Supplier<Integer> op) {
        try {
            Integer n = op.get();
            log.info("retention {}: {} removed", what, n);
        } catch (RuntimeException e) {
            log.warn("retention {} failed: {}", what, e.toString());
        }
    }

    /** 지난 1시간(닫힌 시간)의 원해상도 항적을 관심 지역 bbox 안에서 1분 단위로 요약한다. */
    @Scheduled(cron = "0 5 * * * *", zone = "UTC")
    public void summarize1m() {
        Instant hour = Instant.now().truncatedTo(ChronoUnit.HOURS).minus(1, ChronoUnit.HOURS);
        try {
            int n = summarizeHour(hour);
            log.info("1-minute summary {}: {} rows", hour, n);
        } catch (RuntimeException e) {
            log.warn("summary job failed: {}", e.toString());
        }
    }

    /** [hourStart, hourStart+1h) 를 1분 요약한다. (hex, ts_minute) 충돌은 무시 — 다시 돌려도 같다. */
    int summarizeHour(Instant hourStart) {
        Bbox b = region.current().bbox();
        return db.sql("""
                INSERT INTO track_point_1m (hex, ts_minute, geom, alt_ft, gs_kt, n)
                SELECT hex, date_trunc('minute', ts) m, ST_SetSRID(ST_MakePoint(avg(ST_X(geom)), avg(ST_Y(geom))), 4326), avg(alt_ft)::int, avg(gs_kt), count(*)
                FROM track_point
                WHERE ts >= :from AND ts < :to
                  AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                GROUP BY hex, m
                ON CONFLICT (hex, ts_minute) DO NOTHING""")
                .param("from", Sql.ts(hourStart)).param("to", Sql.ts(hourStart.plus(1, ChronoUnit.HOURS)))
                .param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax()).update();
    }

    /** 기동 1분 뒤, 그 뒤 3시간마다: 놓친 1분 요약·일 통계를 채운다(REL-18). */
    @Scheduled(initialDelay = 60_000, fixedDelay = 3 * 3600_000)
    public void catchUp() {
        try {
            List<Instant> hours = catchUpSummaries(Instant.now());
            List<LocalDate> days = catchUpStats(LocalDate.now(ZoneOffset.UTC));
            if (!hours.isEmpty() || !days.isEmpty()) log.info("catch-up: summarized hours {}, aggregated days {}", hours, days);
        } catch (RuntimeException e) {
            log.warn("catch-up failed (will retry): {}", e.toString());
        }
    }

    /** 최근 24개의 닫힌 시간 중 원해상도 항적은 있는데 1분 요약이 하나도 없는 시간을 요약한다. @return 요약한 시간 */
    List<Instant> catchUpSummaries(Instant now) {
        Bbox b = region.current().bbox();
        Instant current = now.truncatedTo(ChronoUnit.HOURS);
        List<Instant> done = new ArrayList<>();
        for (int i = CATCH_UP_HOURS; i >= 1; i--) {
            Instant h = current.minus(i, ChronoUnit.HOURS);
            Boolean missing = db.sql("""
                    SELECT NOT EXISTS (SELECT 1 FROM track_point_1m WHERE ts_minute >= :from AND ts_minute < :to)
                       AND EXISTS (SELECT 1 FROM track_point WHERE ts >= :from AND ts < :to
                                   AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326))""")
                    .param("from", Sql.ts(h)).param("to", Sql.ts(h.plus(1, ChronoUnit.HOURS)))
                    .param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax())
                    .query(Boolean.class).single();
            if (Boolean.TRUE.equals(missing)) {
                summarizeHour(h);
                done.add(h);
            }
        }
        return done;
    }

    /** 어제부터 7일 전까지 통계 행이 하나도 없는 날을 집계한다(이미 있는 날은 건드리지 않는다). @return 집계한 날 */
    List<LocalDate> catchUpStats(LocalDate today) {
        List<LocalDate> done = new ArrayList<>();
        for (int i = CATCH_UP_DAYS; i >= 1; i--) {
            LocalDate d = today.minusDays(i);
            Boolean has = db.sql("SELECT EXISTS (SELECT 1 FROM stats_daily WHERE day = :d)").param("d", d).query(Boolean.class).single();
            if (!Boolean.TRUE.equals(has)) {
                aggregateDay(d);
                done.add(d);
            }
        }
        return done;
    }

    @Scheduled(cron = "0 30 3 * * *", zone = "UTC")
    public void aggregateDaily() { aggregate(LocalDate.now(ZoneOffset.UTC).minusDays(1)); }

    /** 예약 작업용: 실패를 기록하고 삼킨다. */
    public void aggregate(LocalDate day) {
        try {
            aggregateDay(day);
        } catch (RuntimeException e) {
            log.warn("stats aggregation for {} failed: {}", day, e.toString());
        }
    }

    /**
     * 하루치(UTC) 통계를 한 트랜잭션으로 다시 만든다(지우고 넣기 — 멱등, 중간 실패 시 이전 값 유지). 호출자의 트랜잭션이 있으면 거기에 합류한다.
     * <ul>
     *   <li>sigmet_by_fir / sigmet_by_hazard: 발표일(valid_from 의 UTC 날짜) 기준, 경보당 한 번(계약 §2). 자정을 넘는 경보를 이틀에 세지 않는다.</li>
     *   <li>traffic_by_hour: 시간대별 서로 다른 항공기 수 — 관심 지역 bbox 안만(계약 §2, GAP-18). 전세계 표본이 섞이지 않는다.
     *       어느 지역을 셌는지 traffic_region(center_lat·center_lon·radius_nm)으로 함께 남긴다. 항적이 없는 시간은 행이 없다(0 이 아니라 '자료 없음').</li>
     *   <li>alerts_by_kind: 그날 시작된 알림 수.</li>
     *   <li>alert_dwell_avg_s: 그날 시작해 실제로 이탈(close_reason left, 또는 사유 기록 전의 행)한 OBSERVED 의 평균 체류.
     *       신호 소실·재시작으로 닫힌 것은 체류를 모르므로 뺀다. 해당 알림이 없으면 행을 만들지 않는다(0 을 지어내지 않는다, COR-16).</li>
     * </ul>
     */
    public void aggregateDay(LocalDate day) {
        Instant start = day.atStartOfDay(ZoneOffset.UTC).toInstant();
        Instant end = start.plus(1, ChronoUnit.DAYS);
        RegionSettings.Region r = region.current();
        Bbox b = r.bbox();
        tx.executeWithoutResult(status -> {
            db.sql("DELETE FROM stats_daily WHERE day = :d").param("d", day).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'sigmet_by_fir', fir_id, count(*) FROM sigmet WHERE valid_from >= :s AND valid_from < :e GROUP BY fir_id""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'sigmet_by_hazard', hazard, count(*) FROM sigmet WHERE valid_from >= :s AND valid_from < :e GROUP BY hazard""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).update();
            int traffic = db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'traffic_by_hour', lpad(extract(hour FROM ts AT TIME ZONE 'UTC')::int::text, 2, '0'), count(DISTINCT hex)
                    FROM track_point
                    WHERE ts >= :s AND ts < :e AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                    GROUP BY 3""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end))
                    .param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax()).update();
            if (traffic > 0) {
                db.sql("""
                        INSERT INTO stats_daily (day, metric, dim, value) VALUES
                          (:d, 'traffic_region', 'center_lat', :lat), (:d, 'traffic_region', 'center_lon', :lon), (:d, 'traffic_region', 'radius_nm', :r)""")
                        .param("d", day).param("lat", r.lat()).param("lon", r.lon()).param("r", r.radiusNm()).update();
            }
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'alerts_by_kind', kind, count(*) FROM alert_event WHERE entered_at >= :s AND entered_at < :e GROUP BY kind""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'alert_dwell_avg_s', 'OBSERVED', avg(extract(epoch FROM (left_at - entered_at)))
                    FROM alert_event
                    WHERE kind = 'OBSERVED' AND left_at IS NOT NULL AND entered_at >= :s AND entered_at < :e
                      AND (close_reason IS NULL OR close_reason = 'left')
                    HAVING count(*) > 0""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).update();
        });
        log.info("daily stats aggregated for {} (region {},{} r={} NM)", day, r.lat(), r.lon(), r.radiusNm());
    }
}
