#!/usr/bin/env python3
"""QA 2026-10-aws 공개 데모(A1) — WS 남용: 한 IP(한 브라우저 컨텍스트와 같은 조건)가 여러 WS 연결로 핫 리전 수요 임대 상한(6 셀)과
집중 추적 상한(50 hex)을 얼마나 차지하는가, 그 뒤에 온 다른 IP 의 방문자는 무엇을 받는가.

  역할 owner(호스트에서): edge(localhost:8701)로 WS 6개를 연다(IP당 상한 5 → 6번째는 거절되어야 한다). 받아들여진 세션마다 관심 지역 원 밖의
    서로 다른 곳을 줌 8 로 구독해 핫 리전 수요를 낸다. 그다음 다른 IP 방문자(visitor — 같은 compose 망의 다른 컨테이너에서 edge 로)를 띄운다.
  역할 visitor(컨테이너 안 — `docker exec -i wlqa-a-collector-1 python - visitor`): 관심 지역 밖 또 다른 두 곳을 줌 8 로 구독(2 연결)하고 demand 를 받는다.
  끝으로 owner 세션 하나가 select 를 6번 바꿔(60 s 창 6개 — 세션 제한) 7번째가 limited 인지, 30분 상한은 시간이 걸려 보지 않는다.

외부 공급자는 부르지 않는다(fixture 모드 — 수집기는 임대를 읽어도 밖을 부르지 않는다). 결과: <증거 폴더>/ws-demand-hog.json

  cd apps/collector && uv run --offline python ../../tools/qa/pd_ws_demand_hog.py [증거 폴더]
"""
import asyncio, json, os, subprocess, sys, time

import websockets

ROLE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ("owner", "visitor") else "owner"

# 관심 지역(36.5, 127.8 · 250 NM) 밖, 서로 다른 0.5° 격자 중심
OWNER_SPOTS = [("Tokyo", 35.7, 139.7), ("Shanghai", 31.2, 121.5), ("Beijing", 39.9, 116.4), ("Taipei", 25.0, 121.5), ("Vladivostok", 43.1, 131.9),
               ("Osaka", 34.7, 135.5)]
VISITOR_SPOTS = [("Manila", 14.6, 121.0), ("HongKong", 22.3, 114.2)]


def bbox(lat, lon, half=0.6):
    return [round(lon - half, 3), round(lat - half * 0.8, 3), round(lon + half, 3), round(lat + half * 0.8, 3)]


async def session(url, origin, name, lat, lon, hold_s, log, via=None):
    """via=(host, port): 그 주소로 TCP 를 열고 Host 는 url 의 것(edge 의 Host 허용 목록 — localhost)을 쓴다."""
    rec = {"name": name, "opened": False, "close": None, "welcome_limits": None, "demand": []}
    try:
        kw = {"sock": __import__("socket").create_connection(via, timeout=10)} if via else {}
        async with websockets.connect(url, origin=origin, max_size=8 * 1024 * 1024, open_timeout=10, **kw) as ws:
            rec["opened"] = True
            await ws.send(json.dumps({"type": "hello", "proto": 1, "client": "qa-hog"}))
            await ws.send(json.dumps({"type": "subscribe", "bbox": bbox(lat, lon), "zoom": 8, "detail": "lite"}))
            end = time.time() + hold_s
            while time.time() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time()))
                except asyncio.TimeoutError:
                    break
                if isinstance(raw, bytes):
                    continue
                m = json.loads(raw)
                t = m.get("type")
                if t == "welcome":
                    rec["welcome_limits"] = m.get("limits")
                elif t == "demand":
                    rec["demand"].append({"t": round(time.time() - log["t0"], 2), "hot": m.get("hot"), "focus": m.get("focus")})
                elif t == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
    except websockets.ConnectionClosed as e:
        rec["close"] = [e.rcvd.code if e.rcvd else None, e.rcvd.reason if e.rcvd else None]
    except Exception as e:  # 업그레이드 거절 등
        rec["close"] = [None, f"{type(e).__name__}: {e}"]
    return rec


def last_hot(rec):
    hots = [d["hot"] for d in rec["demand"] if d.get("hot")]
    return hots[-1] if hots else None


async def visitor():
    url, origin = "ws://localhost:8701/ws/v1", "http://localhost:8701"
    log = {"t0": time.time()}
    recs = await asyncio.gather(*[session(url, origin, n, la, lo, 14, log, via=("edge", 8700)) for n, la, lo in VISITOR_SPOTS])
    print(json.dumps([{**r, "last_hot": last_hot(r)} for r in recs], ensure_ascii=False))


async def select_flood(url, origin, log):
    """세션 제한(계약 v3 §C): 한 세션이 60 s 에 새 hex 6개까지 — 7번째는 limited 인가."""
    out = []
    async with websockets.connect(url, origin=origin, max_size=8 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"type": "hello", "proto": 1, "client": "qa-hog"}))
        await ws.send(json.dumps({"type": "subscribe", "bbox": [126, 35, 129, 38], "zoom": 8}))
        for i in range(8):
            hx = f"a{i:05x}"
            await ws.send(json.dumps({"type": "select", "hex": hx}))
            end = time.time() + 2.2
            got = None
            while time.time() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.time()))
                except asyncio.TimeoutError:
                    break
                if isinstance(raw, bytes):
                    continue
                m = json.loads(raw)
                if m.get("type") == "demand" and m.get("focus") and m["focus"].get("hex") == hx:
                    got = m["focus"]
            out.append({"i": i + 1, "hex": hx, "focus": got})
    return out


async def owner(out_dir):
    url, origin = "ws://localhost:8701/ws/v1", "http://localhost:8701"
    log = {"t0": time.time()}
    tasks = [asyncio.create_task(session(url, origin, n, la, lo, 30, log)) for n, la, lo in OWNER_SPOTS]
    await asyncio.sleep(8)  # 수요 계산(1 s 모음) · 상태 몇 번
    script = open(__file__, encoding="utf-8").read()
    proc = await asyncio.create_subprocess_exec("docker", "exec", "-i", os.environ.get("WLQA_COLLECTOR", "wlqa-a-collector-1"), "python", "-", "visitor",
                                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    so, se = await proc.communicate(script.encode())
    try:
        vis = json.loads(so.decode().strip().splitlines()[-1])
    except Exception:
        vis = {"error": se.decode()[-800:], "stdout": so.decode()[-800:]}
    owner_recs = await asyncio.gather(*tasks)
    await asyncio.sleep(2)
    flood = await select_flood(url, origin, log)
    res = {
        "owner_ip_sessions": [{**r, "last_hot": last_hot(r), "demand": r["demand"][-3:]} for r in owner_recs],
        "visitor_other_ip_sessions": vis,
        "select_flood_one_session": flood,
    }
    os.makedirs(out_dir, exist_ok=True)
    json.dump(res, open(os.path.join(out_dir, "ws-demand-hog.json"), "w"), indent=1, ensure_ascii=False)
    for r in owner_recs:
        print("owner", r["name"], "opened" if r["opened"] else "refused", r["close"], "last_hot=", json.dumps(last_hot(r)))
    for r in (vis if isinstance(vis, list) else []):
        print("visitor", r["name"], "opened" if r["opened"] else "refused", r["close"], "last_hot=", json.dumps(r.get("last_hot")))
    for f in flood:
        print("select", f["i"], f["hex"], json.dumps(f["focus"]))


if ROLE == "visitor":
    asyncio.run(visitor())
else:
    asyncio.run(owner(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "../../docs/qa/2026-10-aws/evidence/public-demo")))
