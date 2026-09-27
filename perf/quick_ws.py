"""간이 WS 팬아웃 시험: N 연결이 구독하고 diff/snapshot 의 서버 ts → 수신 시각 지연을 잰다. 사용: python quick_ws.py ws://10.77.0.30:8000/ws/v1 200 90"""
import asyncio, json, statistics, sys, time
from urllib.parse import urlparse
from datetime import datetime, timezone
import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8700/ws/v1"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 200
SECONDS = int(sys.argv[3]) if len(sys.argv) > 3 else 90
lags: list[float] = []
counts = {"snapshot": 0, "diff": 0, "other": 0, "errors": 0}


async def client(i: int):
    try:
        # same-origin 검사(Origin ↔ Host): 접속 호스트와 같은 출처를 보낸다
        u = urlparse(URL)
        async with websockets.connect(URL, origin=f"http://{u.netloc}", max_size=4 * 1024 * 1024, open_timeout=20) as ws:
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
                elif t == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                elif t in ("snapshot", "diff"):
                    counts[t] += 1
                    ts = datetime.fromisoformat(m["ts"].replace("Z", "+00:00"))
                    lags.append((datetime.now(timezone.utc) - ts).total_seconds() * 1000)
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


asyncio.run(main())
