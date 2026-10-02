# edge(nginx) — 상류 nginxinc/nginx-unprivileged(비root uid 101) 를 다이제스트로 고정하고, 빌드 때 Alpine 보안 갱신만 얹는다.
# 상류는 Alpine 패키지가 고쳐진 뒤 다시 빌드하기까지 며칠 걸린다 — 그동안 고칠 수 있는 HIGH 가 운영 edge 에 남지 않게(2026-10-02 CI trivy: pcre2
# CVE-2026-103111, 고친 판 10.49-r0 — 상류 1.30-alpine 다이제스트는 그대로였다). 다른 자체 이미지(apt-get upgrade)와 같은 방식, Trivy 게이트가 결과를 본다.
# 설정 파일은 compose 가 읽기 전용으로 붙인다(infra/compose.yml) — 이미지에 넣지 않는다.
FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:ed04ec1ff34502c339ee5c3ae3f855442398edc1d05591e2b98981dcbbd20b1e
USER root
RUN apk upgrade --no-cache
USER 101
