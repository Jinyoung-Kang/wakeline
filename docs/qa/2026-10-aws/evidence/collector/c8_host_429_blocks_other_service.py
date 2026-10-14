"""후보 8(#141 — 기대 동작 미정): 공공데이터포털(apis.data.go.kr)의 한 서비스(PORT-MIS 입출항 색인)가 429 를 받으면, 호스트 단위 쉼이 같은 호스트의 다른 서비스
(KOMSA 연안 교통 · 해양수산부 격자 WFS)까지 막는가 — 재현만 한다. 실제 HttpClient · RateLimiter(main 과 같은 build_limiter) · respx(외부 호출 없음).
실행: cd apps/collector && uv run --offline python ../../docs/qa/2026-10-aws/evidence/collector/c8_host_429_blocks_other_service.py
"""

import asyncio

import httpx
import respx

from wakeline_collector.config import settings
from wakeline_collector.http import HttpClient, ProviderHttpError, build_limiter
from wakeline_collector.providers.data_go_kr import DATA_GO_KR_HOST, KOMSA_URL, WFS_URL
from wakeline_collector.ratelimit import Throttled

PORTMIS_URL = f"https://{DATA_GO_KR_HOST}/1192000/VsslEtrynd5/Info5"


async def main() -> None:
    http = HttpClient(build_limiter(settings))
    try:
        with respx.mock:
            pm = respx.get(PORTMIS_URL).mock(return_value=httpx.Response(429, text="<OpenAPI_ServiceResponse>LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR</OpenAPI_ServiceResponse>"))
            km = respx.get(KOMSA_URL).mock(return_value=httpx.Response(200, json={"response": {"header": {"resultCode": "00"}}}))
            wf = respx.get(WFS_URL).mock(return_value=httpx.Response(200, text="<wfs/>"))
            try:
                await http.get(PORTMIS_URL, params={"serviceKey": "x"})
            except ProviderHttpError as e:
                print(f"PORT-MIS: HTTP {e.status} — host {DATA_GO_KR_HOST} paused {e.pause_s:.0f} s")
            for name, url in (("KOMSA 교통(5분 폴링)", KOMSA_URL), ("해양수산부 격자 WFS", WFS_URL)):
                try:
                    await http.get(url, params={"serviceKey": "x"}, wait_s=10.0)
                    print(f"{name}: sent")
                except Throttled as e:
                    print(f"{name}: not sent — Throttled({e})")
            print(f"calls actually sent: PORT-MIS {pm.call_count} · KOMSA {km.call_count} · WFS {wf.call_count}")
    finally:
        await http.aclose()


asyncio.run(main())
