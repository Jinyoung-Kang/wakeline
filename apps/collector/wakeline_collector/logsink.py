"""시스템 로그 싱크(계약 v5 §C2 · ADR-018) — 이 프로세스의 WARN·ERROR 로그를 가려서 Redis 스트림 wakeline:logs 로 보낸다.

- 루트 로거에 붙는 logging.Handler. emit 은 어느 스레드에서든(asyncio.to_thread 작업 스레드 포함) 불린다 — 가림·지문·직렬화만 하고
  잠금 안에서 대기열(deque)에 넣는다. Redis 를 기다리지 않는다(앱 스레드·이벤트 루프를 막지 않음).
- 가림(C5): 메시지·예외 메시지·스택·context 를 masking.mask 로. 루트 핸들러의 MaskFilter 가 먼저 돌았는지와 상관없이 여기서 다시 가린다.
- 지문 fp = SHA-256(서비스 \\n 로거 \\n 예외 종류 \\n 메시지 틀) 앞 16자리. 틀 = 따옴표 안 → '…', 16진 8자 이상 → #, 숫자열 → #.
  같은 fp 는 10 s 에 1건만 — 억제한 수는 그 fp 의 다음 항목 suppressed 에.
- 항목 ≤ 8 KiB(직렬화 바이트, C1): 스키마 글자 상한을 먼저 맞추고, 그래도 넘으면 stack → exception.message → message 순으로 잘라
  '…(잘림 N자)' 를 붙인다(N = 가린 원문에서 뺀 글자 수).
- 대기열 500건 · 2 MiB(넘으면 오래된 것부터 버리고 센다). 전송은 이벤트 루프의 태스크 하나: 1 s 마다 또는 50건이 모이면(작업 스레드는
  call_soon_threadsafe 로 깨운다) 50건씩 파이프라인으로 XADD wakeline:logs MAXLEN ~ 3000 * e <json>. 명령은 R-43 클라이언트의 짧은
  상한 + SEND_TIMEOUT_S. Redis 오류면 그 묶음을 대기열 앞에 되돌리고 1 → 30 s 지수 백오프(그동안은 50건이 모여도 보내지 않는다).
  파이프라인이 중간에 끊기면 같은 항목이 두 번 실릴 수 있다(적어도 한 번 — 잃는 것보다 낫다).
- 재귀 금지: 싱크 자신의 경고(로거 'logsink')와 보내는 동안 남은 로그(예: redis 라이브러리)는 싣지 않는다 — 표준 출력에만.
- 자기 지표: collector heartbeat(wakeline:collector) · ais 상태 해시에 log_sent · log_dropped(싱크를 끄면 빈 값 = 모름).
- 끄기: LOG_SINK_ENABLED=0(기본 1 — ADR-018 되돌리기).
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import logging
import os
import re
import socket
import sys
import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import orjson

from wakeline_collector.masking import LOG_LIMIT, install_log_masking, mask

log = logging.getLogger("logsink")

STREAM_LOGS = "wakeline:logs"
STREAM_MAXLEN = 3000  # XADD MAXLEN ~ 3000(ADR-018: 최악 3,000 × 8 KiB ≈ 24 MiB)
ENTRY_MAX_BYTES = 8 * 1024
QUEUE_MAX = 500
QUEUE_MAX_BYTES = 2 * 1024 * 1024
FLUSH_EVERY_S = 1.0
FLUSH_BATCH = 50
DEDUP_WINDOW_S = 10.0
DEDUP_MAX_FPS = 1000  # 억제 표의 지문 수 상한(넘으면 가장 오래 전에 보낸 지문부터 잊는다)
BACKOFF_MIN_S, BACKOFF_MAX_S = 1.0, 30.0
SEND_TIMEOUT_S = 2.0  # 묶음 하나(≤ 50건 파이프라인)의 상한 — REDIS_SOCKET_TIMEOUT_S 와 같다
CLOSE_S = 0.5  # 종료 때 남은 항목을 보내는 상한(compose 종료 유예 안 — collector 30 s · ais 10 s)
WARN_EVERY_S = 60.0

# schemas/log_event.v1.json 의 글자 상한
MAX_INSTANCE, MAX_LOGGER, MAX_THREAD, MAX_MESSAGE = 64, 200, 100, 4000
MAX_EXC_TYPE, MAX_EXC_MESSAGE, MAX_STACK = 200, 2000, 12000
MAX_CONTEXT_KEYS, MAX_CONTEXT_VALUE = 20, 200

_SENDING: contextvars.ContextVar[bool] = contextvars.ContextVar("wakeline_logsink_sending", default=False)
_QUOTED = re.compile(r"'[^'\n]*'|\"[^\"\n]*\"")
_HEX = re.compile(r"(?:0[xX])?[0-9A-Fa-f]{8,}")
_DIGITS = re.compile(r"\d+")
_FMT = logging.Formatter()


# ── 순수 함수(시험·계약 검사에서 직접 쓴다) ─────────────────────


def message_template(text: str) -> str:
    """지문용 메시지 틀: 따옴표 안 문자열 → '…', 16진 8자 이상(0x 포함) → #, 숫자열 → #. 순서대로(따옴표 안 숫자는 따로 세지 않게)."""
    return _DIGITS.sub("#", _HEX.sub("#", _QUOTED.sub("'…'", text)))


