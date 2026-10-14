package dev.wakeline.qa;

import dev.wakeline.DbTestSupport;
import dev.wakeline.history.MaintenanceJobs;
import dev.wakeline.settings.RegionSettings;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.support.TransactionTemplate;

import java.lang.reflect.Method;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-1240(AWS 공개 데모 QA · 신뢰성 · 조건부 데이터 손실): 항적 · 선박 위치의 일(UTC) 파티션은 MaintenanceJobs.ensurePartitions 만 만든다(어제 ~ +3일) —
 * 기동 5 s 뒤 한 번, 그다음은 6 h 뒤(fixedDelay 6 h). AWS 데모는 매일 아침 EC2 와 RDS 를 함께 켜고 dockerd 가 RDS 준비 전에 api 를 띄운다
 * (2026-10-10 재기동에서 기동 직후 DB 작업이 실제로 실패 — VERIFICATION #138). 그 첫 시도가 실패하면 6 h 동안 다시 만들지 않는다.
 * 평일 정지(15 h)는 앞서 만든 +3일 파티션이 덮지만, 3일을 넘는 정지(연휴 — 금 18:00 → 화 08:50 KST = 87 h)에서는 오늘(UTC) 파티션이 없다:
 * 그 6 h 동안 들어온 항적 · 선박 위치 행은 '파티션 없음'(SQLState 23514 — DbErrors.isPermanent)으로 세 번 시도 뒤 버려지고 영수증이 풀려 ACK 된다
 * (다시 오지 않는 영구 손실 — 스택 B 재현: tools/qa/rel_qa_1240_partition_after_long_stop.sh). 같은 기동 경로의 다른 작업(따라잡기 · 설정 미러 ·
 * 공역 새로 읽기)은 1분 안에 다시 한다.
 * 기대: DB 가 늦게 답해도 답한 뒤 몇 분 안에 오늘 파티션이 생긴다(어느 작업이 만들든 — 정해진 주기의 예약 작업만 흉내 낸다).
 */
@EnabledIf("dev.wakeline.DbTestSupport#dockerAvailable")
class Qa1240PartitionEnsureNotRetriedAfterLateDbDbTest {
    /** RDS 가 api 보다 이만큼 늦게 답한다(AWS 아침: RDS 08:40 시작 · EC2 08:50 — 준비까지 몇 분 걸릴 수 있다) */
    static final Duration DB_LATE = Duration.ofSeconds(40);
    /** DB 가 답한 뒤 이 안에 오늘 파티션이 있어야 한다(따라잡기의 첫 재시도 간격과 같은 단위) */
    static final Duration WINDOW = Duration.ofMinutes(5);

    /** DB 가 답하지 않는 동안 연결을 주지 않는 DataSource(연결 거부 — SQLState 08001) */
    static final class LateDataSource extends DelegatingDataSource {
        volatile boolean down = true;
        LateDataSource() { super(DbTestSupport.apiDataSource()); }
        @Override public Connection getConnection() throws SQLException {
            if (down) throw new SQLException("Connection to db:5432 refused (QA-1240: RDS not ready yet)", "08001");
            return super.getConnection();
        }
        @Override public Connection getConnection(String u, String p) throws SQLException { return getConnection(); }
    }

    record Fire(long atMs, Method job) {}

    /** MaintenanceJobs 의 고정 지연 예약 작업이 기동 뒤 [0, until] 에 도는 때(initialDelay + k × fixedDelay) — 스프링 스케줄러를 흉내 낸다 */
    static List<Fire> fixedDelayFires(Duration until) {
        List<Fire> fires = new ArrayList<>();
        for (Method m : MaintenanceJobs.class.getMethods()) {
            Scheduled s = m.getAnnotation(Scheduled.class);
            if (s == null || s.fixedDelay() <= 0) continue;
            for (long t = Math.max(0, s.initialDelay()); t <= until.toMillis(); t += s.fixedDelay()) fires.add(new Fire(t, m));
        }
        fires.sort(Comparator.comparingLong(Fire::atMs));
        return fires;
    }

    static boolean exists(JdbcClient admin, String table) {
        return Boolean.TRUE.equals(admin.sql("SELECT to_regclass(:t) IS NOT NULL").param("t", "public." + table).query(Boolean.class).single());
    }

    @Test
    void afterALongStopTodaysPartitionIsCreatedSoonAfterALateDbAnswers() throws Exception {
        DbTestSupport.reset();
        JdbcClient admin = DbTestSupport.admin();
        String day = LocalDate.now(ZoneOffset.UTC).format(DateTimeFormatter.BASIC_ISO_DATE);
        List<String> today = List.of("track_point_" + day, "ship_position_" + day);
        // 연휴 뒤 첫 기동: 마지막 기동의 ensure(그날 −1 ~ +3일)가 오늘(UTC)에 닿지 못했다 — 오늘 파티션이 없다(reset 이 비운 빈 파티션을 지운다)
        for (String t : today) DbTestSupport.exec("wakeline", "DROP TABLE IF EXISTS " + t);
        try {
            LateDataSource ds = new LateDataSource();
            JdbcClient db = JdbcClient.create(ds);
            MaintenanceJobs jobs = new MaintenanceJobs(db, DbTestSupport.PROPS,
                    new RegionSettings(new StringRedisTemplate(), db, DbTestSupport.JSON, DbTestSupport.PROPS),
                    new TransactionTemplate(new DataSourceTransactionManager(ds)));
            List<String> ran = new ArrayList<>();
            for (Fire f : fixedDelayFires(DB_LATE.plus(WINDOW))) {
                ds.down = f.atMs() < DB_LATE.toMillis();          // 기동 뒤 40 s 동안 DB 가 답하지 않는다
                f.job().invoke(jobs);
                ran.add("+" + f.atMs() / 1000 + "s " + f.job().getName() + (ds.down ? " (db down)" : ""));
            }
            List<String> missing = today.stream().filter(t -> !exists(admin, t)).toList();
            assertThat(missing)
                    .as("DB 가 기동 %d s 뒤에 답한 뒤 %d분 안에 오늘(UTC) 파티션이 있어야 한다 — 없으면 그동안 항적 · 선박 위치 행은 23514 로 버려진다."
                            + " 예약 작업 실행: %s · ensurePartitions 주기 %s", DB_LATE.toSeconds(), WINDOW.toMinutes(), ran,
                            Duration.ofMillis(MaintenanceJobs.class.getMethod("ensurePartitions").getAnnotation(Scheduled.class).fixedDelay()))
                    .isEmpty();
        } finally {
            // 다른 시험을 위해 되돌린다(SECURITY DEFINER 함수 — 소유자 · 권한이 운영과 같다)
            DbTestSupport.exec("wakeline", "SELECT track_point_ensure_partitions(3), ship_position_ensure_partitions(3)");
        }
    }
}
