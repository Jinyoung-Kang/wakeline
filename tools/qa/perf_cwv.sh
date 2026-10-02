#!/usr/bin/env bash
# 화면 성능 과제(QA-402 · QA-403, PERF §15): Lighthouse 12.8.2 로 격리 스택 A(8701)의 화면을 GPU 방식 하나 · 바깥 호스트 규칙 하나로 잰다.
#   tools/qa/perf_cwv.sh <이름표> <gpu|swgl> <none|ofm> [반복=3] [화면 …]
# - gpu : --headless=new --use-angle=metal --enable-gpu(실제 GPU — WebGL 렌더러 "ANGLE Metal Renderer: Apple M1")
#   swgl: --headless=new --use-angle=swiftshader(소프트웨어 GL — 렌더러 "SwiftShader Device (LLVM 10.0.0)", QA 2026-10 과 같은 플래그).
#   주의: --headless 만 주면 이 Mac 의 Chrome for Testing 153 은 실제 GPU(Metal)를 쓴다(2026-10-02 확인 — PERF §15) — 소프트웨어 GL 이 아니다.
# - none: 바깥 호스트를 모두 막는다(https://* — CSP 가 허용하는 바깥은 https 의 배경지도 · 레이더 둘뿐이다). 배경지도는 앱의 로컬 대체 스타일이 그린다(R-01).
#   ofm : 배경지도(tiles.openfreemap.org)만 열고 나머지(레이더 · QA 가 막은 목록)는 막는다 — 마지막 전후 확인용(합 ≤ 24번).
# - 화면 · 프리셋을 번갈아(반복 n 마다 화면 → 데스크톱 · 모바일) 돌려 시간에 따른 흔들림이 한쪽에 몰리지 않게 한다.
# - 결과: docs/qa/2026-10/evidence/performance/cwv/<이름표>/<gpu|swgl>-<none|ofm>/<화면>-<프리셋>-<n>.json.gz
#   (스크린샷 · 필름스트립을 뺀 보고서 — 저장소를 가볍게). 요약은 tools/qa/perf_cwv_summary.py.
set -euo pipefail
label=${1:?이름표}; mode=${2:?gpu|swgl}; hosts=${3:?none|ofm}; reps=${4:-3}; shift 4 || shift $#
pages=("$@"); [ ${#pages[@]} -eq 0 ] && pages=(/ /replay /about /stats)
root=$(cd "$(dirname "$0")/../.." && pwd)
out="$root/docs/qa/2026-10/evidence/performance/cwv/$label/$mode-$hosts"
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export CHROME_PATH="${CHROME_PATH:-$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing}"
case "$mode" in
  gpu) flags="--headless=new --use-angle=metal --enable-gpu --no-first-run" ;;
  swgl) flags="--headless=new --use-angle=swiftshader --no-first-run" ;;
  *) echo "mode: gpu|swgl" >&2; exit 2 ;;
esac
case "$hosts" in
  none) blocked=("https://*") ;;
  ofm) blocked=("*rainviewer.com*" "*adsbdb.com*" "*aviationweather.gov*" "*data.go.kr*" "*kma.go.kr*" "*opensky-network.org*" "*adsb.lol*" "*adsb.fi*" "*aisstream.io*") ;;
  *) echo "hosts: none|ofm" >&2; exit 2 ;;
esac
bargs=(); for b in "${blocked[@]}"; do bargs+=("--blocked-url-patterns=$b"); done
for n in $(seq 1 "$reps"); do
  for page in "${pages[@]}"; do
    slug=$(echo "$page" | tr '/' '_'); slug=${slug#_}; slug=${slug:-root}
    for preset in desktop mobile; do
      dst="$out/$slug-$preset-$n.json.gz"
      [ -s "$dst" ] && continue   # 이미 잰 것은 건너뛴다
      pargs=(); [ "$preset" = desktop ] && pargs=(--preset=desktop)
      if npx -y lighthouse@12.8.2 "http://localhost:8701$page" ${pargs[@]+"${pargs[@]}"} --only-categories=performance --output=json \
          --output-path="$tmp/r.json" --quiet --max-wait-for-load=60000 --chrome-flags="$flags" "${bargs[@]}"; then
        python3 - "$tmp/r.json" "$dst" <<'EOF'
import gzip, json, sys
r = json.load(open(sys.argv[1]))
for k in ("screenshot-thumbnails", "final-screenshot", "full-page-screenshot"):
    r["audits"].pop(k, None)
r.pop("fullPageScreenshot", None)
r.pop("i18n", None)
with gzip.open(sys.argv[2], "wt", compresslevel=9) as f:
    json.dump(r, f, separators=(",", ":"))
EOF
        echo "ok $label $mode-$hosts $slug $preset $n"
      else
        echo "lighthouse failed: $label $mode-$hosts $page $preset $n" >&2
      fi
      sleep 3
    done
  done
done
