"""aisstream.io WebSocket 수신(계약 v2 §B1, ADR-014).

- `wss://stream.aisstream.io/v0/stream` 에 permessage-deflate(compression="deflate")로 붙고, 붙자마자(1 s 안) 구독을 보낸다.
  구독 = {APIKey, BoundingBoxes, FilterMessageTypes}(문서 확인 2026-09-28). 쓰는 5개 형식만 받아 대역폭·CPU 를 줄인다.
- 받은 데이터 프레임은 파싱하지 않고 RawQueue 에 넣기만 한다(기다리지 않음). "error" 글자가 든 프레임만 공급자 오류인지 확인하려고 파싱한다(is_provider_error). 메시지 상한 1 MiB(압축 해제 후 크기에 적용), ping 20 s.
- 공급자 오류 프레임({"error": ...})도 대기열에 넣지만(정리 태스크가 가려서 provider_error 로 기록) 데이터로 세지 않는다 —
  공백을 닫거나 last_msg_at·msgs_total·수신 상태·idle 기한을 바꾸지 않는다(오류만 받고 끊기는 반복은 '회복' 이 아니다).
- 데이터 메시지가 idle_timeout_s(기본 120 s) 동안 없으면 조용히 멈춘 연결로 보고 다시 붙는다(서버가 close 프레임 없이 끊는 사례 실측).
- 끊기면 FeedState 가 공백을 열고, Backoff(1→60 s, ±20 %, 60 s 정상 연결 뒤에만 초기화) 만큼 쉬었다가 다시 붙는다.
- 구독 영역이 바뀌면(BboxState) 같은 연결에서 구독을 다시 보낸다 — 5 s 에 한 번까지, 마지막 값만.
- 이 클래스는 연결(구역) 하나다. 구역이 여럿이면 AisStreamPool(pool.py)이 구역마다 하나씩 띄운다 — Backoff·FeedState·idle 기한·
  재구독 제한은 연결마다 따로, 대기열은 함께(원문에 구역 번호 tag 를 붙인다, 계약 v4 §D).

비밀값: API 키는 구독 메시지 본문에만 실린다(URL·헤더·로그에 없음). websockets 로거는 DEBUG 에서 프레임 내용을 찍으므로
WARNING 으로 고정하고, 오류 문구는 masking 규칙 + 키 문자열 치환을 거친다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import orjson
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException
from websockets.extensions.permessage_deflate import PerMessageDeflate

from wakeline_collector.ais.backoff import Backoff, SubscribeLimiter
from wakeline_collector.ais.bbox import BBox, BboxState, format_bboxes, to_subscription
from wakeline_collector.ais.feed import FeedState
from wakeline_collector.ais.parse import SUBSCRIBED_TYPES, is_provider_error
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.masking import mask

log = logging.getLogger("ais.client")
logging.getLogger("websockets").setLevel(logging.WARNING)  # DEBUG 는 구독 프레임(API 키 포함)을 그대로 찍는다

AIS_URL = "wss://stream.aisstream.io/v0/stream"
MAX_MESSAGE_BYTES = 1 << 20
LOOPBACK = frozenset({"127.0.0.1", "localhost", "::1"})


def check_url(url: str) -> None:
    """키가 평문으로 나가지 않게: 암호화하지 않은 ws:// 는 이 기계 안(시험용 가짜 서버)에서만 허용."""
    parts = urlsplit(url)
    if not (parts.scheme == "wss" or (parts.scheme == "ws" and parts.hostname in LOOPBACK)):
        raise ValueError("AIS stream URL must use wss:// (ws:// only for loopback test servers)")


def make_redactor(secret: str) -> Callable[[str], str]:
    def redact(text: str) -> str:
        out = mask(text) or ""
        return out.replace(secret, "***") if secret else out

    return redact


def _deflate_negotiated(ws: ClientConnection) -> bool:
    return any(isinstance(ext, PerMessageDeflate) for ext in ws.protocol.extensions)


def _closed_reason(e: ConnectionClosed) -> str:
    """끊긴 쪽을 구분한다: 서버가 close 프레임을 보냈는지, 우리가 먼저 닫았는지(예: 1011 keepalive ping timeout · 1009 너무 큰 메시지),
    아니면 둘 다 없이 TCP 가 끊겼는지. 공백 사유·상태 해시에 그대로 남아 원인 진단에 쓰인다."""
    rcvd, sent = e.rcvd, e.sent
    if rcvd is None and sent is not None:
        return f"client closed ({sent.code}" + (f" {sent.reason[:120]})" if sent.reason else ")")
    if rcvd is None:
        return "connection lost (no close frame)"
    text = f"server closed ({rcvd.code}"
    return text + (f" {rcvd.reason[:120]})" if rcvd.reason else ")")