def fingerprint(service: str, logger: str, exc_type: str, message: str) -> str:
    """fp = SHA-256(서비스 \\n 로거 \\n 예외 종류(없으면 빈 값) \\n 메시지 틀)의 앞 16자리 16진. 서비스 안에서만 비교한다."""
    raw = "\n".join((service, logger, exc_type, message_template(message)))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def backoff_delay(failures: int, lo: float = BACKOFF_MIN_S, hi: float = BACKOFF_MAX_S) -> float:
    """연속 실패 수(1부터) → 다시 보내기까지의 대기(1 · 2 · 4 · … · 30 s)."""
    return min(hi, lo * 2 ** max(0, failures - 1))


def _marker(cut: int) -> str:
    return f"…(잘림 {cut}자)"


def _cut(text: str, keep: int) -> str:
    """앞 keep 글자 + 잘림 표시(원문에서 뺀 글자 수). keep 이 원문 길이 이상이면 원문 그대로."""
    if keep >= len(text):
        return text
    return text[:keep] + _marker(len(text) - keep)


def _limit(text: str, max_chars: int) -> tuple[str, int]:
    """글자 상한(잘림 표시 포함)에 맞춘 문자열과 남긴 원문 글자 수."""
    if len(text) <= max_chars:
        return text, len(text)
    keep = max(0, max_chars - len(_marker(len(text))))  # 표시의 자릿수를 가장 크게 잡는다 — 결과는 늘 상한 안
    return _cut(text, keep), keep


def fit_event(ev: dict[str, Any]) -> bytes | None:
    """ev(가린 원문이 든 항목)를 스키마 글자 상한 → 8 KiB 순으로 맞춘 직렬화 바이트. ev 를 고친다. 맞출 수 없으면 None.

    8 KiB 를 넘으면 stack → exception.message → message 순으로, 각 칸은 필요한 만큼만(이분 탐색) 자른다."""
    exc = ev.get("exception")
    plan: list[tuple[dict[str, Any], str, int]] = []
    if exc:
        plan.append((exc, "stack", MAX_STACK))
        if exc.get("message") is not None:
            plan.append((exc, "message", MAX_EXC_MESSAGE))
    plan.append((ev, "message", MAX_MESSAGE))
    originals = [obj[key] for obj, key, _mx in plan]
    kept: list[int] = []
    for (obj, key, mx), orig in zip(plan, originals, strict=True):
        obj[key], k = _limit(orig, mx)
        kept.append(k)
    raw = orjson.dumps(ev)
    for (obj, key, _mx), orig, k in zip(plan, originals, kept, strict=True):
        if len(raw) <= ENTRY_MAX_BYTES:
            return raw
        obj[key] = _cut(orig, 0)
        if len(orjson.dumps(ev)) <= ENTRY_MAX_BYTES:
            lo, hi = 0, k  # lo 는 늘 맞는 값이다(표시 자릿수 때문에 크기가 1바이트씩 들쭉날쭉해도 결과는 상한 안)
            while lo < hi:
                mid = (lo + hi + 1) // 2
                obj[key] = _cut(orig, mid)
                if len(orjson.dumps(ev)) <= ENTRY_MAX_BYTES:
                    lo = mid
                else:
                    hi = mid - 1
            obj[key] = _cut(orig, lo)
        raw = orjson.dumps(ev)
    if len(raw) > ENTRY_MAX_BYTES and ev.get("context"):
        ev["context"] = {}  # 세 칸을 다 비워도 넘는 경우(여기까지 오지 않는다 — 다른 칸은 모두 짧은 상한) 보조 정보를 뺀다
        raw = orjson.dumps(ev)
    return raw if len(raw) <= ENTRY_MAX_BYTES else None


