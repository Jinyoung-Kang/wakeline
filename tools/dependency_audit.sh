#!/usr/bin/env bash
# 의존성 감사(make security 의 한 단계 · S2 · M-2) — 원격이 없어 돈 적이 없는 ci.yml 의 두 감사를 같은 명령으로 로컬에서 돌린다:
#   1) web(ci.yml web job): npm audit --audit-level=high — apps/web 의 package-lock.json 전체(dev 포함), High 이상이 있으면 실패
#   2) collector(ci.yml collector job): uv.lock 의 런타임 의존성을 해시 고정 requirements 로 내보내 pip-audit(같은 버전 · 같은 옵션)
# 둘 다 네트워크가 필요하다(npm 레지스트리 · PyPI 취약점 DB, uvx 가 pip-audit 를 받는다).
#   SCAN_OFFLINE=1 이면 돌리지 않고 SKIP 을 알린다 — 이번 실행은 의존성을 감사하지 않았다는 뜻이다.
#   그 밖에는 돌리지 못한 것(도구 없음 · 네트워크 실패 · lock 불일치)도 실패다(fail closed). 한쪽이 실패해도 다른 쪽은 돈다.
# 명령이 ci.yml 과 같은지는 infra/tests/test_ci_policy.py 가 확인한다 — 한쪽을 바꾸면 다른 쪽도 바꾼다.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
PIP_AUDIT_VERSION=2.10.1   # ci.yml collector job 과 같은 버전

if [ "${SCAN_OFFLINE:-0}" = 1 ]; then
  echo "SKIP  npm audit · pip-audit — SCAN_OFFLINE=1 (레지스트리 · 취약점 DB 에 닿아야 한다 — 이번 실행은 의존성을 감사하지 않았다)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wakeline-audit.XXXXXX")" || exit 2
trap 'rm -rf "$WORK"' EXIT
fail=0
result() { # result <이름> <rc>
  if [ "$2" = 0 ]; then echo "PASS  $1"; else echo "FAIL  $1 (exit $2 — 취약점이 있거나 돌리지 못했다)"; fail=1; fi
}

echo "-- npm audit (apps/web, High 이상)"
rc=0; (cd apps/web && npm audit --audit-level=high) || rc=$?
result "npm audit (apps/web, --audit-level=high)" "$rc"

echo "-- pip-audit $PIP_AUDIT_VERSION (apps/collector 런타임 의존성, uv.lock 해시 고정)"
rc=0
(cd apps/collector &&
  uv export --locked --no-dev --no-emit-project --format requirements-txt -o "$WORK/requirements.txt" >/dev/null &&   # 파일에만(화면에 같은 내용을 또 찍는다)
  uvx "pip-audit@$PIP_AUDIT_VERSION" --disable-pip --require-hashes -r "$WORK/requirements.txt" --progress-spinner off) || rc=$?
result "pip-audit (apps/collector 런타임)" "$rc"

exit "$fail"
