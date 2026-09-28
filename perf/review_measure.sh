#!/bin/bash
# 리뷰 기준선·재측정(docs/review/BASELINE.md · VERIFICATION.md 의 전/후 표). 같은 명령으로 두 번 돌려 비교한다.
#   bash perf/review_measure.sh <label>          # 예: baseline, after
# 결과: perf/results/review-<label>/ (원자료) + summary.tsv(항목<TAB>값). 비밀값은 출력하지 않는다.
# 개발 스택(8700)이 떠 있어야 하는 항목(Lighthouse · 런타임 지표)은 스택이 없으면 건너뛰고 그렇게 적는다.
# 외부로 나가는 것: 도구 이미지·패키지 내려받기(없을 때 한 번), semgrep 규칙 파일(호스트 curl, 코드는 보내지 않음), trivy 취약점 DB(캐시만 마운트한 컨테이너).
# 스캐너 격리(R-38, tools/scan_lib.sh): 도구 이미지는 태그+다이제스트 고정, docker.sock 을 넘기지 않고(docker save → --input),
#   코드·이미지를 읽는 컨테이너는 --network none, 작업 트리 대신 git 추적 파일 사본(.env 등 무시된 파일 없음)만 마운트한다.
# SCAN_OFFLINE=1 이면 semgrep 규칙·trivy DB 를 받지 않고 있는 것만 쓴다.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
# shellcheck source=tools/scan_lib.sh
. tools/scan_lib.sh
WORK="$(scan_tmpdir)" || exit 2
trap 'rm -rf "$WORK"' EXIT
LABEL="${1:?label required}"
OUT="perf/results/review-$LABEL"; mkdir -p "$OUT"
SUM="$OUT/summary.tsv"; : > "$SUM"
put() { printf '%s\t%s\n' "$1" "$2" | tee -a "$SUM"; }
BASE="${WAKELINE_BASE_URL:-http://localhost:8700}"
up() { curl -s -m 3 -o /dev/null -w '%{http_code}' "$BASE/healthz" 2>/dev/null | grep -q 200; }

echo "== 1. 시험·커버리지"
(cd apps/collector && uv run pytest -q --cov=wakeline_collector --cov-report=term 2>&1 | tail -3) > "$OUT/pytest.txt"
put "collector pytest" "$(grep -Eo '[0-9]+ passed[^ ]*( [0-9]+ skipped)?' "$OUT/pytest.txt" | head -1) · cov $(grep -Eo 'Total coverage: [0-9.]+%' "$OUT/pytest.txt" | grep -Eo '[0-9.]+%' || grep -E '^TOTAL' "$OUT/pytest.txt" | awk '{print $NF}')"
(cd apps/api && ./gradlew -q test jacocoTestReport jacocoTestCoverageVerification > "../../$OUT/gradle-test.txt" 2>&1); rc=$?
python3 - "$OUT" "$rc" <<'EOF' | while IFS=$'\t' read -r k v; do put "$k" "$v"; done
import glob, sys, xml.etree.ElementTree as ET
t=f=e=s=0
for p in glob.glob("apps/api/build/test-results/test/*.xml"):
    r=ET.parse(p).getroot(); t+=int(r.get("tests")); f+=int(r.get("failures")); e+=int(r.get("errors")); s+=int(r.get("skipped"))
cov={}
try:
    r=ET.parse("apps/api/build/reports/jacoco/test/jacocoTestReport.xml").getroot()
    cov={c.get("type"): 100*int(c.get("covered"))/(int(c.get("missed"))+int(c.get("covered"))) for c in r.findall("counter")}
except Exception: pass
print(f"api junit\t{t} tests · {f} failures · {e} errors · {s} skipped (gradle rc {sys.argv[2]})")
print(f"api jacoco\tLINE {cov.get('LINE',0):.1f}% · BRANCH {cov.get('BRANCH',0):.1f}%")
EOF
(cd apps/web && npx vitest run > "../../$OUT/vitest.txt" 2>&1)
put "web vitest" "$(grep -E '^\s+Tests ' "$OUT/vitest.txt" | sed 's/^ *//')"
if (cd apps/web && npm i --no-save --no-audit --no-fund @vitest/coverage-v8@"$(node -p "require('vitest/package.json').version")" >/dev/null 2>&1); then
  (cd apps/web && npx vitest run --coverage --coverage.reporter=text-summary > "../../$OUT/vitest-cov.txt" 2>&1)
  put "web vitest coverage" "$(grep -E 'Lines|Branches' "$OUT/vitest-cov.txt" | sed 's/  */ /g' | tr '\n' ' ')"
else put "web vitest coverage" "측정 못 함(@vitest/coverage-v8 설치 실패)"; fi

