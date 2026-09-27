"""k6 없이 돌리는 간이 REST 부하 시험(httpx + asyncio). 사용: python quick_rest.py http://10.77.0.30:8000 [rps] [seconds]
docker 네트워크 안에서 api 에 직접 붙는다(edge 의 IP당 limit_req 를 우회 — api 층만 측정). PERF.md 에 결과를 적는다."""
import asyncio, statistics, sys, time, random
import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8700"
RPS = int(sys.argv[2]) if len(sys.argv) > 2 else 100
SECONDS = int(sys.argv[3]) if len(sys.argv) > 3 else 60
PATHS = [("aircraft", "/api/v1/aircraft?bbox=124,33,132,39&detail=lite", 0.6), ("sigmets", "/api/v1/sigmets?active=true", 0.25), ("status", "/api/v1/status", 0.15)]


async def main():
    lat: dict[str, list[float]] = {n: [] for n, _, _ in PATHS}
    codes: dict[int, int] = {}
    async with httpx.AsyncClient(base_url=BASE, timeout=10, limits=httpx.Limits(max_connections=200)) as c:
        async def one(name, path):
            t0 = time.perf_counter()
            try:
                r = await c.get(path)
                codes[r.status_code] = codes.get(r.status_code, 0) + 1
            except Exception as e:  # noqa: BLE001
                codes[-1] = codes.get(-1, 0) + 1
                return
            lat[name].append((time.perf_counter() - t0) * 1000)

        tasks = []
        start = time.perf_counter()
        n = 0
        while time.perf_counter() - start < SECONDS:
            x = random.random()
            acc = 0.0
            for name, path, w in PATHS:
                acc += w
                if x <= acc:
                    tasks.append(asyncio.create_task(one(name, path)))
                    break
            n += 1
            await asyncio.sleep(max(0.0, start + n / RPS - time.perf_counter()))
        await asyncio.gather(*tasks)
    total = sum(len(v) for v in lat.values())
    print(f"REST {BASE}: target {RPS} rps x {SECONDS}s → {total} ok responses ({total / SECONDS:.1f}/s), status codes {codes}")
    for name, v in lat.items():
        if not v:
            continue
        v.sort()
        p = lambda q: v[min(len(v) - 1, int(len(v) * q))]
        print(f"  {name:9s} n={len(v):5d} p50={p(0.5):6.1f} ms  p95={p(0.95):6.1f} ms  p99={p(0.99):6.1f} ms  max={v[-1]:6.1f} ms  avg={statistics.mean(v):6.1f} ms")


asyncio.run(main())
