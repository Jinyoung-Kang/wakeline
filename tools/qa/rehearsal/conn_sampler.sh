#!/usr/bin/env bash
# QA 2026-10 AWS 리허설(R): RDS 흉내의 클라이언트 연결 수를 1 s 마다 적는다(로컬 소켓 슈퍼유저 — 예약 자리라 꽉 차도 읽힌다, 자기 자신은 뺀다).
#   tools/qa/rehearsal/conn_sampler.sh <출력.tsv> &      # 줄: 시각 · 계정 · application_name · 상태 · 수   (멈출 때 kill)
#   tools/qa/rehearsal/conn_sampler.sh --peak <출력.tsv>  # 계정(+ application_name)별 최대 동시 연결 수와 그 시각, 전체 최대
set -euo pipefail
if [ "${1:-}" = "--peak" ]; then
  exec python3 -B - "$2" <<'EOF'
import collections, sys
# 표본 경계: 시각이 바뀌거나 같은 (계정, 이름, 상태) 줄이 다시 나오면 새 표본(\\watch 첫 두 번이 같은 초에 찍힌다)
samples, cur, cur_t = [], None, None
for line in open(sys.argv[1], encoding="utf-8"):
    p = line.rstrip("\n").split("\t")
    if len(p) != 5 or not p[4].isdigit():
        continue
    t, user, app, state, n = p
    if cur is None or t != cur_t or (user, app, state) in cur["keys"]:
        cur = {"t": t, "keys": set(), "c": collections.Counter()}
        cur_t = t
        samples.append(cur)
    cur["keys"].add((user, app, state))
    for k in ((user, app), (user, "*"), ("*", "*")):
        cur["c"][k] += int(n)
peak = {}
for smp in samples:
    for k, n in smp["c"].items():
        if n > peak.get(k, (0, ""))[0]:
            peak[k] = (n, smp["t"])
for (user, app), (n, t) in sorted(peak.items()):
    print(f"{user:22s} {app:28s} max {n:3d} at {t}")
print(f"samples {len(samples)}")
EOF
fi
out=${1:?출력 파일}
{
  printf '%s\n' "SELECT to_char(clock_timestamp(), 'HH24:MI:SS'), coalesce(usename, '-'), coalesce(nullif(application_name, ''), '-'), coalesce(state, '-'), count(*)
    FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() GROUP BY 2, 3, 4 ORDER BY 2, 3, 4;"
  printf '%s\n' '\watch 1'
} | docker exec -i wlqa-rds-rds-1 psql -X -q -U postgres -d postgres -At -F $'\t' >> "$out"
