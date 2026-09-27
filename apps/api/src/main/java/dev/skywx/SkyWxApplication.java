package dev.skywx;

import dev.skywx.config.AppProperties;
import dev.skywx.ops.OpsUserService;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.output.MigrateResult;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** SkyWx api — 스트림 소비·인메모리 스냅샷·공간 판정·WebSocket 팬아웃·REST·운영 API. 외부 API 는 절대 직접 부르지 않는다(ADR-006). */
@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(AppProperties.class)
public class SkyWxApplication {
    /** 운영자 비밀번호 길이: 12자 이상, BCrypt 가 실제로 쓰는 72바이트(UTF-8) 이하 — 그보다 긴 부분은 검증되지 않으므로 받지 않는다. */
    static final int OPS_PASSWORD_MIN_CHARS = 12;
    static final int OPS_PASSWORD_MAX_BYTES = 72;

    public static void main(String[] args) {
        List<String> a = Arrays.asList(args);
        if (a.contains("--migrate")) {
            System.exit(migrate(System.getenv()));
            return;
        }
        if (a.contains("--create-ops-user")) {
            System.exit(createOpsUser(a.contains("--password-stdin"), System.in, System.getenv()));
            return;
        }
        SpringApplication.run(SkyWxApplication.class, args);
    }

    /**
     * 한 번 실행하고 끝나는 마이그레이션(compose 의 migrate 서비스). Spring 컨텍스트 없이 Flyway 만 돌린다 —
     * 필요한 것은 DB 접속 정보와 DDL 권한 계정(skywx_migrator)의 비밀번호뿐이다(api 계정·Redis 비밀번호 불필요, SEC-3).
     * DDL 비밀번호는 이 프로세스에만 있다. api 프로세스는 Flyway 를 끈 채(DML 전용 계정) 뜬다.
     * @return 종료 코드(0 성공)
     */
    static int migrate(Map<String, String> env) {
        String password = env.get("DB_MIGRATOR_PASSWORD");
        if (password == null || password.isBlank()) {
            System.err.println("DB_MIGRATOR_PASSWORD is required for --migrate");
            return 2;
        }
        String url = "jdbc:postgresql://" + env.getOrDefault("DB_HOST", "localhost") + ":" + env.getOrDefault("DB_PORT", "5432")
                + "/" + env.getOrDefault("DB_NAME", "skywx") + "?ApplicationName=skywx-migrate";
        try {
            MigrateResult r = Flyway.configure()
                    .dataSource(url, env.getOrDefault("DB_MIGRATOR_USER", "skywx_migrator"), password)
                    .locations("classpath:db/migration")
                    .connectRetries(10)
                    .load()
                    .migrate();
            String version = r.targetSchemaVersion != null ? r.targetSchemaVersion : r.initialSchemaVersion;
            System.out.println("migrations applied: " + r.migrationsExecuted + " (schema version " + version + ")");
            return 0;
        } catch (RuntimeException e) {
            System.err.println("migration failed: " + e.getMessage());
            return 1;
        }
    }

    /**
     * 운영자 계정 생성/갱신. 비밀번호는 표준 입력 한 줄(--password-stdin, 계약 §7 — 명령행·프로세스 목록에 남지 않는다) 또는
     * 환경변수 SKYWX_OPS_PASSWORD(이전 방식 호환). 사용자명은 SKYWX_OPS_USER(기본 admin). 비밀번호는 소스·로그에 남지 않는다.
     * @return 종료 코드(0 성공, 2 입력 오류)
     */
    static int createOpsUser(boolean passwordFromStdin, InputStream stdin, Map<String, String> env) {
        String user = env.getOrDefault("SKYWX_OPS_USER", "admin");
        String password;
        if (passwordFromStdin) {
            try {
                password = readPasswordLine(stdin);
            } catch (IOException e) {
                System.err.println("could not read the password from stdin");
                return 2;
            }
            if (password == null) {
                System.err.println("--password-stdin: no password on stdin");
                return 2;
            }
        } else {
            password = env.get("SKYWX_OPS_PASSWORD");
        }
        String problem = checkOpsPassword(password);
        if (problem != null) {
            System.err.println(problem);
            return 2;
        }
        if (user.isBlank() || user.length() > 64) {
            System.err.println("SKYWX_OPS_USER must be 1..64 characters");
            return 2;
        }
        var app = new SpringApplication(SkyWxApplication.class);
        app.setAdditionalProfiles("cli");
        try (ConfigurableApplicationContext ctx = app.run("--spring.main.web-application-type=none", "--spring.flyway.enabled=false")) {
            ctx.getBean(OpsUserService.class).upsert(user, password);
            System.out.println("ops user '" + user + "' ready");
        }
        return 0;
    }

    /** 첫 줄(줄바꿈·CR 제외). 스트림이 비어 있으면 null. 앞뒤 공백은 비밀번호의 일부일 수 있어 자르지 않는다. */
    static String readPasswordLine(InputStream in) throws IOException {
        String line = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)).readLine();
        if (line == null) return null;
        if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
        return line;
    }

    /** @return 문제 설명, 괜찮으면 null */
    static String checkOpsPassword(String password) {
        if (password == null || password.length() < OPS_PASSWORD_MIN_CHARS)
            return "ops password must be at least " + OPS_PASSWORD_MIN_CHARS + " characters";
        if (password.getBytes(StandardCharsets.UTF_8).length > OPS_PASSWORD_MAX_BYTES)
            return "ops password must be at most " + OPS_PASSWORD_MAX_BYTES + " bytes (BCrypt limit)";
        return null;
    }
}
