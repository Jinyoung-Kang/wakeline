"""aisstream.io WebSocket 수신(계약 v2 §B1, ADR-014).

- `wss://stream.aisstream.io/v0/stream` 에 permessage-deflate(compression="deflate")로 붙고, 붙자마자(1 s 안) 구독을 보낸다.
  구독 = {APIKey, BoundingBoxes, FilterMessageTypes}(문서 확인 2026-09-28). 쓰는 5개 형식만 받아 대역폭·CPU 를 줄인다.
- 받은 데이터 프레임은 파싱하지 않고 RawQueue 에 넣기만 한다(기다리지 않음). "error" 글자가 든 프레임만 공급자 오류인지 확인하려고 파싱한다(is_provider_error). 메시지 상한 1 MiB(압축 해제 후 크기에 적용), ping 20 s.
- 공급자 오류 프레임({"error": ...})도 대기열에 넣지만(정리 태스크가 가려서 provider_error 로 기록) 데이터로 세지 않는다 —
  공백을 닫거나 last_msg_at·msgs_total·수신 상태·idle 기한을 바꾸지 않는다(오류만 받고 끊기는 반복은 '회복' 이 아니다).
- 데이터 메시지가 idle_timeout_s(기본 120 s) 동안 없으면 조용히 멈춘 연결로 보고 다시 붙는다(서버가 close 프레임 없이 끊는 사례 실측).
- 끊기면 FeedState 가 공백을 열고, Backoff(1→60 s, ±20 %, 60 s 정상 연결 뒤에만 초기화) 만큼 쉬었다가 다시 붙는다.
  로그 수준은 ReconnectLog(reconnect.py)가 정한다: 받던 연결이 끊겼다가 30 s 안에 다시 받으면 INFO(누적 수), 되풀이(30 분에 3번째부터)·
  데이터 없이 끝난 연결·30 s 안에 회복하지 못함은 WARN. 공백 기록은 수준과 상관없이 그대로다.
- 구독 영역이 바뀌면(BboxState) 같은 연결에서 구독을 다시 보낸다 — 5 s 에 한 번까지, 마지막 값만.
- 진단(diag.py · ADR-014 부록 C): 메시지를 꺼낼 때마다 websockets 수신 버퍼에 남은 프레임 수와 keepalive 왕복(latency 가 바뀌면)을
  구역의 FeedState 에 남기고, 끊기면 로그에 최근 60 s 최댓값(keepalive 왕복 · 수신 버퍼 · 이벤트 루프 지연 · 대기열 머문 시간)과
  공급자 지연을 함께 적는다 — 1011 이 루프 멈춤인지, 읽기 멈춤인지, 서버의 늦은 pong 인지 가른다.
- 이 클래스는 연결(구역) 하나다. 구역이 여럿이면 AisStreamPool(pool.py)이 구역마다 하나씩 띄운다 — Backoff·FeedState·idle 기한·
  재구독 제한은 연결마다 따로, 대기열은 함께(원문에 구역 번호 tag 를 붙인다, 계약 v4 §D).

비밀값: API 키는 구독 메시지 본문에만 실린다(URL·헤더·로그에 없음). websockets 로거는 DEBUG 에서 프레임 내용을 찍으므로
WARNING 으로 고정하고, 오류 문구는 masking 규칙 + 키 문자열 치환을 거친다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Sized
from typing import Any
from urllib.parse import urlsplit

import orjson
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException
from websockets.extensions.permessage_deflate import PerMessageDeflate

from wakeline_collector.ais.backoff import Backoff, SubscribeLimiter
from wakeline_collector.ais.bbox import BBox, BboxState, format_bboxes, to_subscription
from wakeline_collector.ais.diag import DIAG_WINDOW_S
from wakeline_collector.ais.feed import FeedState
from wakeline_collector.ais.parse import SUBSCRIBED_TYPES, is_provider_error
from wakeline_collector.ais.queue import RawQueue
from wakeline_collector.ais.reconnect import RECOVER_WINDOW_S, REPEAT_WARN_COUNT, REPEAT_WINDOW_S, ReconnectLog
from wakeline_collector.masking import mask

log = logging.getLogger("ais.client")
logging.getLogger("websockets").setLevel(logging.WARNING)  # DEBUG 는 구독 프레임(API 키 포함)을 그대로 찍는다

AIS_URL = "wss://stream.aisstream.io/v0/stream"
MAX_MESSAGE_BYTES = 1 << 20
LOOPBACK = frozenset({"127.0.0.1", "localhost", "::1"})
# keepalive(고른 값, ADR-014 부록 A 결정 3): 공급자 쪽 지연이 20 s 를 넘으면 다시 붙어 지연을 끊는다.
PING_INTERVAL_S = 20.0
PING_TIMEOUT_S = 20.0
# websockets 수신 버퍼 상한(프레임 수, 고른 값): 넘으면 소켓 읽기를 멈춘다(pause_reading — 16 이하로 줄면 다시 읽음). 수신 태스크는 꺼내자마자
# 대기열에 넣고 기다리지 않으므로 이 버퍼는 이벤트 루프가 멈출 때만 찬다 — 키워도 1011 은 줄지 않고(test_ais_keepalive) 메모리 상한만 커진다
# (프레임 ≤ 1 MiB). 부록 C 측정: 정상 수신에서 버퍼 최댓값을 상태 해시 ws_queue_max 로 본다.
WS_MAX_QUEUE = 64

_warned_no_frames = False


def ws_frames(ws: object) -> Sized | None:
    """websockets 수신 버퍼(프레임 큐). 17.x 의 내부 속성(recv_messages.frames)이라 공개 API 가 아니다 — 판을 올려 없어지면 None(모름)으로
    두고 한 번 경고한다(깊이를 0 으로 채우지 않는다). 고정한 판에서 읽히는지는 test_ais_diag 가 지킨다."""
    global _warned_no_frames
    frames = getattr(getattr(ws, "recv_messages", None), "frames", None)
    if frames is not None and hasattr(frames, "__len__"):
        return frames  # type: ignore[no-any-return]
    if not _warned_no_frames:
        _warned_no_frames = True
        log.warning("websockets receive buffer depth unavailable (library internals changed) — ws_queue_max stays unknown")
    return None


def _num(v: float | None, unit: str = " s") -> str:
    return "—" if v is None else f"{v:.2f}{unit}"


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
        ping_interval_s: float = PING_INTERVAL_S,
        ping_timeout_s: float = PING_TIMEOUT_S,
        close_timeout_s: float = 3.0,
        wall: Callable[[], float] = time.time,
        tag: int = 0,
        label: str = "",
        loop_lag: Callable[[], float | None] | None = None,
        recover_window_s: float = RECOVER_WINDOW_S,
        repeat_window_s: float = REPEAT_WINDOW_S,
        repeat_warn_count: int = REPEAT_WARN_COUNT,
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
            "max_queue": WS_MAX_QUEUE,
        }
        self._wall = wall
        self.tag = tag  # 대기열에 넣는 원문의 구역 번호
        self.name = f"ais {label}" if label else "ais"  # 로그용
        self.redact = make_redactor(api_key)
        self._loop_lag = loop_lag  # 프로세스의 이벤트 루프 지연 최근 최댓값(diag.LoopLag.max_s) — 없으면 모름
        self.reconnects = ReconnectLog(
            self.name,
            feed,
            recover_window_s=recover_window_s,
            repeat_window_s=repeat_window_s,
            repeat_warn_count=repeat_warn_count,
            wall=wall,
        )

    def subscription(self, boxes: tuple[BBox, ...]) -> str:
        return orjson.dumps(
            {"APIKey": self._key, "BoundingBoxes": to_subscription(boxes), "FilterMessageTypes": list(SUBSCRIBED_TYPES)}
        ).decode()

    async def run(self, stop: asyncio.Event) -> None:
        try:
            await self._run(stop)
        finally:
            self.reconnects.close()  # 멈춘 뒤에 '회복하지 못함' 경고가 나오지 않게

    async def _run(self, stop: asyncio.Event) -> None:
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
            self.reconnects.disconnected(reason, delay, had_data=healthy is not None, context=self.diagnosis())
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

    def diagnosis(self) -> str:
        """끊김 로그에 붙이는 맥락(모르는 값은 —): 최근 창(diag.DIAG_WINDOW_S)의 최댓값과 직전 발행 창의 공급자 지연."""
        f = self.feed
        buf = f.ws_buffer.value()
        loop_lag = self._loop_lag() if self._loop_lag is not None else None
        return (
            f"last {DIAG_WINDOW_S:g} s max: keepalive rtt {_num(f.ping_rtt.value())} · ws buffer "
            f"{'—' if buf is None else int(buf)}/{self._connect_kw['max_queue']} frames · loop lag {_num(loop_lag)} · "
            f"queue wait {_num(self.queue.wait_max_s())}; provider lag p50 {_num(f.lag_p50_s)}"
        )

    async def _read(self, ws: ClientConnection) -> None:
        loop = asyncio.get_running_loop()
        put, on_message, wall, tag = self.queue.put, self.feed.on_message, self._wall, self.tag
        frames, buffer, rtt = ws_frames(ws), self.feed.ws_buffer, self.feed.ping_rtt
        latency = ws.latency  # 첫 pong 전에는 0.0 — 바뀔 때만 표본
        first = True
        async with asyncio.timeout_at(loop.time() + self.idle_timeout_s) as deadline:
            async for msg in ws:
                put(msg, tag)
                if frames is not None:
                    buffer.add(len(frames))  # 꺼내고 남은 프레임 = 수신 태스크가 늦게 돈 만큼 쌓인 것
                if ws.latency != latency:
                    latency = ws.latency
                    rtt.add(latency)
                if is_provider_error(msg):
                    continue  # 데이터가 아니다(모듈 설명)
                deadline.reschedule(loop.time() + self.idle_timeout_s)
                on_message(wall())
                if first:  # 이 연결의 첫 데이터 — 끊긴 뒤라면 회복 로그(공백은 on_message 가 닫았다)
                    first = False
                    self.reconnects.first_data()

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
