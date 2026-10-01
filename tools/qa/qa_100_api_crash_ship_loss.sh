#!/bin/bash
# QA-100 재현(격리 스택 B 전용): api 가 비정상 종료된 직후 다시 뜰 때, 스트림 소비자가 선박 저장기(ShipWriter)보다 먼저 시작해
# 그동안 받은 선박 메시지의 행을 버리고(wakeline_ship_rows_total{result="dropped"}) 그 메시지를 ACK 한다 → ship_position 영구 손실.
#
# 조건을 결정적으로 만든다: 인스턴스 임대(wakeline:api:instance, TTL 15 s · 5 s 마다 갱신)가 막 갱신된 순간에 api 를 kill -9 →
# 새 프로세스의 SingleInstanceGuard 가 죽은 임대가 풀리기를 기다리는 동안(같은 phase 의 ShipWriter 는 아직 시작 전) 소비자는 이미 돌고 있다.
# 이 호스트(4 CPU 를 다른 작업과 나눔)는 JVM 기동이 11–18 s 로 흔들려, 죽은 임대(15 s)가 새 프로세스의 확인 전에 풀리면 창이 닫혀 재현되지 않는다
# (처음 자연 재현은 kill 뒤 2 s 만에 다시 떠 가드가 약 4 s 기다렸을 때). 그래서 kill 직후 죽은 프로세스의 임대(값 그대로)를 새 프로세스의 소비자가
# 부트스트랩을 마치고 HOLD_AFTER_S(기본 12 s — 선박 메시지 10 s 주기 하나 이상) 더 지날 때까지 1 s 마다 PEXPIRE 15000 으로 살려 둔 뒤 놓는다 —
# '기동이 빠른 호스트에서 갱신 직후 죽음' 또는 '다른 api 인스턴스가 아직 살아 있음'(R-79, 가드가 막아야 하는 경우)과 같은 상태다.
# HOLD_AFTER_S=0 이면 임대를 건드리지 않는다(자연 조건).
# 결함이면 종료 코드 1(새 프로세스의 dropped > 0 또는 스트림 ↔ DB 대조에서 선박 창 손실).
#
#   bash tools/qa/qa_100_api_crash_ship_loss.sh [증거 폴더]
set -uo pipefail
cd "$(dirname "$0")/../.."
P=wakeline-qa
OUT="${1:-docs/qa/2026-10/evidence/reliability/qa-100-$(date +%H%M%S)}"
mkdir -p "$OUT"
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
r() { docker exec "$P-redis-1" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning "$@"' sh "$@"; }
metric() { docker exec "$P-api-1" curl -s -m 5 localhost:9000/actuator/prometheus 2>/dev/null | awk -v k="$1" 'index($0, k) == 1 { print $2 }'; }

T0=$(ms)
# 임대가 막 갱신된 순간(남은 TTL ≥ 14.3 s)을 기다린다
for i in $(seq 1 100); do t=$(r PTTL wakeline:api:instance | tr -d '\r'); [ "${t:-0}" -ge 14300 ] && break; sleep 0.2; done
KILL_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "lease PTTL=$t ms — kill -9 api at $KILL_AT" | tee "$OUT/run.log"
docker exec "$P-api-1" sh -c 'kill -9 -1' >/dev/null 2>&1 || true
HOLD_AFTER_S="${HOLD_AFTER_S:-12}"
if [ "$HOLD_AFTER_S" -gt 0 ]; then
  held_until=""
  for i in $(seq 1 90); do
    r PEXPIRE wakeline:api:instance 15000 >/dev/null
    if [ -z "$held_until" ] && docker logs --since "$KILL_AT" "$P-api-1" 2>&1 | grep -q 'bootstrap done'; then
      held_until=$(( $(date +%s) + HOLD_AFTER_S ))
      echo "new process consumer bootstrapped while the guard waits — keeping the dead lease ${HOLD_AFTER_S} s more" | tee -a "$OUT/run.log"
    fi
    [ -n "$held_until" ] && [ "$(date +%s)" -ge "$held_until" ] && break
    sleep 1
  done
  r PEXPIRE wakeline:api:instance 500 >/dev/null
  echo "dead lease released" | tee -a "$OUT/run.log"
fi
# 다시 떠서 시작을 마칠 때까지
for i in $(seq 1 120); do
  docker logs --since "$KILL_AT" "$P-api-1" 2>&1 | grep -q 'Started WakelineApplication' && break; sleep 1
done
sleep 30
docker logs --since "$KILL_AT" "$P-api-1" 2>&1 | grep -E 'Starting WakelineApplication|bootstrap done|ships bootstrap|instance lease|Started WakelineApplication|HikariPool-1 - Start' \
  | cut -c1-220 | tee -a "$OUT/run.log"
dropped=$(metric 'wakeline_ship_rows_total{result="dropped"}')
written=$(metric 'wakeline_ship_rows_total{result="written"}')
echo "new process: wakeline_ship_rows_total dropped=${dropped:-?} written=${written:-?}" | tee -a "$OUT/run.log"
python3 tools/qa/stream_db_integrity.py --since-ms $((T0 - 60000)) --until-ms $(( $(ms) - 15000 )) --settle-s 120 --json "$OUT/integrity.json" >/dev/null
lost=$(python3 -c "import json; print(json.load(open('$OUT/integrity.json'))['defects']['ship_windows_lost'])")
echo "ship windows lost (stream ↔ DB): $lost" | tee -a "$OUT/run.log"
python3 -c "import json; d=json.load(open('$OUT/integrity.json')); print('missing sample:', d['ships']['missing_sample'][:3])" | tee -a "$OUT/run.log"
if [ "${dropped%.*}" != "0" ] || [ "$lost" != "0" ]; then echo "QA-100 DEFECT: ship rows dropped while the writer was not running" | tee -a "$OUT/run.log"; exit 1; fi
echo "QA-100 not observed this run" | tee -a "$OUT/run.log"
exit 0
