# syntax=docker/dockerfile:1.7
# Wakeline collector — Python 3.13 + uv. 빌드 컨텍스트는 저장소 루트(schemas/·fixtures/ 를 함께 넣기 위해)
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY apps/collector/pyproject.toml apps/collector/uv.lock* ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --no-dev --no-install-project
COPY apps/collector/wakeline_collector ./wakeline_collector
RUN --mount=type=cache,target=/root/.cache/uv uv sync --no-dev

FROM python:3.13-slim
RUN groupadd -r app && useradd -r -g app -d /app app && mkdir -p /data/raw && chown app:app /data/raw
WORKDIR /app
COPY --from=build --chown=app:app /app /app
COPY --chown=app:app schemas /app/schemas
COPY --chown=app:app fixtures /app/fixtures
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 TZ=UTC
USER app
# 계약 §8: 관심 지역 heartbeat(wakeline:collector.region_at)가 90 s 안이면 정상. compose 의 healthcheck 가 있으면 그쪽이 우선한다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["python", "-m", "wakeline_collector.health"]
ENTRYPOINT ["python", "-m", "wakeline_collector"]
