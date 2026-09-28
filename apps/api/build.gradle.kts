plugins {
    java
    jacoco
    id("org.springframework.boot") version "4.1.1"
}

group = "dev.wakeline"
version = "0.2.0"

java {
    toolchain { languageVersion = JavaLanguageVersion.of(25) }
}

repositories { mavenCentral() }

// R-37: Boot 4.1.1 BOM 의 Tomcat 11.0.24 에 CRITICAL CVE 3건(CVE-2026-65182 · 65905 · 68525, 11.0.25 에서 수정)이 있다.
// 이 빌드는 platform(BOM) 방식이라(io.spring.dependency-management 없음) extra["tomcat.version"] 이 먹지 않는다 — 제약으로 올린다.
// Boot 패치가 11.0.25 이상을 가져오면 이 블록을 지운다(TomcatVersionTest 가 하한을 지킨다).
val tomcatVersion = "11.0.26"

dependencies {
    implementation(platform(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES))
    constraints {
        for (m in listOf("tomcat-embed-core", "tomcat-embed-el", "tomcat-embed-websocket"))
            implementation("org.apache.tomcat.embed:$m:$tomcatVersion") { because("R-37: CVE-2026-65182/65905/68525 fixed in 11.0.25") }
    }

    implementation("org.springframework.boot:spring-boot-starter-webmvc")
    implementation("org.springframework.boot:spring-boot-starter-websocket")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("org.springframework.boot:spring-boot-starter-actuator")
    implementation("io.micrometer:micrometer-registry-prometheus")
    implementation("org.springframework.boot:spring-boot-starter-security")
    implementation("org.springframework.boot:spring-boot-starter-session-data-redis")
    implementation("org.springframework.boot:spring-boot-starter-data-redis")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-flyway")
    implementation("org.flywaydb:flyway-database-postgresql")
    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:3.1.1")
    implementation("org.locationtech.jts:jts-core:1.20.0")
    implementation("com.networknt:json-schema-validator:1.5.8")
    runtimeOnly("org.postgresql:postgresql")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")
    testImplementation("org.springframework.boot:spring-boot-starter-security-test")
    testImplementation("org.springframework.boot:spring-boot-testcontainers")
    testImplementation("org.testcontainers:testcontainers-junit-jupiter")
    testImplementation("org.testcontainers:testcontainers-postgresql")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile> {
    options.encoding = "UTF-8"
    options.compilerArgs.addAll(listOf("-parameters", "-Xlint:deprecation"))
}

// 통합 테스트(Testcontainers)는 운영과 같은 초기화 스크립트(infra/db/init, infra/redis)와 커밋된 OpenAPI 스냅샷을 읽는다 —
// 그 파일이 바뀌면 테스트를 다시 돌린다(입력으로 선언).
val itInputs = files("../../infra/db/init/01-roles.sh", "../../infra/redis/start.sh", "../../infra/redis/redis.conf", "openapi/openapi-v1.json")
// WS 메시지 계약(계약 v5 §E1 · ADR-020): WsSchemaContractTest 가 저장소 루트의 스키마를 읽고, 커밋된 웹 fixture 와 비교한다(시험 전용 — 클래스패스 복사본 없음)
val wsContractInputs = files("../../schemas/ws/server.v1.json", "../../schemas/ws/client.v1.json", "../../schemas/aircraft_state.v1.json",
    "../../schemas/ship_state.v1.json", "../../schemas/ship_static.v1.json", "../../schemas/vectors/ship-categories.v1.json",
    "../web/tests/fixtures/ws-samples.v1.json")
// 로그의 언어 간 시험 벡터: 억제(계약 v5 §G9, LogSinkTest) · 가림(§C5, LogMaskerTest) — 저장소 루트의 파일을 읽는다(pytest 도 같은 파일)
val logVectorInputs = files("../../schemas/vectors/log-suppression.v1.json", "../../schemas/vectors/masking-cases.v1.json")

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    jvmArgs("-Duser.timezone=UTC", "-Dfile.encoding=UTF-8")
    inputs.files(itInputs).withPathSensitivity(PathSensitivity.RELATIVE).withPropertyName("itInputs")
    inputs.files(wsContractInputs).withPathSensitivity(PathSensitivity.RELATIVE).withPropertyName("wsContractInputs")
    inputs.files(logVectorInputs).withPathSensitivity(PathSensitivity.RELATIVE).withPropertyName("logVectorInputs")
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

tasks.test {
    // -PupdateOpenApi: OpenApiSnapshotIT 가 비교 대신 스냅샷을 다시 쓴다
    systemProperty("wakeline.openapi.update", providers.gradleProperty("updateOpenApi").map { it != "false" }.getOrElse(false).toString())
    // -PupdateWsSamples: WsSchemaContractTest 가 비교 대신 apps/web/tests/fixtures/ws-samples.v1.json 을 다시 쓴다(make ws-samples)
    systemProperty("wakeline.ws-samples.update", providers.gradleProperty("updateWsSamples").map { it != "false" }.getOrElse(false).toString())
    finalizedBy(tasks.jacocoTestReport)
}

// OpenAPI 스냅샷 갱신(REST 계약을 의도적으로 바꿨을 때): ./gradlew updateOpenApi → apps/api/openapi/openapi-v1.json 을 커밋한다
tasks.register<Test>("updateOpenApi") {
    description = "Regenerates openapi/openapi-v1.json from the running application (Testcontainers)."
    group = "verification"
    testClassesDirs = sourceSets.test.get().output.classesDirs
    classpath = sourceSets.test.get().runtimeClasspath
    filter { includeTestsMatching("dev.wakeline.it.OpenApiSnapshotIT") }
    systemProperty("wakeline.openapi.update", "true")
    outputs.upToDateWhen { false }
}

// 커버리지(NFR-14): CI·make test-api 가 jacocoTestReport·jacocoTestCoverageVerification 을 부른다. Java 25 클래스 파일은 JaCoCo 0.8.14 이상.
jacoco { toolVersion = "0.8.14" }

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports {
        xml.required = true
        html.required = true
    }
}

tasks.jacocoTestCoverageVerification {
    dependsOn(tasks.test)
    violationRules {
        // 바닥값(래칫): 실제 측정값을 내림한 값 — 떨어지면 실패. 설계 목표(NFR-14)는 라인 80 %.
        // 측정 2026-09-27~28(깨끗한 실행 6회): LINE 93.4~93.9 %, BRANCH 74.1~74.7 % — Docker 로 통합 테스트(Testcontainers) 포함.
        // 측정 2026-09-28 수요 추적·선박(ADR-013/014) 통합 테스트 추가 뒤(깨끗한 실행 3회, 378 테스트): LINE 95.40~95.42 %, BRANCH 81.03~81.08 %
        //   (직전 단계 366 테스트: LINE 95.40 %, BRANCH 80.88 %) → LINE 0.93 → 0.95, BRANCH 바닥 0.80 추가.
        // Docker 가 없으면 Testcontainers 테스트가 건너뛰어져 커버리지가 낮아지고 이 검증은 실패한다(CI 러너에는 Docker 가 있다).
        rule {
            limit { counter = "LINE"; minimum = "0.95".toBigDecimal() }
            limit { counter = "BRANCH"; minimum = "0.80".toBigDecimal() }
        }
    }
}

tasks.check { dependsOn(tasks.jacocoTestCoverageVerification) }

tasks.bootJar { archiveFileName = "wakeline-api.jar" }
tasks.jar { enabled = false }