echo "== 2. 린트·정적 분석"
(cd apps/collector && uv run ruff check . > "../../$OUT/ruff.txt" 2>&1; uv run ruff format --check . >> "../../$OUT/ruff.txt" 2>&1; uv run mypy wakeline_collector > "../../$OUT/mypy.txt" 2>&1)
put "ruff" "$(grep -E 'All checks passed|Found [0-9]+ error' "$OUT/ruff.txt" | head -1) · $(grep -E 'already formatted|would reformat' "$OUT/ruff.txt" | head -1)"
put "mypy" "$(tail -1 "$OUT/mypy.txt")"
(cd apps/web && npx eslint . -f json -o "../../$OUT/eslint.json" >/dev/null 2>&1; npx tsc --noEmit > "../../$OUT/tsc.txt" 2>&1)
put "eslint" "$(python3 -c "import json;d=json.load(open('$OUT/eslint.json'));print(sum(f['errorCount'] for f in d),'errors ·',sum(f['warningCount'] for f in d),'warnings')")"
put "tsc" "$( [ -s "$OUT/tsc.txt" ] && echo "$(grep -c 'error TS' "$OUT/tsc.txt") errors" || echo '0 errors')"
# Java: 정적 분석 도구가 구성돼 있지 않다 — javac -Xlint:all 경고 수를 센다(빌드 설정은 바꾸지 않고 명령행 인자로)
(cd apps/api && ./gradlew -q -I ../../perf/xlint.init.gradle compileJava --rerun-tasks > "../../$OUT/javac.txt" 2>&1)
put "javac -Xlint:all 경고" "$(grep -c 'warning:' "$OUT/javac.txt")"
# semgrep: 규칙 묶음을 먼저 파일로 받고(호스트 curl — CLI 의 p/<이름> 과 같은 주소 https://semgrep.dev/c/p/<이름>),
# 스캔은 네트워크 없는 컨테이너에서 git 추적 파일 사본만 읽는다. 받은 규칙은 결과 폴더에 남겨 같은 규칙으로 다시 돌릴 수 있게 한다.
# docs/ 는 실행되지 않는 문서라 뺀다(ADR 본문의 nginx 예시 문장이 설정으로 잡혔다 — 리뷰 4단계).
SRC="$WORK/src"; repo_copy "$SRC" || SRC=""
RULES="$OUT/semgrep-rules"; mkdir -p "$RULES"
if [ "${SCAN_OFFLINE:-0}" != 1 ]; then
  for p in owasp-top-ten java python typescript nginx dockerfile; do
    curl -fsSL --max-time 60 "https://semgrep.dev/c/p/$p" -o "$RULES/$p.yml" || rm -f "$RULES/$p.yml"
  done
fi
cfg=(); for f in "$RULES"/*.yml; do [ -e "$f" ] && cfg+=(--config "/rules/$(basename "$f")"); done
"${SCAN_RUN[@]}" "$SEMGREP_IMAGE" semgrep --version > "$OUT/semgrep.version" 2>&1
if [ -n "$SRC" ] && [ ${#cfg[@]} -gt 0 ]; then
  "${SCAN_RUN[@]}" -v "$SRC:/src:ro" -v "$PWD/$RULES:/rules:ro" -w /src "$SEMGREP_IMAGE" semgrep scan --metrics=off --disable-version-check --quiet --json \
    "${cfg[@]}" --exclude perf/results --exclude fixtures --exclude docs . > "$OUT/semgrep.json" 2> "$OUT/semgrep.err"
  put "semgrep" "$(python3 -c "
import json,collections
d=json.load(open('$OUT/semgrep.json')); c=collections.Counter(r['extra']['severity'] for r in d.get('results',[]))
print(len(d.get('results',[])),'findings',dict(c),'· errors',len(d.get('errors',[])),'· 규칙 묶음 $(ls "$RULES" | wc -l | tr -d ' ')개')" 2>/dev/null || echo '측정 못 함')"
else put "semgrep" "측정 못 함(규칙 파일 또는 작업 트리 사본 없음)"; fi

echo "== 3. 의존성 취약점·비밀값"
(cd apps/web && npm audit --json > "../../$OUT/npm-audit.json" 2>/dev/null)
put "npm audit" "$(python3 -c "import json;v=json.load(open('$OUT/npm-audit.json'))['metadata']['vulnerabilities'];print(', '.join(f'{k} {v[k]}' for k in ('critical','high','moderate','low')))")"
(cd apps/collector && uv export --frozen --no-dev --no-emit-project --format requirements-txt > "../../$OUT/requirements.txt" 2>/dev/null && uvx pip-audit@2.10.1 --disable-pip --require-hashes -r "../../$OUT/requirements.txt" --progress-spinner off -f json > "../../$OUT/pip-audit.json" 2> "../../$OUT/pip-audit.err")
put "pip-audit" "$(python3 -c "import json;d=json.load(open('$OUT/pip-audit.json'));print(sum(len(x['vulns']) for x in d['dependencies']),'vulns in',len(d['dependencies']),'packages')" 2>/dev/null || echo '측정 못 함')"
trivy_db_update 2> "$OUT/trivy-db.err" || put "trivy DB" "갱신 실패 — 캐시로 진행($TRIVY_CACHE)"
for img in wakeline-api:local wakeline-web:local wakeline-collector:local; do
  n="${img%%:*}"
  trivy_image "$img" "$WORK" --severity CRITICAL,HIGH,MEDIUM,LOW --format json > "$OUT/trivy-$n.json" 2> "$OUT/trivy-$n.err"
  put "trivy $img" "$(python3 -c "
import json,collections
d=json.load(open('$OUT/trivy-$n.json')); c=collections.Counter(v['Severity'] for r in d.get('Results',[]) for v in (r.get('Vulnerabilities') or []))
print(', '.join(f'{k} {c.get(k,0)}' for k in ('CRITICAL','HIGH','MEDIUM','LOW')))" 2>/dev/null || echo '측정 못 함')"
done
# gitleaks: 새 clone(이력만)을 네트워크 없이. .gitleaksignore(정확한 지문만)는 CI 와 같이 적용된다(-w /repo).
if repo_clone "$WORK/repo"; then
  "${SCAN_RUN[@]}" -v "$WORK/repo:/repo:ro" -w /repo "$GITLEAKS_IMAGE" git /repo --no-banner --report-format json --report-path - --exit-code 0 \
    > "$OUT/gitleaks.json" 2> "$OUT/gitleaks.log"
fi
put "gitleaks(git 이력 전체, .gitleaksignore 적용)" "$(python3 -c "import json;d=json.load(open('$OUT/gitleaks.json'));print(len(d),'findings')" 2>/dev/null || echo '측정 못 함')"
if [ -n "$SRC" ]; then
  "${SCAN_RUN[@]}" -v "$SRC:/src:ro" "$TRIVY_IMAGE" fs --quiet --scanners secret --skip-db-update --offline-scan --cache-backend memory \
    --format json /src > "$OUT/trivy-secret.json" 2> "$OUT/trivy-secret.err"
fi
put "trivy secret(git 추적 파일 사본 — .env 없음)" "$(python3 -c "import json;d=json.load(open('$OUT/trivy-secret.json'));print(sum(len(r.get('Secrets') or []) for r in d.get('Results',[])),'findings')" 2>/dev/null || echo '측정 못 함')"

echo "== 4. 프론트엔드 번들"
(cd apps/web && NEXT_TELEMETRY_DISABLED=1 npx next build > "../../$OUT/next-build.txt" 2>&1)
python3 - "$OUT" <<'EOF' | while IFS=$'\t' read -r k v; do put "$k" "$v"; done
import gzip, os, sys, glob
root="apps/web/.next/static"
tot=gz=0; js=[]
for p in glob.glob(root+"/**/*", recursive=True):
    if os.path.isfile(p) and p.endswith((".js",".css")):
        b=open(p,"rb").read(); tot+=len(b); g=len(gzip.compress(b,6)); gz+=g
        if p.endswith(".js"): js.append((g,p))
