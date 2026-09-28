#!/usr/bin/env bash
# 로컬 보안 게이트(make security, R-07) — 원격 CI 가 없어도 ci.yml 의 security · third-party-images job 과 같은 기준으로 막는다.
#   1) gitleaks: git 이력 전체(새 clone · --network none). 허용은 .gitleaksignore 의 지문(시험용 가짜 값 2건)뿐 — 하나라도 더 나오면 실패
#   2) trivy: 자체 이미지 wakeline-api·collector·web:local — 고칠 수 있는(ignore-unfixed) HIGH/CRITICAL 이 있으면 실패
#   3) trivy: compose 에 고정된 제3자 이미지 + make bench 의 k6 — 차단 여부는 ci.yml third-party-images 행렬(blocking)을 그대로 읽는다
# 이미지를 빌드하지 않는다 — 현재 코드로 스캔하려면 먼저 `make build` 한다. 스캐너 규칙(다이제스트 고정·docker.sock 없음·네트워크 없음)은 tools/scan_lib.sh.
# SCAN_OFFLINE=1 이면 trivy DB 를 받지 않고 캐시만 쓴다. SECURITY_OWN_IMAGES="이미지 …" 로 자체 이미지 태그를 바꿀 수 있다.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
# shellcheck source=tools/scan_lib.sh
. tools/scan_lib.sh
WORK="$(scan_tmpdir)" || exit 2
trap 'rm -rf "$WORK"' EXIT
fail=0
verdict() { # verdict <이름> <rc> <차단 여부 1/0>
  if [ "$2" = 0 ]; then echo "PASS  $1"
  elif [ "$3" = 1 ]; then echo "FAIL  $1"; fail=1
  else echo "WARN  $1 (보고만)"; fi
}

echo "== gitleaks (git 이력 전체, .gitleaksignore 적용)"
repo_clone "$WORK/repo" || exit 2
rc=0
"${SCAN_RUN[@]}" -v "$WORK/repo:/repo:ro" -w /repo "$GITLEAKS_IMAGE" git /repo --no-banner --redact --exit-code 1 || rc=$?
verdict gitleaks "$rc" 1

trivy_db_update || exit 2
echo "== trivy 자체 이미지 (HIGH·CRITICAL, 고칠 수 있는 것만, 차단)"
# SECURITY_OWN_IMAGES 로 다른 태그를 볼 수 있다(예: 방금 빌드한 :review-check). 기본은 compose 가 붙이는 태그.
for img in ${SECURITY_OWN_IMAGES:-wakeline-api:local wakeline-collector:local wakeline-web:local}; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then echo "FAIL  $img 이미지 없음 — make build 먼저"; fail=1; continue; fi
  rc=0; trivy_image "$img" "$WORK" --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format table || rc=$?
  verdict "trivy $img" "$rc" 1
done

echo "== trivy 제3자 이미지 (ci.yml third-party-images 행렬의 blocking 그대로)"
while read -r target blocking; do
  if [ "$target" = k6 ]; then ref="$(make -s print-K6_IMAGE)"; else ref="$(image_of "$target")"; fi
  case "$ref" in *@sha256:*) ;; *) echo "FAIL  $target: 다이제스트 고정 아님 ($ref)"; fail=1; continue ;; esac
  docker image inspect "$ref" >/dev/null 2>&1 || docker pull -q "$ref" >/dev/null || { echo "FAIL  $target: 이미지를 받지 못함"; fail=1; continue; }
  rc=0; trivy_image "$ref" "$WORK" --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format table || rc=$?
  verdict "trivy $target ($ref)" "$rc" "$blocking"
done < <(sed -nE 's/.*\{ *target: *([a-z0-9-]+), *blocking: *"([01])" *\}.*/\1 \2/p' .github/workflows/ci.yml)

[ "$fail" = 0 ] && echo "security gate: PASS" || echo "security gate: FAIL"
exit "$fail"
