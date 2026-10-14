#!/usr/bin/env bash
# QA-1130 재현(이미지 단위): 수집기 이미지의 파이썬이 CVE-2026-15310(gh-156002, 3.13.16 에서 고침)을 품어, 공역 가져오기의
# '풀린 KML 20 MiB 초과는 읽으며 세어 거절' 규칙이 bzip2 멤버에서 메모리를 지키지 못한다 → 수집기와 같은 512m 한도에서 OOM(종료 137).
#   tools/qa/qa_1130_collector_python_zip_bomb.sh [이미지(기본 wakeline-collector:qa)]
# 망 없음 · 권한 없음 · 버리는 컨테이너. 운영 · QA 스택과 DB 에 닿지 않는다(--dry-run). 결함이 있으면 1, 없으면 0.
set -uo pipefail
img=${1:-wakeline-collector:qa}
work=$(mktemp -d "${TMPDIR:-/tmp}/qa1130.XXXXXX") || exit 2
trap 'rm -rf "$work"' EXIT
# 1 GiB 공백을 bzip2 로 담은 멤버 하나(doc.kml) — KMZ 는 1 KB 남짓(입력 상한 20 MiB 를 한참 밑돈다). 만드는 쪽은 이미지의 파이썬(망 없음)
docker run --rm -i --network none --cap-drop ALL --entrypoint python "$img" - > "$work/bomb.kmz" <<'EOF' || exit 2
import io, sys, zipfile
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_BZIP2) as z, z.open("doc.kml", "w", force_zip64=True) as w:
    block = b" " * (1 << 20)
    for _ in range(1024):
        w.write(block)
sys.stdout.buffer.write(buf.getvalue())
EOF
echo "image $img · python $(docker image inspect "$img" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PYTHON_VERSION=//p') · bomb.kmz $(wc -c < "$work/bomb.kmz" | tr -d ' ') B"
rc=0
err=$(docker run --rm -i --network none --cap-drop ALL --memory 512m --memory-swap 512m --entrypoint python "$img" \
  -m wakeline_collector.tools.airspace_import --dry-run --edition QA1130 < "$work/bomb.kmz" 2>&1) || rc=$?
echo "airspace_import --dry-run (512m): exit $rc ${err:+— $err}"
if [ "$rc" = 1 ] && [[ "$err" == *"when unpacked"* ]]; then echo "PASS  거절(1) — 풀린 크기 상한이 메모리를 지켰다"; exit 0; fi
echo "FAIL  기대: 종료 1 + '거절: KML larger than … when unpacked' — 실제: 종료 $rc (137 = OOM 으로 죽음)"
exit 1