js.sort(reverse=True)
print(f"web static js+css\t{tot/1024:.0f} KiB · gzip {gz/1024:.0f} KiB · 파일 {len(js)}개")
print(f"web 가장 큰 js 3개(gzip)\t" + " · ".join(f"{os.path.basename(p)} {g/1024:.0f} KiB" for g,p in js[:3]))
EOF

echo "== 5. Lighthouse(데스크톱, 성능·접근성) — 개발 스택 필요"
if up; then
  CHROME="$(cd apps/web && node -e "console.log(require('@playwright/test').chromium.executablePath())")"
  for path in / /about /stats /ops; do
    n=$(echo "$path" | tr '/' '_'); [ "$n" = "_" ] && n="_root"
    CHROME_PATH="$CHROME" npx --yes lighthouse@12 "$BASE$path" --preset=desktop --only-categories=performance,accessibility,best-practices \
      --chrome-flags="--headless=new --use-angle=swiftshader" --output=json --output-path="$OUT/lh$n.json" --quiet > /dev/null 2>&1
    put "lighthouse $path" "$(python3 -c "
import json;d=json.load(open('$OUT/lh$n.json'));c=d['categories'];a=d['audits']
print('perf',round(c['performance']['score']*100),'· a11y',round(c['accessibility']['score']*100),'· best',round(c['best-practices']['score']*100),
'· LCP %.1fs'%(a['largest-contentful-paint']['numericValue']/1000),'· TBT %dms'%a['total-blocking-time']['numericValue'],'· CLS %.3f'%a['cumulative-layout-shift']['numericValue'])" 2>/dev/null || echo '측정 못 함')"
  done
else put "lighthouse" "건너뜀(개발 스택이 떠 있지 않음)"; fi

echo "== 6. 런타임(개발 스택)"
if up; then
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | grep wakeline- | sort > "$OUT/docker-stats.txt"
  put "컨테이너 메모리" "$(awk -F'\t' '{split($2,a," / "); printf "%s %s · ", $1, a[1]}' "$OUT/docker-stats.txt")"
  docker run --rm -i --network wakeline_wakeline --entrypoint python wakeline-collector:local - < perf/actuator_probe.py > "$OUT/actuator.txt" 2>&1
  put "api 지표(기동 이후)" "$(tail -1 "$OUT/actuator.txt")"
else put "런타임" "건너뜀(개발 스택이 떠 있지 않음)"; fi
echo; echo "summary: $SUM"
