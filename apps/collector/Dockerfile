# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# 기반·도구 이미지(FROM · COPY --from · syntax)는 태그@다이제스트로 고정(R-85). 올릴 때: docker buildx imagetools inspect <태그> --format '{{.Manifest.Digest}}'
# Wakeline collector — Python 3.13 + uv. 빌드 컨텍스트는 저장소 루트(schemas/·fixtures/ 를 함께 넣기 위해)
FROM python:3.13-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS build
COPY --from=ghcr.io/astral-sh/uv:0.8@sha256:1d31be550ff927957472b2a491dc3de1ea9b5c2d319a9cea5b6a48021e2990a6 /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY apps/collector/pyproject.toml apps/collector/uv.lock* ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --no-dev --no-install-project
COPY apps/collector/wakeline_collector ./wakeline_collector
RUN --mount=type=cache,target=/root/.cache/uv uv sync --no-dev

FROM python:3.13-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b
# 앱은 .venv(빌드 단계에서 uv 가 만든다)만 쓴다. 기반 이미지의 시스템 pip 는 지운다 — 쓰이지 않으면서
# pip 가 품은 패키지(msgpack·setuptools)가 이미지의 고칠 수 있는 HIGH 취약점 전부였다(R-29).
RUN python -m pip uninstall -y pip \
 && groupadd -r app && useradd -r -g app -d /app app && mkdir -p /data/raw && chown app:app /data/raw
WORKDIR /app
COPY --from=build --chown=app:app /app /app
COPY --chown=app:app schemas /app/schemas
COPY --chown=app:app fixtures /app/fixtures
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 TZ=UTC
USER app
# 계약 §8: 관심 지역 heartbeat(wakeline:collector.region_at)가 90 s 안이면 정상. compose 의 healthcheck 가 있으면 그쪽이 우선한다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["python", "-m", "wakeline_collector.health"]
ENTRYPOINT ["python", "-m", "wakeline_collector"]
