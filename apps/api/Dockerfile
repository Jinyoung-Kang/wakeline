# syntax=docker/dockerfile:1.7
# Wakeline api — Spring Boot 4.1 (Java 25)
FROM eclipse-temurin:25-jdk AS build
WORKDIR /src
COPY gradlew settings.gradle.kts build.gradle.kts ./
COPY gradle ./gradle
RUN --mount=type=cache,target=/root/.gradle ./gradlew --no-daemon -q dependencies > /dev/null
COPY src ./src
RUN --mount=type=cache,target=/root/.gradle ./gradlew --no-daemon -q bootJar -x test

FROM eclipse-temurin:25-jre
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
 && groupadd -r app && useradd -r -g app app
COPY --from=build /src/build/libs/wakeline-api.jar /app/app.jar
COPY --from=build /src/src/main/resources/schemas /app/schemas
# 힙 = 컨테이너 한도의 60% (나머지는 메타스페이스·스레드·버퍼). G1 명시, 힙 소진 시 종료 → restart 정책.
ENV JAVA_TOOL_OPTIONS="-XX:+UseG1GC -XX:MaxRAMPercentage=60 -XX:+ExitOnOutOfMemoryError" TZ=UTC
USER app
EXPOSE 8000 9000
ENTRYPOINT ["java", "-Duser.timezone=UTC", "-jar", "/app/app.jar"]
