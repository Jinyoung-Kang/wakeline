package dev.wakeline.history;

import dev.wakeline.platform.config.AppProperties;
import dev.wakeline.geo.Bbox;
import dev.wakeline.settings.RegionSettings;
import dev.wakeline.settings.RetainTargets;
import dev.wakeline.platform.data.Sql;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 파티션 생성, 만료 파티션 삭제(매시 :02 UTC), 보존 삭제(매일 03:00 UTC), 1분 요약(매시 :05, 관심 지역만 · 30일), 통계 집계(매일 03:30 KST — 전날 KST 날짜,
 * 계약 v5 §G20). 기동 시 파티션 보장. 통계의 하루 = KST 날짜({@link #DAY_ZONE}) — 오늘 · 끝난 날도 KST 날짜로 센다. 교통량을 다시 셀 수 있는지는
 * 항적의 저장 단위(UTC 날 파티션)로 판단한다({@link #families}).
 * 보존 정책 ADR-007(R-06 · ADR-017 §2 로 고침): 원해상도 72 h(파티션 전체가 72 h 보다 오래되면 곧바로 삭제 — 가장 오래된 행 72–96 h),
 * 1분 요약 30일, 알림은 끝난 것만 30일(열린 알림은 남긴다 · {@code wakeline.alert-retention-days}, 0 이면 지우지 않는다), SIGMET·통계 영구.
 * 선박(ADR-014): 위치 ship_position 72 h, 정적 정보·수신 공백 영구.
 * 관심 지역은 런타임 설정(collector 와 같은 값, {@link RegionSettings})에서 읽는다(COR-12).
 * 따라잡기(REL-18): cron 은 놓친 시각을 다시 돌리지 않는다 — 기동 1분 뒤 · 성공 뒤 3시간마다(실패하면 1분부터 두 배씩, 30분 상한) 원본이 남은
 * 시간(남아 있는 가장 오래된 항적 파티션부터) 중 요약이 없는 시간과 최근 7일 중 완료 표식이 없는 통계 계열이 있는 날을 채운다(둘 다 멱등, R-46 · AWS 리뷰 B-1 · B-2 · QA-1200). 그보다 오래된 날도 원본이 남은 계열(SIGMET · 알림)에 표식이 없으면
 * 채운다({@link #backfillStats} — V16 뒤 KST 날짜로 다시 세기. 원해상도가 지워진 옛 날의 교통량은 V16 이 옛 UTC 시 행에서 옮겨 실었다).
 */
@org.springframework.context.annotation.Profile("!cli & !migrate")  // CLI(ops-user)·마이그레이션 실행에서는 웹·소비자·잡을 띄우지 않는다
@Component
public class MaintenanceJobs {
    private static final Logger log = LoggerFactory.getLogger(MaintenanceJobs.class);
    /**
     * 일 집계의 날짜 = 이 시간대의 달력 날짜(계약 v5 §G20 — 사용자 결정 2026-09-30 "화면 시각은 KST"): 통계(stats_daily)와 품질 규칙 일별 수
     * (collector quality_rule_count)가 같은 날을 센다. 통계 응답 · 운영 격리 수 응답이 day_zone 으로 밝힌다. 한국은 1988년 뒤로 일광 절약이 없다.
     */
    public static final java.time.ZoneId DAY_ZONE = java.time.ZoneId.of("Asia/Seoul");
    /** 응답의 day_zone 값(IANA 이름) */
    public static final String DAY_ZONE_ID = "Asia/Seoul";

    /** 오늘(KST 날짜) */
    public static LocalDate today() { return LocalDate.now(DAY_ZONE); }
    static final int CATCH_UP_DAYS = 7;
    /**
     * 1분 요약 따라잡기가 요약이 이미 있어도 다시 요약하는 최근 닫힌 시간 수(QA-1202 — 있는 분은 ON CONFLICT 로 그대로, 빠진 분만 더한다). 정시 요약(:05)은
     * 그때 있는 원본만 요약하는데, 그 시간의 행이 :05 뒤에 쓰이는 길이 있다: Redis 장애 동안 수집기가 쌓아 둔 발행(재전송 큐 1,000건 · 64 MiB — 넘치면
     * 가장 오래된 것부터 버린다)이 장애 뒤 들어오거나, api 재시작 뒤 스트림 백로그(시간 트리밍 2.5 h)를 따라잡는 동안 :05 가 돈다 — 둘 다 늦음을 약
     * 2.5 h 로 묶는다(저장기 큐 50,000행은 몇 분 분량). 따라잡기는 성공 뒤 3 h({@link #CATCH_UP_EVERY})마다 돌므로 6 h 면 어느 시간이든 끝나고 3 h 넘게
     * 지난 따라잡기가 한 번은 다시 본다. 그보다 오래된 시간은 요약이 하나도 없을 때만 요약한다 — 원본을 다시 읽는 양은 따라잡기마다 6시간분이다
     * (모든 시간을 다시 읽으면 3일치 원본을 3시간마다 읽는다). 3 h 넘게 늦은 행은 여전히 요약되지 않는다(위 경로로는 생기지 않는다).
     */
    static final int RESUMMARIZE_HOURS = 6;
    /** 따라잡기 창 밖의 날을 한 번의 따라잡기에 채우는 최대 일수(backfillStats) — /stats 범위 상한(92일)과 같다 */
    static final int BACKFILL_MAX_DAYS = 92;
    /** 선박 위치 보존(계약 v2 §B3). 함수가 24 h ~ 30일 밖의 값을 거절한다(V5). */
    static final int SHIP_RETENTION_HOURS = 72;
    /** 체류 통계에 넣는 '확인된 이탈' 조건(V4 마이그레이션의 재계산과 같은 식 — 바꾸면 둘 다 바꾼다). */
    static final String CONFIRMED_EXIT = "close_reason = 'left' AND NOT coalesce((evidence->>'sigmet_expired')::boolean, false)";
    /** 끝난 알림 보존(일, R-06). 0 이하면 지우지 않는다(되돌리기 스위치). */
    static final int DEFAULT_ALERT_RETENTION_DAYS = 30;
    /** 알림 보존 삭제: 한 문장에 지우는 최대 행 수 · 한 번 실행의 최대 반복(긴 트랜잭션·잠금을 피한다 — 남으면 다음 날 이어서). */
    static final int ALERT_DELETE_BATCH = 5_000;
    static final int ALERT_DELETE_MAX_BATCHES = 200;
    private final JdbcClient db;
    private final AppProperties props;
    private final RegionSettings region;
    private final TransactionTemplate tx;
    private final int alertRetentionDays;
    /** 보존 경계 · '오늘'(KST 날짜)을 정하는 시계 — 운영은 시스템 시계, 시험은 고정 시계(경계 시각을 재현한다) */
    private final Clock clock;
    /** 이 잡이 시작한 때(항적 파티션 삭제 보류의 상한 기준) */
    private final Instant startedAt;

    public MaintenanceJobs(JdbcClient db, AppProperties props, RegionSettings region, TransactionTemplate tx) {
        this(db, props, region, tx, DEFAULT_ALERT_RETENTION_DAYS);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public MaintenanceJobs(JdbcClient db, AppProperties props, RegionSettings region, TransactionTemplate tx,
                           @org.springframework.beans.factory.annotation.Value("${wakeline.alert-retention-days:30}") int alertRetentionDays) {
        this(db, props, region, tx, alertRetentionDays, Clock.systemUTC());
    }

    MaintenanceJobs(JdbcClient db, AppProperties props, RegionSettings region, TransactionTemplate tx, int alertRetentionDays, Clock clock) {
        this.db = db;
        this.props = props;
        this.region = region;
        this.tx = tx;
        this.alertRetentionDays = alertRetentionDays;
        this.clock = clock;
        this.startedAt = clock.instant();
    }

    /** 이 잡의 시계로 본 오늘(KST 날짜) */
    LocalDate todayKst() { return LocalDate.ofInstant(clock.instant(), DAY_ZONE); }

    /** 이어진 보장 실패 수 · 다음 시도까지 건너뛸 틱(1분) 수 — 예약 작업 스레드만 바꾼다 */
    private volatile int partitionFailures;
    private volatile int partitionSkipTicks;

    /**
     * 항적 · 선박 위치의 일(UTC) 파티션(어제 ~ +3일)을 만든다 — 기동 5 s 뒤부터 1분 틱마다. 이미 있으면 카탈로그 확인 몇 번뿐이라 매분 해도 가볍다
     * (성공 뒤 몇 시간 쉬게 하면 그동안 직접 부른 보장 — 운영 · 시험 — 이 아무것도 하지 않는다). 실패하면 다음 틱에 다시 하고, 이어서 실패하면 건너뛰는
     * 틱을 두 배씩 늘린다(따라잡기와 같은 물러남 — 1 · 2 · 4 · … 분, {@link #CATCH_UP_RETRY_MAX} 상한 — 연결이 꽉 찬 공유 RDS 에 매분 붙지 않게).
     * 틱을 세어 물러난다(시계가 아니라 — 실패 뒤 첫 다시 시도는 늘 바로 다음 틱이다).
     * 예전에는 6 h 고정 주기였다(QA-1240): 3일 넘게 멈춘 뒤(연휴 — 마지막 보장의 +3일이 오늘에 닿지 않는다) 기동하면 오늘(UTC) 파티션이 없는데, 기동 순간
     * DB 가 아직 답하지 않으면(RDS 준비 전 · 공유 RDS 연결 고갈 53300) 6 h 동안 다시 만들지 않아 그동안 들어온 항적 · 선박 위치가 '파티션 없음'(23514)으로
     * 모두 버려지고 ACK 됐다. 저장기도 23514 로 실패한 배치는 파티션을 만든 뒤 다시 쓴다(TrackWriter · ShipWriter) — 이 작업은 들어오는 행이 없어도
     * 앞날의 파티션을 미리 만든다.
     */
    @Scheduled(initialDelay = 5_000, fixedDelay = 60_000)
    public void ensurePartitions() {
        if (partitionSkipTicks > 0) {
            partitionSkipTicks--;
            return;
        }
        int failures = partitionFailures + 1; // 이번에 실패하면
        long retryMinutes = Math.min(CATCH_UP_RETRY_FIRST.toMinutes() << Math.min(failures - 1, 10), CATCH_UP_RETRY_MAX.toMinutes());
        boolean done = true;
        for (String table : new String[]{"track_point", "ship_position"}) { // 하나가 실패해도 다른 것은 만든다
            try {
                Integer n = db.sql("SELECT " + table + "_ensure_partitions(3)").query(Integer.class).single();
                if (n > 0) log.info("created {} {} partitions", n, table);
            } catch (RuntimeException e) {
                done = false;
                log.warn("ensure {} partitions failed (retry in {} min): {}", table, retryMinutes, e.toString());
            }
        }
        if (done) {
            if (partitionFailures > 0) log.info("partitions ensured after {} failed attempt(s)", partitionFailures);
            partitionFailures = 0;
        } else {
            partitionFailures = failures;
            partitionSkipTicks = (int) retryMinutes - 1; // 1분 틱 — 다음 시도는 retryMinutes 틱 뒤
        }
    }

    /**
     * 만료 파티션 삭제(R-06): 파티션 전체가 보존 기간보다 오래되면 지운다(V9 함수). 매시 돈다 — 경계를 넘은 파티션이 1시간 안에 지워진다
     * (지울 것이 없으면 카탈로그만 읽는다). 하나가 실패해도 다른 것은 돈다.
     */
    @Scheduled(cron = "0 2 * * * *", zone = "UTC")
    public void dropExpiredPartitions() {
        // 기동 뒤 첫 따라잡기가 성공하기 전에는 항적 파티션을 지우지 않는다(상한 DROP_HOLD_MAX — 독립 리뷰 M3): 교통량은 그날 파티션이 있을 때만 다시 센다({@link #families}).
        // 주말에 꺼지는 AWS 데모의 금요일 교통량은 월요일 아침 따라잡기가 세는데, RDS 가 늦게 준비되면 그 전에 목요일 UTC 파티션이 지워져 영구히 빠졌다
        // 선박 위치 파티션도 같다(QA-1201 남은 곳 — 독립 리뷰 2026-10-14): 첫 따라잡기가 지정 선박의 점을 보존표로 옮기기 전에 지우면, 긴 정지 직전
        // 시간의 그 점이 원본과 함께 사라진다(따라잡기가 RDS 를 기다리며 물러나 :02 를 넘길 때)
        if (catchUpOkAt == null && clock.instant().isBefore(startedAt.plus(DROP_HOLD_MAX))) {
            log.info("retention track_point · ship_position partitions: kept until the first catch-up after start (at most {} h)", DROP_HOLD_MAX.toHours());
            return;
        }
        retention("track_point partitions", () -> db.sql("SELECT track_point_drop_old(:h)").param("h", props.trackRetentionHours()).query(Integer.class).single());
        retention("ship_position partitions", () -> db.sql("SELECT ship_position_drop_old(:h)").param("h", SHIP_RETENTION_HOURS).query(Integer.class).single());
    }

    /** 보존 삭제. 문장마다 따로 시도한다 — 하나가 실패해도(권한·잠금) 나머지는 돈다(REL-11). */
    @Scheduled(cron = "0 0 3 * * *", zone = "UTC")
    public void dropOldPartitions() {
        dropExpiredPartitions();
        retention("track_point_1m", () -> db.sql("DELETE FROM track_point_1m WHERE ts_minute < now() - make_interval(days => :d)").param("d", props.summaryRetentionDays()).update());
        retention("alert_event (closed)", this::deleteOldClosedAlerts);
        retention("metar_obs", () -> db.sql("DELETE FROM metar_obs WHERE obs_time < now() - interval '30 days'").update());
        retention("radar_frame", () -> db.sql("DELETE FROM radar_frame WHERE frame_time < now() - interval '7 days'").update());
        retention("quality_event", () -> db.sql("DELETE FROM quality_event WHERE created_at < now() - interval '30 days'").update());
        retention("ingest_run", () -> db.sql("DELETE FROM ingest_run WHERE started_at < now() - interval '30 days'").update());
        retention("quality_rule_count", () -> db.sql("DELETE FROM quality_rule_count WHERE day < :d").param("d", todayKst().minusDays(90)).update());
        // 기상특보 이력(V20 — ADR-036 · 계획 결정 D6): 끝난 지 90일 지난 행. 발효 중인 행(ended_at 없음)은 남긴다
        retention("wx_warning (ended)", () -> db.sql("DELETE FROM wx_warning WHERE ended_at < now() - interval '90 days'").update());
        retention("retained_track", this::deleteOldRetained);
    }

    /**
     * 끝난 알림 중 끝난 지 보존 기간(기본 30일)이 지난 것을 지운다 — 열린 알림(left_at 없음)은 남긴다. entered_at ≤ left_at 이므로
     * entered_at 범위(인덱스 alert_event_entered)로 후보를 좁힌다. 한 문장에 {@value #ALERT_DELETE_BATCH} 행씩(긴 잠금·트랜잭션을 피한다).
     * @return 지운 행 수
     */
    int deleteOldClosedAlerts() {
        if (alertRetentionDays <= 0) return 0;
        int total = 0;
        for (int i = 0; i < ALERT_DELETE_MAX_BATCHES; i++) {
            int n = db.sql("""
                    DELETE FROM alert_event WHERE id IN (
                      SELECT id FROM alert_event
                      WHERE entered_at < now() - make_interval(days => :d) AND left_at < now() - make_interval(days => :d)
                      LIMIT :n)""").param("d", alertRetentionDays).param("n", ALERT_DELETE_BATCH).update();
            total += n;
            if (n < ALERT_DELETE_BATCH) break;
        }
        return total;
    }

    /**
     * 그날의 알림이 아직 모두 남아 있는가(보존 삭제가 그날에 닿지 않았는가). 아니면 재집계가 알림 통계를 다시 세지 않는다 —
     * 원본이 지워진 날을 다시 세면 영구 통계가 0·빈 값으로 바뀐다(R-06).
     */
    boolean alertsRetained(LocalDate day) {
        return alertRetentionDays <= 0 || day.isAfter(todayKst().minusDays(alertRetentionDays));
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
        copyRetained(); // 지정 대상 보존 — 요약과 따로 실패를 가둔다
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

    /** 지정 대상 보존 기간(ADR-038 — 계획 결정 D7) */
    static final int RETAINED_DAYS = 365;
    /** 매시간 옮기는 창(닫힌 시간까지 거슬러) — 한두 번 놓쳐도 다음 실행이 채운다(겹치면 무시). 기동 뒤 따라잡기는 원본이 남은 모든 시간({@link #runCatchUp}) */
    static final int RETAIN_COPY_HOURS = 3;

    /**
     * 지정 대상 기록 보존(ADR-038 · SPEC F7): 지난 {@value #RETAIN_COPY_HOURS}시간(닫힌 시간까지)을 옮긴다. 매시 1분 요약 작업({@link #summarize1m})이 이어서
     * 부른다 — 예약 작업을 더하면 스케줄러 풀(SchedulingConfig.POOL_SIZE)이 작업 수와 같아진다(SchedulingIT).
     */
    public void copyRetained() {
        Instant to = clock.instant().truncatedTo(ChronoUnit.HOURS);
        try {
            int n = copyRetained(to.minus(RETAIN_COPY_HOURS, ChronoUnit.HOURS), to);
            if (n > 0) log.info("retained track: {} new minute points", n);
        } catch (RuntimeException e) {
            log.warn("retained track copy failed (next hour retries): {}", e.toString());
        }
    }

    /** 지금 설정(retain_targets)의 대상 — 읽지 못하거나 틀린 값이면 지정 없음(옮기지 않는다 · 경고 로그) */
    RetainTargets retainTargets() {
        String raw = db.sql("SELECT value #>> '{}' FROM app_setting WHERE key = 'retain_targets'").query(String.class).optional().orElse("");
        try {
            return RetainTargets.parse(raw);
        } catch (IllegalArgumentException e) {
            log.warn("retain_targets ignored (invalid): {}", e.getMessage());
            return RetainTargets.NONE;
        }
    }

    /**
     * [from, to) 의 지정 대상 원해상도 점을 1분에 첫 점 하나로 retained_track 에 옮긴다 — 이미 있는 분은 그대로(다시 돌려도 같다).
     * 지정을 풀면 다음 실행부터 옮기지 않고, 옮긴 점은 보존 기간까지 남는다. @return 새로 들어간 행 수
     */
    int copyRetained(Instant from, Instant to) {
        RetainTargets t = retainTargets();
        int n = 0;
        if (!t.aircraft().isEmpty())
            n += db.sql("""
                    INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, provider)
                    SELECT DISTINCT ON (hex, date_trunc('minute', ts)) 'aircraft', hex::text, date_trunc('minute', ts), ts, geom, alt_ft, gs_kt, track_deg, provider
                    FROM track_point WHERE hex IN (:ids) AND ts >= :from AND ts < :to
                    ORDER BY hex, date_trunc('minute', ts), ts
                    ON CONFLICT (kind, target_id, ts_minute) DO NOTHING""")
                    .param("ids", t.aircraft()).param("from", Sql.ts(from)).param("to", Sql.ts(to)).update();
        if (!t.ships().isEmpty())
            n += db.sql("""
                    INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, sog_kn, cog_deg, provider)
                    SELECT DISTINCT ON (mmsi, date_trunc('minute', ts)) 'ship', mmsi::text, date_trunc('minute', ts), ts, geom, sog_kn, cog_deg, provider
                    FROM ship_position WHERE mmsi IN (:ids) AND ts >= :from AND ts < :to
                    ORDER BY mmsi, date_trunc('minute', ts), ts
                    ON CONFLICT (kind, target_id, ts_minute) DO NOTHING""")
                    .param("ids", t.ships()).param("from", Sql.ts(from)).param("to", Sql.ts(to)).update();
        return n;
    }

    /** 보존 기간이 지난 지정 보존 점을 지운다 — 한 문장에 {@value #ALERT_DELETE_BATCH} 행씩(긴 잠금을 피한다). @return 지운 행 수 */
    int deleteOldRetained() {
        int total = 0;
        for (int i = 0; i < ALERT_DELETE_MAX_BATCHES; i++) {
            int n = db.sql("""
                    DELETE FROM retained_track WHERE ctid IN (
                      SELECT ctid FROM retained_track WHERE ts_minute < :cut LIMIT :n)""")
                    .param("cut", Sql.ts(clock.instant().minus(RETAINED_DAYS, ChronoUnit.DAYS))).param("n", ALERT_DELETE_BATCH).update();
            total += n;
            if (n < ALERT_DELETE_BATCH) break;
        }
        return total;
    }

    /** 기동 뒤 첫 따라잡기가 성공하기 전 항적 파티션 삭제를 미루는 상한(독립 리뷰 M3) */
    static final Duration DROP_HOLD_MAX = Duration.ofHours(6);
    /** 성공한 따라잡기 뒤 다음 따라잡기까지(REL-18) */
    static final Duration CATCH_UP_EVERY = Duration.ofHours(3);
    /** 실패 뒤 첫 재시도 간격 — 실패가 이어지면 두 배씩 {@link #CATCH_UP_RETRY_MAX} 까지(결정적으로 실패하는 집계를 공유 RDS 에 1분마다 되풀이하지 않게) */
    static final Duration CATCH_UP_RETRY_FIRST = Duration.ofMinutes(1);
    static final Duration CATCH_UP_RETRY_MAX = Duration.ofMinutes(30);
    /** 연달아 실패하는 동안 경고를 남기는 간격 — 같은 경고를 재시도마다 남기지 않는다 */
    static final Duration CATCH_UP_WARN_EVERY = Duration.ofMinutes(10);
    /** 마지막으로 성공한 따라잡기(없으면 기동 뒤 아직 — 첫 틱에 돈다) */
    private volatile Instant catchUpOkAt;
    private volatile Instant catchUpWarnedAt;
    private volatile Instant retainedWarnedAt;
    /** 실패 뒤 다음 시도(없으면 곧바로) */
    private volatile Instant catchUpRetryAt;
    private volatile int catchUpFailures;

    /**
     * 기동 1분 뒤부터 1분마다 보고, 마지막 성공 뒤 {@link #CATCH_UP_EVERY} 가 지났으면 놓친 1분 요약 · 일 통계를 채운다(REL-18) — 실패하면 1분 뒤 다시,
     * 이어서 실패하면 두 배씩 {@link #CATCH_UP_RETRY_MAX} 까지 늘린다(독립 리뷰 M2 — 결정적으로 실패하는 집계를 1분마다 되풀이하지 않게).
     * 3 h 고정 주기였을 때는 기동 직후의 실패(RDS 준비 전 — AWS 데모는 매일 아침 EC2 · RDS 를 함께 켠다, ADR-039)를 3 h 뒤에야 다시 했다:
     * 그 데모에서는 03:30 KST 정시 집계가 꺼진 시간이라 일 통계가 따라잡기에만 기대고, 금요일 교통량은 월요일 09:00 KST 뒤에는 다시 셀 수 없다(AWS 리뷰 B-2).
     */
    @Scheduled(initialDelay = 60_000, fixedDelay = 60_000)
    public void catchUpTick() {
        Instant now = clock.instant();
        Instant ok = catchUpOkAt;
        if (ok != null && now.isBefore(ok.plus(CATCH_UP_EVERY))) return;
        Instant retry = catchUpRetryAt;
        if (retry != null && now.isBefore(retry)) return;
        if (runCatchUp()) {
            if (catchUpFailures > 0) log.info("catch-up succeeded after {} failed attempt(s)", catchUpFailures);
            catchUpOkAt = now;
            catchUpFailures = 0;
            catchUpRetryAt = null;
            catchUpWarnedAt = null;
        } else {
            catchUpFailures++;
            long minutes = CATCH_UP_RETRY_FIRST.toMinutes() << Math.min(catchUpFailures - 1, 10);
            catchUpRetryAt = now.plus(Duration.ofMinutes(Math.min(minutes, CATCH_UP_RETRY_MAX.toMinutes())));
        }
    }

    /** 따라잡기 한 번(주기와 상관없이 — 시험 · 수동). 성공하면 틱과 같이 기록한다(항적 파티션 삭제 보류가 풀린다) */
    public void catchUp() {
        if (runCatchUp()) {
            catchUpOkAt = clock.instant();
            catchUpFailures = 0;
            catchUpRetryAt = null;
        }
    }

    /** @return 요약 · 일 통계 따라잡기가 끝까지 됐는가 — 지정 보존 복사의 실패는 따로 가두고 세지 않는다(매시 복사 {@link #copyRetained()} 가 다시 한다) */
    boolean runCatchUp() {
        boolean done = true;
        try {
            List<Instant> hours = catchUpSummaries(Instant.now());
            List<LocalDate> days = catchUpStats(todayKst());
            List<LocalDate> older = backfillStats(todayKst());
            if (!hours.isEmpty() || !days.isEmpty() || !older.isEmpty())
                log.info("catch-up: summarized hours {}, aggregated days {}, backfilled {} older days {}", hours, days, older.size(),
                        older.isEmpty() ? "" : older.get(older.size() - 1) + ".." + older.get(0));
        } catch (RuntimeException e) {
            done = false;
            Instant now = clock.instant();
            Instant warned = catchUpWarnedAt;
            if (warned == null || !now.isBefore(warned.plus(CATCH_UP_WARN_EVERY))) {
                catchUpWarnedAt = now;
                log.warn("catch-up failed (will retry): {}", e.toString());
            }
        }
        // 지정 대상 보존 복사는 따로 가둔다(ADR-038 결정 3 · QA-601): 위가 실패해도 72 h 파티션 삭제 전에 옮길 기회를 잃지 않는다.
        // 창 = 원본이 남아 있는 모든 시간(보존 365일 안 — 남은 파티션만 읽힌다, 대상마다 (hex|mmsi, ts) 기본 키 범위). 70 h 고정이던 때는 그보다 긴 정지
        // (연휴 · 기동 실패) 직전 시간의 지정 대상 점을 원본이 남아 있는데도 옮기지 않아 원본 삭제와 함께 잃었다(QA-1201 — 매시 복사는 닫힌 3시간만 본다)
        try {
            Instant hour = clock.instant().truncatedTo(ChronoUnit.HOURS);
            int retained = copyRetained(hour.minus(RETAINED_DAYS, ChronoUnit.DAYS), hour); // 기동 · 놓친 시간(겹치면 무시)
            if (retained > 0) log.info("catch-up: retained track {} new minute points", retained);
        } catch (RuntimeException e) {
            Instant now = clock.instant();
            Instant warned = retainedWarnedAt;
            if (warned == null || !now.isBefore(warned.plus(CATCH_UP_WARN_EVERY))) {
                retainedWarnedAt = now;
                log.warn("catch-up of retained track failed (will retry): {}", e.toString());
            }
        }
        return done;
    }

    /**
     * 원본이 남아 있는 닫힌 시간 중 원해상도 항적은 있는데 1분 요약이 하나도 없는 시간을 요약한다. 창의 시작 = 남아 있는 가장 오래된 항적 파티션의 시작
     * ({@link #oldestPartitionStart}) — 1분 요약 보존({@code summaryRetentionDays})보다 오래된 시간은 빼고(요약해도 다음 보존 삭제가 지운다).
     * 창을 시계로 고정하지 않는다(QA-1200): 24 h 이던 창은 주말 정지(약 63 h — ADR-039)를, 그 뒤의 '원해상도 보존 − 2 h'(70 h)는 그보다 긴 정지(연휴 ·
     * 기동 실패 — 금 18:00 → 화 09:00 KST 는 87 h)를 넘지 못해, 멈추기 직전 시간의 요약이 원본 삭제와 함께 영구히 빠졌다(재생은 보존 뒤 1분 요약만
     * 읽는다). 그 원본은 기동 뒤 첫 따라잡기가 끝날 때까지 삭제를 미루므로({@link #DROP_HOLD_MAX}) 파티션이 남아 있다 — 남은 파티션이 곧 요약할 수 있는 범위다.
     * 지워지는 중인 파티션과 겹쳐도 깨지지 않는다: 파티션 DROP 은 부모의 ACCESS EXCLUSIVE 를 얻을 때까지 이 읽기를 기다리고, 그 뒤의 읽기는 그 시간을 빈
     * 것으로 본다(예전 2 h 여유는 필요 없다). 시간마다 작은 EXISTS 두 번(ts BRIN · ts_minute 색인) — 평소 창은 가장 오래된 파티션까지 96 h 안팎.
     * 최근 {@value #RESUMMARIZE_HOURS}시간은 요약이 있어도 다시 요약한다(늦게 쓰인 분 — QA-1202). @return 요약한 시간(최근 시간은 새로 더한 분이 있을 때만)
     */
    List<Instant> catchUpSummaries(Instant now) {
        Bbox b = region.current().bbox();
        Instant current = now.truncatedTo(ChronoUnit.HOURS);
        Instant oldest = oldestPartitionStart("track_point");
        if (oldest == null) return List.of();
        Instant first = latest(oldest, current.minus(props.summaryRetentionDays(), ChronoUnit.DAYS));
        Instant recent = current.minus(RESUMMARIZE_HOURS, ChronoUnit.HOURS);
        List<Instant> done = new ArrayList<>();
        for (Instant h = first; h.isBefore(current); h = h.plus(1, ChronoUnit.HOURS)) {
            if (!h.isBefore(recent)) {
                if (summarizeHour(h) > 0) done.add(h); // 요약이 없던 시간 · 정시 요약 뒤에 늦게 쓰인 분
                continue;
            }
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

    /**
     * 표(track_point · ship_position)의 남아 있는 가장 오래된 일 파티션의 시작(UTC 날 00:00), 없으면 null. 파티션 이름(표_YYYYMMDD)으로 읽는다 —
     * 파티션 함수 · 보존 삭제(V2 · V5 · V9)와 같은 규칙. 시스템 카탈로그만 읽는다(행을 읽지 않는다).
     */
    Instant oldestPartitionStart(String table) {
        String day = db.sql("""
                SELECT min(substring(c.relname from '^' || :t || '_([0-9]{8})$'))
                FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
                WHERE p.relname = :t""").param("t", table).query(String.class).optional().orElse(null);
        return day == null ? null : LocalDate.parse(day, java.time.format.DateTimeFormatter.BASIC_ISO_DATE).atStartOfDay(ZoneOffset.UTC).toInstant();
    }

    static Instant latest(Instant a, Instant b) { return a.isAfter(b) ? a : b; }

    /**
     * 어제부터 7일 전까지, 원본이 남아 있는 계열 중 완료 표식이 없는 계열이 하나라도 있는 날을 집계한다(R-46: 행이 있는지로 판단하면 자료가
     * 없는 날은 3시간마다 영원히 다시 돌고, 부분 행이 있는 날은 건너뛰었다). @return 집계한 날
     */
    List<LocalDate> catchUpStats(LocalDate today) {
        List<LocalDate> done = new ArrayList<>();
        for (int i = CATCH_UP_DAYS; i >= 1; i--) {
            LocalDate d = today.minusDays(i);
            List<String> marked = db.sql("SELECT dim FROM stats_daily WHERE day = :d AND metric = :m").param("d", d).param("m", MARKER)
                    .query(String.class).list();
            if (!marked.containsAll(families(d))) {
                aggregateDay(d);
                done.add(d);
            }
        }
        return done;
    }

    /**
     * 따라잡기 창(최근 {@value #CATCH_UP_DAYS}일)보다 오래된 날 중, 원본이 남아 있어 다시 셀 수 있는 계열(SIGMET 영구 · 알림 보존 안 — 교통량은 72 h 라 없다)에
     * 완료 표식이 없는 날을 최근 날부터 채운다. 한 번에 {@value #BACKFILL_MAX_DAYS}일까지(남으면 다음 따라잡기가 잇는다 — 기동 직후를 오래 붙잡지 않는다).
     * V16 이 KST 날짜 표를 새로 연 뒤 이 날들은 다시 셀 수 있는데 7일 밖이라 '집계되지 않음' 으로 남았다(리뷰 2026-09-30 — /stats 는 92일 범위를 받는다).
     * 교통량의 옛 날은 V16 이 옛 UTC 시 행에서 옮겨 실었다(KST = UTC + 9 정시 — 시 하나가 옛 행 하나, 두 UTC 날이 완료 · 같은 지역인 날만).
     * 범위의 시작 = 원본이 있는 가장 이른 KST 날짜(SIGMET 발표 · 알림 진입). 멱등 — 다 채운 뒤에는 최솟값 한 번 · 표식 한 번 읽고 끝난다. @return 집계한 날
     */
    List<LocalDate> backfillStats(LocalDate today) {
        LocalDate last = today.minusDays(CATCH_UP_DAYS + 1);
        LocalDate first = db.sql("""
                SELECT (least((SELECT min(valid_from) FROM sigmet), (SELECT min(entered_at) FROM alert_event)) AT TIME ZONE :zone)::date""")
                .param("zone", DAY_ZONE_ID).query(LocalDate.class).optional().orElse(null);
        if (first == null || first.isAfter(last)) return List.of();
        Map<LocalDate, List<String>> marked = new java.util.HashMap<>();
        db.sql("SELECT day, dim FROM stats_daily WHERE metric = :m AND day BETWEEN :a AND :b").param("m", MARKER).param("a", first).param("b", last)
                .query((rs, i) -> Map.entry(rs.getObject("day", LocalDate.class), rs.getString("dim"))).list()
                .forEach(e -> marked.computeIfAbsent(e.getKey(), k -> new ArrayList<>()).add(e.getValue()));
        List<LocalDate> done = new ArrayList<>();
        for (LocalDate d = last; !d.isBefore(first) && done.size() < BACKFILL_MAX_DAYS; d = d.minusDays(1)) {
            if (!marked.getOrDefault(d, List.of()).containsAll(families(d))) {
                aggregateDay(d);
                done.add(d);
            }
        }
        return done;
    }

    /** 일 통계 계열의 완료 표식(R-46): stats_daily (day, 'aggregated_at', 계열) = 집계 시각(유닉스 초). 조회 API 는 metric 으로 거르므로 보이지 않는다. */
    public static final String MARKER = "aggregated_at";
    public static final String FAMILY_SIGMET = "sigmet";
    public static final String FAMILY_TRAFFIC = "traffic";
    public static final String FAMILY_ALERTS = "alerts";
    private static final Map<String, List<String>> FAMILY_METRICS = Map.of(
            FAMILY_SIGMET, List.of("sigmet_by_fir", "sigmet_by_hazard"),
            FAMILY_TRAFFIC, List.of("traffic_by_hour", "traffic_region"),
            FAMILY_ALERTS, List.of("alerts_by_kind", "alert_dwell_avg_s"));

    /**
     * 그날(KST 날짜) 원본이 아직 모두 남아 있어 다시 셀 수 있는 계열: SIGMET 은 영구, 교통량은 그날의 원해상도 항적이 모두 보존 안일 때, 알림은 보존 삭제가
     * 닿기 전. 원본이 사라진 계열은 재집계가 건드리지 않는다(0·빈 값으로 덮지 않는다).
     * 교통량의 경계는 저장 단위를 따른다: 항적은 UTC 날 파티션에 있고 파티션째 지워진다(V9 track_point_drop_old — 파티션 끝 ≤ now − 보존). KST 날짜
     * 하루는 UTC 날 두 파티션에 걸치고(00:00–08:59 KST 는 앞 UTC 날), 앞 파티션이 먼저 지워진다 — 그래서 그날 첫 순간이 든 UTC 파티션의 끝이
     * now − 보존 보다 뒤일 때만 다시 센다(리뷰 2026-09-30: 그날 끝으로 판단하면 매일 09:00–24:00 KST 에 오늘−3 의 00–08시가 빠진 수를 완료로 남겼다).
     */
    List<String> families(LocalDate day) {
        List<String> f = new ArrayList<>(List.of(FAMILY_SIGMET));
        if (trafficRecountable(day)) f.add(FAMILY_TRAFFIC);
        if (alertsRetained(day)) f.add(FAMILY_ALERTS);
        return f;
    }

    /**
     * 그날(KST)의 교통량을 다시 셀 수 있는가: 그날 첫 순간이 든 UTC 날 파티션이 보존 안이거나(시계 — 삭제는 이 경계 뒤 매시 :02 에 돈다), 경계를 지났어도
     * 그 파티션이 아직 있으면(삭제를 미룬 동안 — {@link #dropExpiredPartitions}). 항적은 UTC 날 파티션째 오래된 것부터 지워지므로 그 파티션이 있으면 그날
     * 원본이 모두 있다. 시계만 보던 때는 금요일 교통량을 월 09:00 KST 부터 다시 세지 않아, RDS 가 늦게 준비된 월요일에는 영구히 빠졌다(독립 리뷰 M3).
     * 파티션이 있는지만 보지는 않는다 — 꺼져 있던 동안은 파티션이 처음부터 없고(자료도 없다), 그날의 나머지 자료는 세야 한다.
     * 보존보다 따라잡기 창({@value #CATCH_UP_DAYS}일) 넘게 지난 날은 묻지 않는다 — 꺼져 있던 동안은 삭제도 돌지 않아 긴 정지(연휴) 뒤에는 보존을 하루 넘게
     * 지난 파티션도 남아 있다(후속 리뷰 L1). 질의는 따라잡기 한 번에 많아야 그 일수만큼.
     */
    boolean trafficRecountable(LocalDate day) {
        Instant start = day.atStartOfDay(DAY_ZONE).toInstant();
        Instant end = trackPartitionEnd(start);
        if (end.isAfter(clock.instant().minus(props.trackRetentionHours(), ChronoUnit.HOURS))) return true;
        if (!end.isAfter(clock.instant().minus(props.trackRetentionHours() + 24L * CATCH_UP_DAYS, ChronoUnit.HOURS))) return false;
        String partition = "track_point_" + LocalDate.ofInstant(start, ZoneOffset.UTC).format(java.time.format.DateTimeFormatter.BASIC_ISO_DATE);
        return Boolean.TRUE.equals(db.sql("SELECT to_regclass(:p) IS NOT NULL").param("p", partition).query(Boolean.class).single());
    }

    /** 순간 t 가 든 항적 파티션(UTC 날 [d, d+1))의 끝 = 다음 UTC 날 00:00 — 파티션 이름 · 경계 · 보존 삭제가 모두 UTC 날이다(V2 · V9) */
    static Instant trackPartitionEnd(Instant t) {
        return LocalDate.ofInstant(t, ZoneOffset.UTC).plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
    }

    /** 매일 03:30 KST 에 전날(KST 날짜)을 센다 — 그날이 끝나고 3.5 h 뒤(늦게 들어온 기록 여유). 놓치면 따라잡기가 채운다. */
    @Scheduled(cron = "0 30 3 * * *", zone = DAY_ZONE_ID)
    public void aggregateDaily() { aggregate(todayKst().minusDays(1)); }

    /** 예약 작업용: 실패를 기록하고 삼킨다. */
    public void aggregate(LocalDate day) {
        try {
            aggregateDay(day);
        } catch (RuntimeException e) {
            log.warn("stats aggregation for {} failed: {}", day, e.toString());
        }
    }

    /**
     * 하루치(KST 날짜 — [그날 00:00 KST, 다음 날 00:00 KST), 계약 v5 §G20) 통계를 한 트랜잭션으로 다시 만든다(지우고 넣기 — 멱등, 중간 실패 시 이전 값 유지).
     * 호출자의 트랜잭션이 있으면 거기에 합류한다.
     * <ul>
     *   <li>sigmet_by_fir / sigmet_by_hazard: 발표일(valid_from 의 KST 날짜) 기준, 경보당 한 번(계약 §2). 자정을 넘는 경보를 이틀에 세지 않는다.</li>
     *   <li>traffic_by_hour: 시간대별(dim = KST 시 "00"–"23") 서로 다른 항공기 수 — 관심 지역 bbox 안만(계약 §2, GAP-18). 전세계 표본이 섞이지 않는다.
     *       어느 지역을 셌는지 traffic_region(center_lat·center_lon·radius_nm)으로 함께 남긴다. 항적이 없는 시간은 행이 없다(0 이 아니라 '자료 없음').</li>
     *   <li>alerts_by_kind: 그날 시작된 알림 수.</li>
     *   <li>alert_dwell_avg_s: 그날 시작해 <b>이탈이 확인된</b>(close_reason = 'left', 바깥 관측 3회) OBSERVED 의 평균 체류(DH-5·API-CONC-3).
     *       빼는 것: 사유 기록 전의 행(NULL — V3 가 밝혔듯 신호 소실도 LEFT 로 닫혔을 수 있다), 신호 소실·재시작(체류를 모른다),
     *       경보 종료(sigmet_ended — 항공기는 나가지 않았다), 그리고 경보 만료 뒤에 닫힌 옛 'left' 행(evidence.sigmet_expired —
     *       바깥 관측이 만료 때문이었을 수 있어 이탈 시각을 믿을 수 없다). 해당 알림이 없으면 행을 만들지 않는다(0 을 지어내지 않는다, COR-16).</li>
     * </ul>
     * 계열마다({@link #families}) 원본이 남아 있을 때만 다시 만든다 — 보존으로 원본이 사라진 계열은 행과 표식을 그대로 둔다(R-06·R-46).
     * 끝난 날(오늘 KST 이전)이면 다시 만든 계열마다 완료 표식({@link #MARKER})을 남긴다 — 오늘(부분)의 집계는 완료로 남기지 않는다.
     */
    public void aggregateDay(LocalDate day) {
        Instant start = day.atStartOfDay(DAY_ZONE).toInstant();
        Instant end = start.plus(1, ChronoUnit.DAYS);
        RegionSettings.Region r = region.current();
        Bbox b = r.bbox();
        boolean finished = day.isBefore(todayKst());
        List<String> families = tx.execute(status -> {
            // 같은 날의 재집계는 한 번에 하나(리뷰 cto-2026-10 D5): 03:30 정시 · 3시간 따라잡기 · 운영 POST 가 겹치면 둘 다 그날 행을 지운 뒤(서로의 커밋 전
            // INSERT 는 보이지 않는다) 완료 표식을 넣어 뒤의 것이 기본 키에서 23505 로 실패했다(운영 POST 는 500 · 감사 행도 롤백). 트랜잭션 잠금이라
            // 커밋 · 롤백 때 풀린다. 다른 날은 서로 기다리지 않는다.
            db.sql("SELECT pg_advisory_xact_lock(hashtext('stats_daily'), :day)").param("day", (int) day.toEpochDay()).query((rs, i) -> 1).single();
            // traffic_by_hour 는 하루치 관심 지역 점을 (시, hex) 로 정렬한다 — 기본 work_mem(4 MB)으로는 디스크로 넘쳤다(external merge, R-27).
            // 이 트랜잭션에만 넉넉히 준다. 읽는 양(하루 파티션 순차 스캔)은 그대로다: 관심 지역 점은 전세계 점과 같은 페이지에 섞여 있어
            // 공간 인덱스로도 거의 모든 페이지를 읽게 된다(하루 1회 배치 — 요청 경로 아님).
            db.sql("SET LOCAL work_mem = '64MB'").update();
            // 교통량을 다시 셀 수 있으면 부모 track_point 를 먼저 잡고(ACCESS SHARE — 수집기의 쓰기와는 부딪치지 않는다) 계열을 다시 판단한다:
            // 판단과 읽기 사이에 보존 삭제(매시 :02)가 파티션을 지우지 못한다 — DROP 은 이 트랜잭션이 끝날 때까지 기다린다.
            if (families(day).contains(FAMILY_TRAFFIC)) lockTrackPoint(db);
            List<String> fam = families(day);
            List<String> metrics = fam.stream().flatMap(f -> FAMILY_METRICS.get(f).stream()).toList();
            // 다시 만드는 계열의 행·표식만 지운다 — 원본이 사라진 계열은 그대로(다시 셀 수 없다)
            db.sql("DELETE FROM stats_daily WHERE day = :d AND (metric IN (:metrics) OR (metric = :marker AND dim IN (:families)))")
                    .param("d", day).param("metrics", metrics).param("marker", MARKER).param("families", fam).update();
            if (finished) {
                db.sql("INSERT INTO stats_daily (day, metric, dim, value) SELECT :d, :marker, f, extract(epoch FROM now())::bigint FROM unnest(:families::text[]) f")
                        .param("d", day).param("marker", MARKER).param("families", fam.toArray(String[]::new)).update();
            }
            aggregateFamilies(day, fam, start, end, r, b);
            return fam;
        });
        log.info("daily stats aggregated for {}: {} (region {},{} r={} NM){}", day, families, r.lat(), r.lon(), r.radiusNm(), finished ? "" : " — partial day, not marked complete");
    }

    /** 부모 track_point 를 ACCESS SHARE 로 잡는다(트랜잭션 끝까지) — 파티션 DROP(보존 삭제)은 부모의 ACCESS EXCLUSIVE 가 필요해 그동안 기다린다. */
    static void lockTrackPoint(JdbcClient db) {
        db.sql("LOCK TABLE track_point IN ACCESS SHARE MODE").update();
    }

    private void aggregateFamilies(LocalDate day, List<String> families, Instant start, Instant end, RegionSettings.Region r, Bbox b) {
        if (families.contains(FAMILY_SIGMET)) {
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'sigmet_by_fir', fir_id, count(*) FROM sigmet WHERE valid_from >= :s AND valid_from < :e GROUP BY fir_id""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'sigmet_by_hazard', hazard, count(*) FROM sigmet WHERE valid_from >= :s AND valid_from < :e GROUP BY hazard""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).update();
        }
        if (families.contains(FAMILY_TRAFFIC)) {
            int traffic = db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'traffic_by_hour', lpad(extract(hour FROM ts AT TIME ZONE :zone)::int::text, 2, '0'), count(DISTINCT hex)
                    FROM track_point
                    WHERE ts >= :s AND ts < :e AND geom && ST_MakeEnvelope(:lomin, :lamin, :lomax, :lamax, 4326)
                    GROUP BY 3""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).param("zone", DAY_ZONE_ID)
                    .param("lomin", b.lomin()).param("lamin", b.lamin()).param("lomax", b.lomax()).param("lamax", b.lamax()).update();
            if (traffic > 0) {
                db.sql("""
                        INSERT INTO stats_daily (day, metric, dim, value) VALUES
                          (:d, 'traffic_region', 'center_lat', :lat), (:d, 'traffic_region', 'center_lon', :lon), (:d, 'traffic_region', 'radius_nm', :r)""")
                        .param("d", day).param("lat", r.lat()).param("lon", r.lon()).param("r", r.radiusNm()).update();
            }
        }
        // 알림 통계는 SIGMET 알림만 센다(V19 — 공역 알림은 다른 뜻이라 섞지 않는다, 계약 v5 §G48)
        if (families.contains(FAMILY_ALERTS)) {
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'alerts_by_kind', kind, count(*) FROM alert_event WHERE entered_at >= :s AND entered_at < :e AND zone_type = 'sigmet' GROUP BY kind""")
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).update();
            db.sql("""
                    INSERT INTO stats_daily (day, metric, dim, value)
                    SELECT :d, 'alert_dwell_avg_s', 'OBSERVED', avg(extract(epoch FROM (left_at - entered_at)))
                    FROM alert_event
                    WHERE kind = 'OBSERVED' AND left_at IS NOT NULL AND entered_at >= :s AND entered_at < :e AND zone_type = 'sigmet'
                      AND (%s)
                    HAVING count(*) > 0""".formatted(CONFIRMED_EXIT))
                    .param("d", day).param("s", Sql.ts(start)).param("e", Sql.ts(end)).update();
        }
    }
}
