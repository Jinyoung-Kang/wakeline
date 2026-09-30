# R-63 · ADR-004 재결정(2026-09-30): db 이미지를 공식 postgres(Debian trixie — arm64 · amd64)에 PGDG 의 PostGIS 3.6 패키지를 얹어 직접 만든다.
# 이전 imresamu/postgis:18-3.6 은 2026-02-09 이후 재빌드되지 않아 고칠 수 있는 CVE 가 쌓였다(REVIEW-v1 R-63 — 고유 CRITICAL 9 · HIGH 76).
# 공식 이미지는 자주 다시 빌드되고 Dependabot(docker · /infra/db)이 다이제스트를 올린다. 기반이 같은 Debian 13(glibc 2.41 — 문자열 정렬
# en_US.utf8 그대로)이고 같은 메이저(18) · 같은 PostGIS 3.6 이라 기존 볼륨을 그대로 쓴다(데이터 디렉터리 /var/lib/postgresql/18/docker —
# 공식 18 이미지의 기본값, 이전 이미지도 같다). 새 PostGIS 부 버전의 SQL 쪽은 한 번 `make db-postgis-update`(슈퍼유저 · 로컬 소켓).
FROM postgres:18-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722

# PostGIS 는 3.6.x 로 묶는다: 3.7 은 확장 갱신이 필요한 결정이라 다이제스트 갱신만으로 조용히 넘어가지 않게.
# apt-get upgrade: 기반 이미지가 나온 뒤 고쳐진 Debian 보안 갱신까지(빌드 때마다 — Trivy 게이트가 결과를 본다).
# gosu 삭제: 엔트리포인트는 root 로 시작할 때만 gosu 로 postgres 가 된다 — 처음부터 postgres(999)로 돌리므로 필요 없고,
#   그 안의 Go 표준 라이브러리가 고칠 수 있는 CVE(CRITICAL 1 · HIGH 21, 2026-09-30 Trivy)의 전부였다.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends 'postgresql-18-postgis-3=3.6.*' 'postgresql-18-postgis-3-scripts=3.6.*'; \
    apt-get upgrade -y --no-install-recommends; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f /usr/local/bin/gosu

# 엔트리포인트의 '--user 로 시작' 경로(공식 이미지 문서) — 데이터 디렉터리는 이미 999 소유(이전 이미지도 999)
USER postgres