class AisStreamClient:
    def __init__(
        self,
        *,
        api_key: str,
        queue: RawQueue,
        feed: FeedState,
        bboxes: BboxState,
        backoff: Backoff | None = None,
        url: str = AIS_URL,
        user_agent: str = "wakeline",
        idle_timeout_s: float = 120.0,
        resubscribe_min_s: float = 5.0,
        open_timeout_s: float = 10.0,
        ping_interval_s: float = 20.0,
        ping_timeout_s: float = 20.0,
        close_timeout_s: float = 3.0,
        wall: Callable[[], float] = time.time,
        tag: int = 0,
        label: str = "",
    ) -> None:
        check_url(url)
        if not api_key:
            raise ValueError("API key is required")
        self._key = api_key
        self.queue, self.feed, self.bboxes = queue, feed, bboxes
        self.backoff = backoff or Backoff()
        self.url = url
        self.user_agent = user_agent
        self.idle_timeout_s = idle_timeout_s
        self.resubscribe_min_s = resubscribe_min_s
        self._connect_kw: dict[str, Any] = {
            "compression": "deflate",
            "max_size": MAX_MESSAGE_BYTES,
            "open_timeout": open_timeout_s,
            "ping_interval": ping_interval_s,
            "ping_timeout": ping_timeout_s,
            "close_timeout": close_timeout_s,
            "proxy": None,  # 환경변수 프록시를 따라가지 않는다(키가 실린 연결의 경로를 고정)
            "user_agent_header": user_agent,
            "max_queue": 64,
        }
        self._wall = wall
        self.tag = tag  # 대기열에 넣는 원문의 구역 번호
        self.name = f"ais {label}" if label else "ais"  # 로그용
        self.redact = make_redactor(api_key)

    def subscription(self, boxes: tuple[BBox, ...]) -> str:
        return orjson.dumps(
            {"APIKey": self._key, "BoundingBoxes": to_subscription(boxes), "FilterMessageTypes": list(SUBSCRIBED_TYPES)}
        ).decode()

    async def run(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            session = asyncio.create_task(self._session())
            stopper = asyncio.create_task(stop.wait())
            try:
                await asyncio.wait({session, stopper}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                stopper.cancel()
            if not session.done():  # 종료 요청: 연결을 닫고(close_timeout 안) 끝낸다
                session.cancel()
                await asyncio.gather(session, return_exceptions=True)
                return
            try:
                reason = session.result()
            except Exception as e:  # noqa: BLE001 — 예상 밖 오류도 재연결로 흡수한다
                reason = f"unexpected error: {type(e).__name__}"
                log.exception("%s session crashed", self.name)
            reason = self.redact(reason)
            healthy = self.feed.on_disconnected(reason)
            if self.backoff.session_ended(healthy):
                log.info("%s connection was healthy for %.0f s — backoff reset", self.name, healthy or 0)
            delay = self.backoff.next_delay()
            self.feed.on_backoff(delay)
            log.warning("%s disconnected: %s — reconnecting in %.1f s", self.name, reason, delay)
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except TimeoutError:
                pass

    async def _session(self) -> str:
        """연결 하나의 수명. 끝난 이유(비밀값 없음)를 돌려준다."""
        self.feed.on_connecting()
        phase = "connect"
        try:
            async with connect(self.url, **self._connect_kw) as ws:
                boxes, version = self.bboxes.snapshot()
                phase = "subscribe"
                await asyncio.wait_for(ws.send(self.subscription(boxes)), timeout=1.0)
                limiter = SubscribeLimiter(self.resubscribe_min_s)
                limiter.mark()
                deflate = _deflate_negotiated(ws)
                self.feed.on_subscribed(format_bboxes(boxes), deflate=deflate)
                log.info("%s subscribed: bbox=%s deflate=%s", self.name, format_bboxes(boxes), deflate)
                resub = asyncio.create_task(self._resubscriber(ws, version, limiter))
                phase = "read"
                try:
                    await self._read(ws)
                finally:
                    resub.cancel()
                    await asyncio.gather(resub, return_exceptions=True)
                code, text = ws.close_code, ws.close_reason
                if code is None:
                    return "connection ended"
                return f"server closed ({code} {text[:120]})" if text else f"server closed ({code})"
        except ConnectionClosed as e:
            return _closed_reason(e)
        except TimeoutError:
            if phase == "read":
                return f"idle {self.idle_timeout_s:g} s — no messages"
            return f"{phase} timeout"
        except InvalidStatus as e:
            return f"handshake rejected: HTTP {e.response.status_code}"
        except OSError as e:
            return f"network error: {type(e).__name__}"
        except WebSocketException as e:
            return f"websocket error: {type(e).__name__}"

    async def _read(self, ws: ClientConnection) -> None:
        loop = asyncio.get_running_loop()
        put, on_message, wall, tag = self.queue.put, self.feed.on_message, self._wall, self.tag
        async with asyncio.timeout_at(loop.time() + self.idle_timeout_s) as deadline:
            async for msg in ws:
                put(msg, tag)
                if is_provider_error(msg):
                    continue  # 데이터가 아니다(모듈 설명)
                deadline.reschedule(loop.time() + self.idle_timeout_s)
                on_message(wall())

    async def _resubscriber(self, ws: ClientConnection, version: int, limiter: SubscribeLimiter) -> None:
        while True:
            await self.bboxes.wait_change(version)
            wait = limiter.wait_s()
            if wait > 0:
                await asyncio.sleep(wait)
            boxes, version = self.bboxes.snapshot()  # 기다리는 동안 또 바뀌었으면 마지막 값만
            await ws.send(self.subscription(boxes))
            limiter.mark()
            self.feed.on_resubscribed(format_bboxes(boxes))
            log.info("%s subscription updated: bbox=%s", self.name, format_bboxes(boxes))