def default_instance() -> str:
    """호스트명:pid(64자 안 — 넘으면 호스트명을 줄이고 pid 는 남긴다). 컨테이너의 호스트명은 컨테이너 id 앞부분이다."""
    suffix = f":{os.getpid()}"
    return socket.gethostname()[: MAX_INSTANCE - len(suffix)] + suffix


def _iso_ms(epoch: float) -> str:
    dt = datetime.fromtimestamp(epoch, UTC)
    return f"{dt:%Y-%m-%dT%H:%M:%S}.{dt.microsecond // 1000:03d}Z"


def _type_name(exc: BaseException) -> str:
    t = type(exc)
    return t.__qualname__ if t.__module__ == "builtins" else f"{t.__module__}.{t.__qualname__}"


def _masked(text: str) -> str:
    return mask(text, LOG_LIMIT) or ""


def _stderr(text: str) -> None:
    try:
        sys.stderr.write(text + "\n")
    except Exception:  # noqa: BLE001, S110 — 표준 오류마저 못 쓰면 더 할 수 있는 것이 없다
        pass


# ── 핸들러 ──────────────────────────────────────────────────────


class LogSink(logging.Handler):
    def __init__(
        self,
        service: str,
        redis: Any,
        *,
        instance: str | None = None,
        clock: Callable[[], float] = time.monotonic,
        queue_max: int = QUEUE_MAX,
        queue_max_bytes: int = QUEUE_MAX_BYTES,
        flush_every_s: float = FLUSH_EVERY_S,
        batch: int = FLUSH_BATCH,
        send_timeout_s: float = SEND_TIMEOUT_S,
        backoff: tuple[float, float] = (BACKOFF_MIN_S, BACKOFF_MAX_S),
    ) -> None:
        super().__init__(level=logging.WARNING)
        self.service = service
        self.instance = instance or default_instance()
        self._r = redis
        self._clock = clock
        self.queue_max, self.queue_max_bytes = queue_max, queue_max_bytes
        self.flush_every_s, self.batch, self.send_timeout_s, self.backoff = flush_every_s, batch, send_timeout_s, backoff
        self._mu = threading.Lock()  # 대기열·억제 표·지표(emit 은 어느 스레드에서든, 전송은 이벤트 루프에서)
        self._q: deque[tuple[str, int]] = deque()  # (JSON, 바이트 수)
        self._qbytes = 0
        self._inflight: list[tuple[str, int]] = []
        self._recent: dict[str, list[float]] = {}  # fp → [마지막 전송 시각, 그 뒤 억제 수](삽입 순서 = 오래된 순)
        self._wake = asyncio.Event()
        self._wake_requested = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[None] | None = None
        self._attached = False
        self._retry_at: float | None = None
        self._last_warn = float("-inf")
        self.sent = 0
        self.dropped = 0
        self.suppressed = 0
        self.failures = 0  # 연속 전송 실패(성공하면 0)

    # ── emit(앱 스레드) ──────────────────────────────────────────

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno < logging.WARNING or _SENDING.get() or record.name == log.name:
            return  # 재귀 금지: 싱크 자신의 로그 · 보내는 중에 남은 로그는 표준 출력에만
        try:
            built = self._build(record)
        except Exception as e:  # noqa: BLE001 — 로그 한 건 때문에 앱이 멈추지 않게(원문은 찍지 않는다 — 비밀값)
            with self._mu:
                self.dropped += 1
            _stderr(f"logsink: dropped a log record from {record.name!s:.200} ({type(e).__name__})")
            return
        if built is not None:
            self._enqueue(*built)

    def _build(self, record: logging.LogRecord) -> tuple[str, int] | None:
        """(JSON, 바이트 수). 억제했으면 None."""
        try:
            text = record.getMessage()
        except Exception:  # noqa: BLE001 — 형식이 틀린 로그도 원문 형식 문자열로 싣는다
            text = str(record.msg)
        message = _masked(text)
        exc = record.exc_info[1] if record.exc_info and record.exc_info[1] is not None else None
        exc_type = _limit(_type_name(exc), MAX_EXC_TYPE)[0] if exc is not None else ""
        logger = _limit(record.name, MAX_LOGGER)[0]
        fp = fingerprint(self.service, logger, exc_type, message)
        carried = self._admit(fp)
        if carried is None:
            return None
        exception: dict[str, Any] | None = None
        if exc is not None and record.exc_info:
            try:
                exc_msg = str(exc)
            except Exception:  # noqa: BLE001
                exc_msg = ""
            stack = record.exc_text or _FMT.formatException(record.exc_info)
            exception = {"type": exc_type, "message": _masked(exc_msg) or None, "stack": _masked(stack)}
        ev: dict[str, Any] = {
            "v": 1,
            "ts": _iso_ms(record.created),
            "service": self.service,
            "instance": self.instance,
            "level": "ERROR" if record.levelno >= logging.ERROR else "WARN",
            "logger": logger,
            "thread": _limit(record.threadName, MAX_THREAD)[0] if record.threadName else None,
            "message": message,
            "exception": exception,
            "fp": fp,
            "request_id": None,  # 요청 id 는 api MDC 에만 있다 — 수집기·ais 는 늘 null
            "context": _context(record),
            "suppressed": carried,
        }
        raw = fit_event(ev)
        if raw is None:
            with self._mu:
                self.dropped += 1
            return None
        return raw.decode("utf-8"), len(raw)

    def _admit(self, fp: str) -> int | None:
        """같은 fp 를 DEDUP_WINDOW_S 안에 이미 보냈으면 억제(None). 아니면 보낼 항목에 실을 억제 수."""
        now = self._clock()
        with self._mu:
            seen = self._recent.get(fp)
            if seen is not None and now - seen[0] < DEDUP_WINDOW_S:
                seen[1] += 1
                self.suppressed += 1
                return None
            carried = int(seen[1]) if seen is not None else 0
            self._recent.pop(fp, None)
            self._recent[fp] = [now, 0]
            while len(self._recent) > DEDUP_MAX_FPS:
                del self._recent[next(iter(self._recent))]
            return carried

    def _enqueue(self, js: str, n: int) -> None:
        with self._mu:
            self._q.append((js, n))
            self._qbytes += n
            self._trim_locked()
            wake = len(self._q) >= self.batch and not self._wake_requested
            if wake:
                self._wake_requested = True
        if wake:
            self._notify()

    def _trim_locked(self) -> None:
        while self._q and (len(self._q) > self.queue_max or self._qbytes > self.queue_max_bytes):
            _js, n = self._q.popleft()
            self._qbytes -= n
            self.dropped += 1

    def _notify(self) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return  # 전송 루프 전(또는 뒤) — 다음 틱 · 종료 전송이 가져간다
        try:
            loop.call_soon_threadsafe(self._wake.set)  # 작업 스레드에서도 안전하게 전송 루프를 깨운다
        except RuntimeError:
            pass

    # ── 전송(이벤트 루프) ─────────────────────────────────────────

    def pending(self) -> list[tuple[str, int]]:
        """보내는 중인 묶음 + 대기열(오래된 순)."""
        with self._mu:
            return [*self._inflight, *self._q]

    def metrics(self) -> dict[str, str]:
        with self._mu:
            return {"log_sent": str(self.sent), "log_dropped": str(self.dropped)}

    async def send_pending(self) -> int:
        """대기열을 FLUSH_BATCH 건씩 XADD 한다. 반환: 보낸 건수. 실패하면 그 묶음을 대기열 앞에 되돌리고 예외를 올린다."""
        with self._mu:
            self._wake_requested = False
        token = _SENDING.set(True)
        try:
            sent = 0
            while batch := self._take():
                try:
                    async with asyncio.timeout(self.send_timeout_s):
                        pipe = self._r.pipeline(transaction=False)
                        for js, _n in batch:
                            pipe.xadd(STREAM_LOGS, {"e": js}, maxlen=STREAM_MAXLEN, approximate=True)
                        await pipe.execute()
                except BaseException:  # 취소(종료) 포함 — 보내지 못한 묶음은 버리지 않는다
                    self._put_back(batch)
                    raise
                with self._mu:
                    self._inflight = []
                    self.sent += len(batch)
                sent += len(batch)
            return sent
        finally:
            _SENDING.reset(token)

    def _take(self) -> list[tuple[str, int]]:
        with self._mu:
            batch = [self._q.popleft() for _ in range(min(self.batch, len(self._q)))]
            self._qbytes -= sum(n for _js, n in batch)
            self._inflight = batch
            return batch

    def _put_back(self, batch: list[tuple[str, int]]) -> None:
        with self._mu:
            self._inflight = []
            self._q.extendleft(reversed(batch))
            self._qbytes += sum(n for _js, n in batch)
            self._trim_locked()  # 그사이 새 항목이 들어와 상한을 넘으면 오래된 것(되돌린 묶음)부터 버린다

    async def run(self) -> None:
        """전송 루프: FLUSH_EVERY_S 마다 또는 FLUSH_BATCH 건이 모이면 보낸다. 실패하면 1 → 30 s 백오프. aclose 가 취소한다."""
        while True:
            now = self._clock()
            due = self._retry_at if self._retry_at is not None else now + self.flush_every_s
            try:
                async with asyncio.timeout(max(0.0, due - now)):
                    await self._wake.wait()
            except TimeoutError:
                pass
            self._wake.clear()
            if self._retry_at is not None and self._clock() < self._retry_at:
                continue  # 백오프 중 — 50건이 모여 깨워도 기다린다(대기열 상한이 메모리를 지킨다)
            await self._attempt()

    async def _attempt(self) -> None:
        try:
            await self.send_pending()
        except Exception as e:  # noqa: BLE001 — Redis 장애·권한 거부·시간 초과 모두 같은 백오프
            self.failures += 1
            delay = backoff_delay(self.failures, *self.backoff)
            self._retry_at = self._clock() + delay
            self._warn(
                "log sink: XADD %s failed (%s) — %d entr(ies) kept, %d dropped so far, retry in %.1f s",
                STREAM_LOGS,
                type(e).__name__,
                len(self.pending()),
                self.dropped,
                delay,
            )
            return
        if self.failures:
            log.info("log sink: sending again after %d failed attempt(s)", self.failures)
        self.failures, self._retry_at = 0, None

    def _warn(self, msg: str, *args: object) -> None:
        now = self._clock()
        if now - self._last_warn >= WARN_EVERY_S:
            self._last_warn = now
            log.warning(msg, *args)

    # ── 설치 · 해제 ──────────────────────────────────────────────

    def start(self, *, attach: bool = True) -> None:
        """전송 루프를 이벤트 루프의 태스크로 띄우고(attach 면) 루트 로거에 붙인다. install_log_masking 뒤에 부른다."""
        self._loop = asyncio.get_running_loop()
        if attach:
            root = logging.getLogger()
            for h in list(root.handlers):  # 한 프로세스에 싱크는 하나(시험에서 main 을 여러 번 돌려도 쌓이지 않게)
                if isinstance(h, LogSink) and h is not self:
                    root.removeHandler(h)
            install_log_masking(self)  # 레코드 자체도 가린다(방어적 — _build 가 어차피 다시 가린다)
            root.addHandler(self)
            self._attached = True
        self._task = asyncio.create_task(self.run(), name="logsink")

    async def aclose(self, drain_s: float = CLOSE_S) -> None:
        """루트 로거에서 떼고, 전송 루프를 멈추고, 남은 항목을 drain_s 안에서 보낸다(백오프와 상관없이 한 번)."""
        if self._attached:
            logging.getLogger().removeHandler(self)
            self._attached = False
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        try:
            async with asyncio.timeout(drain_s):
                await self.send_pending()
        except Exception as e:  # noqa: BLE001 — 종료를 막지 않는다
            log.warning("log sink: %d entr(ies) not sent at shutdown (%s)", len(self.pending()), type(e).__name__)


