# shellcheck shell=bash disable=SC2034  # 변수는 source 하는 스크립트가 쓴다
# 보안 스캐너 공용 함수 — perf/review_measure.sh(리뷰 측정)와 tools/security_gate.sh(make security)가 source 한다(R-38 · R-07).
#
# 규칙
#  - 도구 이미지는 태그+다이제스트로 고정한다(Makefile K6_IMAGE · ci.yml 의 SHA 고정과 같은 정책). 올릴 때 여기서 태그와 다이제스트를 함께 바꾼다:
#      docker buildx imagetools inspect aquasec/trivy:<새 버전> --format '{{.Manifest.Digest}}'
#  - 스캐너 컨테이너에는 docker.sock 을 넘기지 않는다. 이미지는 `docker save` 한 tar(0600, 0700 임시 디렉터리)를 --input 으로 준다.
#  - 코드·이미지를 읽는 컨테이너는 --network none 이다. 네트워크가 필요한 단계(취약점 DB 받기)는 저장소·이미지 없이 캐시 디렉터리만 마운트한다.
#  - 작업 트리를 통째로 마운트하지 않는다: git 이 추적하는 파일과 무시되지 않은 새 파일만 복사한다(.env 등 gitignore 대상은 들어가지 않는다).
#    git 이력 스캔은 저장소를 새로 clone 한 사본을 쓴다(작업 트리 파일은 없다).
# SCAN_OFFLINE=1 이면 DB 를 받지 않고 이미 있는 캐시만 쓴다(없으면 실패).

TRIVY_IMAGE="aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
SEMGREP_IMAGE="semgrep/semgrep:1.177.0@sha256:acaac22ffc7b7cc5926de0751b223bce0b2491c33d18422fa72f632c78d81198"
TRIVY_CACHE="${TRIVY_CACHE:-$HOME/.cache/trivy}"
# 스캐너 컨테이너 공통: 네트워크 없음·권한 없음·새 권한 금지
SCAN_RUN=(docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true)

# scan_tmpdir: 소유자 전용(0700) 임시 디렉터리를 만들어 경로를 출력한다
scan_tmpdir() {
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/wakeline-scan.XXXXXX")" || return 1
  chmod 700 "$d" && printf '%s\n' "$d"
}

# trivy_db_update: 취약점 DB(OS·언어 + Java)를 캐시에 받는다 — 네트워크가 필요한 유일한 단계, 캐시 디렉터리만 마운트한다
trivy_db_update() {
  if [ "${SCAN_OFFLINE:-0}" = 1 ]; then
    [ -s "$TRIVY_CACHE/db/trivy.db" ] || { echo "scan: SCAN_OFFLINE=1 인데 $TRIVY_CACHE/db/trivy.db 가 없습니다" >&2; return 1; }
    return 0
  fi
  mkdir -p "$TRIVY_CACHE"
  docker run --rm --cap-drop ALL --security-opt no-new-privileges:true -v "$TRIVY_CACHE:/root/.cache/trivy" "$TRIVY_IMAGE" \
    image --download-db-only --quiet >&2 &&
  docker run --rm --cap-drop ALL --security-opt no-new-privileges:true -v "$TRIVY_CACHE:/root/.cache/trivy" "$TRIVY_IMAGE" \
    image --download-java-db-only --quiet >&2
}

# trivy_image <이미지> <작업 디렉터리> [trivy 인자...]: docker save → tar 를 네트워크 없는 trivy 로 스캔(결과는 표준 출력)
trivy_image() {
  local img=$1 work=$2; shift 2
  local tar="$work/image-$$.tar" rc=0
  ( umask 077; docker save "$img" -o "$tar" ) || return 2
  "${SCAN_RUN[@]}" -v "$work:/in:ro" -v "$TRIVY_CACHE:/root/.cache/trivy:ro" "$TRIVY_IMAGE" \
    image --input "/in/$(basename "$tar")" --skip-db-update --skip-java-db-update --offline-scan --cache-backend memory \
    --scanners vuln --quiet "$@" || rc=$?
  rm -f "$tar"
  return "$rc"
}

# repo_copy <대상 디렉터리>: 추적 파일 + 무시되지 않은 새 파일만 복사한다(.env·빌드 산출물·node_modules 제외). .env 가 섞이면 실패
repo_copy() {
  local dest=$1
  mkdir -p "$dest"
  git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done |
    tar --null -T - -cf - | tar -xf - -C "$dest" || return 1
  if [ -n "$(find "$dest" -name '.env' -o -name '*.env.local' | head -1)" ]; then echo "scan: 복사본에 .env 가 있습니다 — 중단" >&2; return 1; fi
}

# repo_clone <대상 디렉터리>: 이력 스캔용 새 clone(작업 트리의 무시된 파일은 없다)
repo_clone() {
  git clone -q --no-hardlinks "$(git rev-parse --show-toplevel)" "$1"
}

# image_of <compose 서비스>: infra/compose.yml 에 고정된 이미지(태그@다이제스트) — infra/tests 와 같은 방식
image_of() {
  awk -v s="  $1:" '$0==s{f=1;next} f && $1=="image:"{print $2; exit}' infra/compose.yml
}
