package dev.skywx;

import dev.skywx.config.AppProperties;
import dev.skywx.ops.OpsUserService;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.util.Arrays;

/** SkyWx api — 스트림 소비·인메모리 스냅샷·공간 판정·WebSocket 팬아웃·REST·운영 API. 외부 API 는 절대 직접 부르지 않는다(ADR-006). */
@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(AppProperties.class)
public class SkyWxApplication {

    public static void main(String[] args) {
        if (Arrays.asList(args).contains("--migrate")) {
            // 한 번 실행하고 끝나는 마이그레이션(compose 의 migrate 서비스). DDL 권한 계정(skywx_migrator)은 이 프로세스에만 있다.
            var app = new SpringApplication(SkyWxApplication.class);
            app.setAdditionalProfiles("migrate");
            try (ConfigurableApplicationContext ctx = app.run("--spring.main.web-application-type=none", "--spring.flyway.enabled=true")) {
                System.out.println("migrations applied");
            }
            return;
        }
        if (Arrays.asList(args).contains("--create-ops-user")) {
            // 운영자 계정 생성: 비밀번호는 환경변수(SKYWX_OPS_PASSWORD)로만 — 소스·로그에 남지 않는다.
            var app = new SpringApplication(SkyWxApplication.class);
            app.setAdditionalProfiles("cli");
            try (ConfigurableApplicationContext ctx = app.run("--spring.main.web-application-type=none", "--spring.flyway.enabled=false")) {
                String user = System.getenv().getOrDefault("SKYWX_OPS_USER", "admin");
                String password = System.getenv("SKYWX_OPS_PASSWORD");
                if (password == null || password.length() < 12) {
                    System.err.println("SKYWX_OPS_PASSWORD must be at least 12 characters");
                    System.exit(2);
                }
                ctx.getBean(OpsUserService.class).upsert(user, password);
                System.out.println("ops user '" + user + "' ready");
            }
            return;
        }
        SpringApplication.run(SkyWxApplication.class, args);
    }
}