def _context(record: logging.LogRecord) -> dict[str, Any]:
    """스레드 이름(thread 칸) 외의 보조 정보: asyncio 태스크 이름 · 모듈 · 함수 · 줄(값 200자 · 20키 이하, 가린 뒤)."""
    ctx: dict[str, Any] = {}
    task = getattr(record, "taskName", None)
    if task:
        ctx["task"] = task
    ctx.update(module=record.module, func=record.funcName, line=record.lineno)
    return {
        k: _limit(_masked(v), MAX_CONTEXT_VALUE)[0] if isinstance(v, str) else v for k, v in list(ctx.items())[:MAX_CONTEXT_KEYS]
    }


# ── main 에서 쓰는 도우미 ────────────────────────────────────────


def start_log_sink(service: str, redis: Any, *, enabled: bool) -> LogSink | None:
    """service('collector' · 'ais')의 싱크를 루트 로거에 붙이고 전송 루프를 띄운다. enabled=False(LOG_SINK_ENABLED=0)면 None."""
    if not enabled:
        log.info("log sink disabled (LOG_SINK_ENABLED=0) — WARN/ERROR stay in stdout only")
        return None
    sink = LogSink(service, redis)
    sink.start()
    return sink


async def close_log_sink(sink: LogSink | None, drain_s: float = CLOSE_S) -> None:
    if sink is not None:
        await sink.aclose(drain_s)


def sink_metrics(sink: LogSink | None) -> dict[str, str]:
    """heartbeat · ais 상태 해시의 log_sent · log_dropped(프로세스 기동 뒤 누계). 싱크를 껐으면 빈 값(모름 — 0 으로 채우지 않는다)."""
    return sink.metrics() if sink is not None else {"log_sent": "", "log_dropped": ""}
