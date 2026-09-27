plugins {
    // 로컬에 JDK 25 가 없어도 툴체인이 자동으로 내려받는다(~/.gradle/jdks). Docker 빌드는 temurin 이미지를 쓴다.
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}
rootProject.name = "wakeline-api"
