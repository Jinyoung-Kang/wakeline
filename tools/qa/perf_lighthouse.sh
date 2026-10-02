#!/usr/bin/env bash
# QA 성능(계획 §3.5 '화면'): Lighthouse 12(npx — npm 레지스트리) 로 격리 스택 A(8701)의 네 화면을 데스크톱 · 모바일 프리셋으로 3번씩(합 24번) 잰다.
#   tools/qa/perf_lighthouse.sh [반복=3] [화면 …]
# - 브라우저: Playwright 의 Chrome for Testing(headless=new · SwiftShader WebGL — 소프트웨어 GL, 지도 화면에 불리하게 치우친다).
# - 막는 주소(--blocked-url-patterns): *rainviewer.com*(레이더 타일 — fixture 프레임도 이 호스트를 가리킨다), *adsbdb.com*, *aviationweather.gov*,
#   *data.go.kr*, *kma.go.kr*, *opensky-network.org*, *adsb.lol*, *adsb.fi*, *aisstream.io* — 배경지도 tiles.openfreemap.org 만 남긴다
#   (화면이 실제로 부르는 바깥 호스트는 CSP connect-src/img-src 의 openfreemap · rainviewer 둘뿐이고, 나머지는 링크 — 만약을 위해 함께 막는다).
# - 결과: docs/qa/2026-10/evidence/performance/lighthouse/<화면>-<프리셋>-<n>.json(전체 보고서) + summary.tsv(점수 · LCP · TBT · CLS · 전송량 · JS 전송량 ·
#   openfreemap 요청 수).
set -euo pipefail
reps=${1:-3}; shift || true
pages=("$@"); [ ${#pages[@]} -eq 0 ] && pages=(/ /replay /stats /about)
root=$(cd "$(dirname "$0")/../.." && pwd)
out="$root/docs/qa/2026-10/evidence/performance/lighthouse"
mkdir -p "$out"
export CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
blocked=("*rainviewer.com*" "*adsbdb.com*" "*aviationweather.gov*" "*data.go.kr*" "*kma.go.kr*" "*opensky-network.org*" "*adsb.lol*" "*adsb.fi*" "*aisstream.io*")
bargs=(); for b in "${blocked[@]}"; do bargs+=("--blocked-url-patterns=$b"); done
for page in "${pages[@]}"; do
  slug=$(echo "$page" | tr '/' '_'); slug=${slug#_}; slug=${slug:-root}
  for preset in desktop mobile; do
    for n in $(seq 1 "$reps"); do
      { [ -s "$out/$slug-$preset-$n.json" ] || [ -s "$out/$slug-$preset-$n.json.gz" ]; } && continue   # 이미 잰 것은 건너뛴다(배경지도 호스트 요청 수를 늘리지 않게 — 합 24번)
      pargs=(); [ "$preset" = desktop ] && pargs=(--preset=desktop)
      npx -y lighthouse@12 "http://localhost:8701$page" ${pargs[@]+"${pargs[@]}"} --only-categories=performance --output=json \
        --output-path="$out/$slug-$preset-$n.json" --quiet --max-wait-for-load=60000 \
        --chrome-flags="--headless=new --use-angle=swiftshader --no-first-run" "${bargs[@]}" || echo "lighthouse failed: $page $preset $n"
      sleep 3
    done
  done
done
python3 - "$out" <<'EOF'
import json, sys, glob, os
out = sys.argv[1]
rows = ["file\tperf\tLCP_ms\tTBT_ms\tCLS\tFCP_ms\tSI_ms\ttotal_KiB\tjs_KiB\treqs\topenfreemap_reqs\tblocked_reqs\tlh_version\tbenchmark_index"]
for f in sorted(glob.glob(os.path.join(out, "*.json"))):
    try:
        r = json.load(open(f))
    except Exception:
        continue
    a = r["audits"]
    reqs = a.get("network-requests", {}).get("details", {}).get("items", [])
    js = sum(i.get("transferSize", 0) for i in reqs if i.get("resourceType") == "Script")
    tot = sum(i.get("transferSize", 0) for i in reqs)
    ofm = sum(1 for i in reqs if "openfreemap" in i.get("url", ""))
    blk = sum(1 for i in reqs if i.get("statusCode") in (-1, None) or "blocked" in str(i.get("failed", "")).lower())
    nv = lambda k: a.get(k, {}).get("numericValue")
    rows.append("\t".join(map(str, [os.path.basename(f)[:-5], round((r["categories"]["performance"]["score"] or 0) * 100), round(nv("largest-contentful-paint") or 0),
        round(nv("total-blocking-time") or 0), round(nv("cumulative-layout-shift") or 0, 3), round(nv("first-contentful-paint") or 0), round(nv("speed-index") or 0),
        round(tot / 1024, 1), round(js / 1024, 1), len(reqs), ofm, blk, r.get("lighthouseVersion"), r.get("environment", {}).get("benchmarkIndex")])))
open(os.path.join(out, "summary.tsv"), "w").write("\n".join(rows) + "\n")
print("\n".join(rows))
EOF
