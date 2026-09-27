"""간이 WS 팬아웃 시험: N 연결이 구독하고 diff/snapshot 의 서버 ts → 수신 시각 지연을 잰다.
사용: ORIGIN=http://localhost:8700 python quick_ws.py ws://10.77.0.30:8000/ws/v1 200 90
SHIPS=1 이면 선박 레이어도 켜고(계약 v2 §B3 {type:"layers"}) ships_* 메시지의 지연을 따로 잰다.

api 는 WS Origin 을 명시 허용 목록(WAKELINE_ALLOWED_ORIGINS, 기본 http://localhost:8700 · http://127.0.0.1:8700)으로만 받는다.
접속 주소(api 직접 10.77.0.30:8000 등)와 무관하게 Origin 은 허용 목록의 값을 보낸다 — ORIGIN 환경변수, 기본 http://localhost:8700."""
import asyncio, json, os, statistics, sys, time
from datetime import datetime, timezone
import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8700/ws/v1"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 200
SECONDS = int(sys.argv[3]) if len(sys.argv) > 3 else 90
ORIGIN = os.environ.get("ORIGIN", "http://localhost:8700")
SHIPS = os.environ.get("SHIPS") == "1"
SHIP_TYPES = ("ships_snapshot", "ships_diff", "ships_grid")
lags: list[float] = []
ship_lags: list[float] = []
counts = {"snapshot": 0, "diff": 0, "ships": 0, "other": 0, "errors": 0}


async def client(i: int):
    try:
        async with websockets.connect(URL, origin=ORIGIN, max_size=4 * 1024 * 1024, open_timeout=20) as ws:
            await ws.send(json.dumps({"type": "hello", "proto": 1, "client": "quick_ws"}))
            end = time.time() + SECONDS
            while time.time() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=end - time.time())
                except asyncio.TimeoutError:
                    break
                m = json.loads(raw)
                t = m.get("type")
                if t == "welcome":
                    await ws.send(json.dumps({"type": "subscribe", "bbox": [124, 33, 132, 39], "zoom": 7, "detail": "lite"}))
                    if SHIPS:
                        await ws.send(json.dumps({"type": "layers", "aircraft": True, "ships": True}))
                elif t == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                elif t in ("snapshot", "diff"):
                    counts[t] += 1
                    ts = datetime.fromisoformat(m["ts"].replace("Z", "+00:00"))
                    lags.append((datetime.now(timezone.utc) - ts).total_seconds() * 1000)
                elif t in SHIP_TYPES:
                    counts["ships"] += 1
                    if m.get("ts"):
                        ts = datetime.fromisoformat(m["ts"].replace("Z", "+00:00"))
                        ship_lags.append((datetime.now(timezone.utc) - ts).total_seconds() * 1000)
                else:
                    counts["other"] += 1
    except Exception as e:  # noqa: BLE001
        counts["errors"] += 1
        if counts["errors"] <= 3:
            print("client", i, "error:", repr(e)[:120])


async def main():
    tasks = []
    for i in range(N):
        tasks.append(asyncio.create_task(client(i)))
        await asyncio.sleep(60 / N)  # 1분 램프업
    await asyncio.gather(*tasks)
    lags.sort()
    p = lambda q: lags[min(len(lags) - 1, int(len(lags) * q))] if lags else float("nan")
    print(f"WS {URL}: {N} connections x {SECONDS}s → messages {counts}")
    print(f"  fanout lag (server ts → client recv): n={len(lags)} p50={p(0.5):.0f} ms p95={p(0.95):.0f} ms p99={p(0.99):.0f} ms max={lags[-1] if lags else 0:.0f} ms")
    if SHIPS:
        ship_lags.sort()
        q = lambda x: f"{ship_lags[min(len(ship_lags) - 1, int(len(ship_lags) * x))]:.0f}" if ship_lags else "—"
        print(f"  ships lag (server ts → client recv): n={len(ship_lags)} p50={q(0.5)} ms p95={q(0.95)} ms max={q(0.999999)} ms")


asyncio.run(main())
