# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# 기반·도구 이미지(FROM · COPY --from · syntax)는 태그@다이제스트로 고정(R-85). 올릴 때: docker buildx imagetools inspect <태그> --format '{{.Manifest.Digest}}'
# Wakeline api — Spring Boot 4.1 (Java 25)
FROM eclipse-temurin:25-jdk@sha256:119a3d18f160a3e7655a66034d0f43beee31cd7b3b9142d57a5de29772011de6 AS build
WORKDIR /src
COPY gradlew settings.gradle.kts build.gradle.kts ./
COPY gradle ./gradle
RUN --mount=type=cache,target=/root/.gradle ./gradlew --no-daemon -q dependencies > /dev/null
COPY src ./src
RUN --mount=type=cache,target=/root/.gradle ./gradlew --no-daemon -q bootJar -x test

FROM eclipse-temurin:25-jre@sha256:8da0490fa9a3c26867012019565948eef0ee69438f5c75ac28146967bae984b5
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
 && groupadd -r app && useradd -r -g app app
COPY --from=build /src/build/libs/wakeline-api.jar /app/app.jar
COPY --from=build /src/src/main/resources/schemas /app/schemas
# 힙 = 컨테이너 한도의 40 %(R-25 · ADR-017 §4: compose 한도 1g → 약 410 MiB, NFR-03 512 MB 안. GC 뒤 살아 있는 데이터는 약 75 MiB, 부하 중 힙 최대 약 220 MiB).
# 나머지는 메타스페이스·코드 캐시·스레드·직접 버퍼. G1 명시, 힙 소진 시 종료 → restart 정책.
# MALLOC_ARENA_MAX=2(R-25 후속): 힙 비율만으로는 RSS 가 610–628 MiB 였다. NMT 가 센 JVM 메모리는 427 MiB(힙 213 · 메타스페이스 73 · GC 46 · 코드 36 …)이고
# 나머지 약 160 MiB 는 glibc 가 스레드별 malloc 아레나에 쥐고 있던 메모리였다. 아레나를 2개로 묶으면 경합 기록이 없는 k6 실행에서 497–501 MiB(실측, docs/review/VERIFICATION.md).
ENV JAVA_TOOL_OPTIONS="-XX:+UseG1GC -XX:MaxRAMPercentage=40 -XX:+ExitOnOutOfMemoryError" MALLOC_ARENA_MAX=2 TZ=UTC
USER app
EXPOSE 8000 9000
ENTRYPOINT ["java", "-Duser.timezone=UTC", "-jar", "/app/app.jar"]
