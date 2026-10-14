"""QA 2026-10 AWS 리허설(R): RDS 흉내에 '다른 두 프로젝트 몫' 연결을 붙잡는 더미 — wlqa-rds 의 holder 서비스(profiles: holder)로만 돈다.

환경 변수: MACRO_PW · BUILDRISK_PW(setup.py 가 만든 rds.env), HOLD_MACRO · HOLD_BUILDRISK(각 계정이 붙잡을 수, 기본 7 · 7 = 14),
HOLD_FILL=1 이면 그 뒤 macro 계정으로 서버가 거절할 때까지 더 붙잡아 남은 자리(슈퍼유저 예약분 제외)를 모두 채운다.
HOLD_GREEDY=1 이면 채운 뒤에도 0.2 s 마다 더 붙잡으려 한다 — 다른 프로젝트가 연결을 새는 상황: 누가 연결을 놓으면(예: wakeline 재시작) 그 자리를 가져간다.
연결은 TLS(sslmode=require — RDS 의 force_ssl 과 같이), application_name = wlqa-holder-<계정>. 30 s 마다 SELECT 1 로 살려 둔다.
비밀번호는 출력하지 않는다. 멈추면(SIGTERM) 연결을 닫는다.
"""
from __future__ import annotations

import asyncio
import os
import signal
import time

import asyncpg


async def connect(user: str, db: str, pw: str) -> asyncpg.Connection:
    return await asyncpg.connect(host=os.environ.get("HOLD_HOST", "rds"), port=int(os.environ.get("HOLD_PORT", "5432")), user=user,
                                 password=pw, database=db, ssl="require", timeout=5,
                                 server_settings={"application_name": f"wlqa-holder-{user}"})


async def main() -> None:
    held: list[asyncpg.Connection] = []
    plan = [("macro", "macrodash", os.environ["MACRO_PW"], int(os.environ.get("HOLD_MACRO", "7"))),
            ("buildrisk", "buildrisk", os.environ["BUILDRISK_PW"], int(os.environ.get("HOLD_BUILDRISK", "7")))]
    for user, db, pw, n in plan:
        for _ in range(n):
            held.append(await connect(user, db, pw))
    print(f"{time.strftime('%H:%M:%S')} held base={len(held)}", flush=True)
    if os.environ.get("HOLD_FILL") == "1":
        extra = 0
        while True:
            try:
                held.append(await connect("macro", "macrodash", os.environ["MACRO_PW"]))
                extra += 1
            except Exception as e:  # noqa: BLE001 — 서버가 거절하면 꽉 찬 것
                print(f"{time.strftime('%H:%M:%S')} fill stopped after +{extra}: {type(e).__name__}: {str(e)[:160]}", flush=True)
                break
        print(f"{time.strftime('%H:%M:%S')} held total={len(held)}", flush=True)
    stop = asyncio.Event()

    async def greedy() -> None:
        grabbed = 0
        while not stop.is_set():
            try:
                held.append(await connect("macro", "macrodash", os.environ["MACRO_PW"]))
                grabbed += 1
                print(f"{time.strftime('%H:%M:%S')} greedy grabbed a freed slot (+{grabbed}, total={len(held)})", flush=True)
            except Exception:  # noqa: BLE001
                await asyncio.sleep(0.2)

    if os.environ.get("HOLD_FILL") == "1" and os.environ.get("HOLD_GREEDY") == "1":
        asyncio.get_running_loop().create_task(greedy())
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), 30)
        except TimeoutError:
            for c in held:
                try:
                    await c.fetchval("SELECT 1")
                except Exception:  # noqa: BLE001
                    pass
    for c in held:
        await c.close()
    print(f"{time.strftime('%H:%M:%S')} released {len(held)}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
