"""시스템 로그 싱크(계약 v5 §C2 · ADR-018) — 이 프로세스의 WARN·ERROR 로그를 가려서 Redis 스트림 wakeline:logs 로 보낸다.

- 루트 로거에 붙는 logging.Handler. emit 은 어느 스레드에서든(asyncio.to_thread 작업 스레드 포함) 불린다 — 가림·지문·직렬화만 하고
  잠금 안에서 대기열(deque)에 넣는다. Redis 를 기다리지 않는다(앱 스레드·이벤트 루프를 막지 않음).
- 가림(C5): 메시지·예외 메시지·스택·context 를 masking.mask 로. 한 레코드는 한 번만 가린다 — MaskFilter(루트 핸들러 · 싱크 자신)가
  이미 가린 레코드(MASKED_ATTR 표시)는 그 결과를 쓰고, 표시가 없으면(필터 없이 부른 emit) 여기서 가린다.
- 지문 fp = SHA-256(서비스 \\n 로거 \\n 예외 종류 \\n 메시지 틀) 앞 16자리. 틀 = 따옴표 안 → '…', 16진 8자 이상 → #, 숫자열 → #.
  같은 fp 는 10 s 에 1건만 — 억제한 수는 그 fp 의 다음 항목 suppressed 에(항목을 만들지 못하면 창을 닫고 수를 되돌린다).
  다음 항목이 창 안에 오지 않으면 창이 닫힌 뒤 전송 루프의 주기에 마지막 억제 발생을 항목으로 싣는다(뒤늦게 싣기 — 계약 v5 §G9:
  그 발생의 ts · 메시지 · 예외 · context, suppressed = 억제 수 − 1, 창은 그때 다시 시작). 억제 중인 발생은 지문마다 하나(마지막)만
  붙잡는다(레코드의 얕은 복사 — 예외가 있으면 트레이스백도 창이 닫힐 때까지, 약 11 s. 예외 메시지 · 트레이스백 글은 붙잡을 때 정한다).
  같은 주기에 여러 지문이면 창을 시작한 순서로 싣는다. 언어 간 벡터 schemas/vectors/log-suppression.v1.json.
- 항목 ≤ 8 KiB(직렬화 바이트, C1): 스키마 글자 상한을 먼저 맞추고, 그래도 넘으면 stack → exception.message → message 순으로 잘라
  '…(잘림 N자)' 를 붙인다(N = 가린 원문에서 뺀 글자 수 — MaskFilter 가 LOG_LIMIT 에서 먼저 자른 부분도 센다).
- 대기열 500건 · 2 MiB(보내는 중인 묶음까지 센다 — 넘으면 대기열의 오래된 것부터 버리고 센다). 전송은 이벤트 루프의 태스크 하나: 1 s 마다 또는 50건이 모이면(작업 스레드는
  call_soon_threadsafe 로 깨운다) 50건씩 파이프라인으로 XADD wakeline:logs MAXLEN ~ 3000 * e <json>. 명령은 R-43 클라이언트의 짧은
  상한 + SEND_TIMEOUT_S. Redis 오류면 그 묶음을 대기열 앞에 되돌리고 1 → 30 s 지수 백오프(그동안은 50건이 모여도 보내지 않는다).
  파이프라인이 중간에 끊기면 같은 항목이 두 번 실릴 수 있다(적어도 한 번 — 잃는 것보다 낫다).
- 재귀 금지: 싱크 자신의 경고(로거 'logsink')와 보내는 동안 남은 로그(예: redis 라이브러리)는 싣지 않는다 — 표준 출력에만.
- 자기 지표: collector heartbeat(wakeline:collector) · ais 상태 해시에 log_sent · log_dropped(싱크를 끄면 빈 값 = 모름).
  log_suppressed(항목의 suppressed 로 실린 수 — 항목을 만들 때 센다)도 함께. 싣는 대상 레코드는 대기 중(대기열 · 억제 창 안)이 아니면
  보냄 · 버림 · 억제 중 하나로 한 번씩 센다: 억제 중인 발생이 있는 지문을 지문 표 상한에서 잊거나 뒤늦게 실을 항목을 만들지 못하면
  (종료 마감을 넘김 포함) 그 발생과 싣던 억제 수를 버림으로 센다 — 조용히 잃지 않는다(실어 가던 항목을 대기열에서 버리면 그 억제 수는
  스트림에 없다 — 버림 1).
- 끄기: LOG_SINK_ENABLED=0(기본 1 — ADR-018 되돌리기).
"""

from __future__ import annotations

import asyncio
import contextvars
import copy
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
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import orjson

from wakeline_collector.masking import LOG_LIMIT, MASKED_ATTR, install_log_masking, mask, printable

log = logging.getLogger("logsink")

STREAM_LOGS = "wakeline:logs"
STREAM_MAXLEN = 3000  # XADD MAXLEN ~ 3000(ADR-018: 최악 3,000 × 8 KiB ≈ 24 MiB)
ENTRY_MAX_BYTES = 8 * 1024
QUEUE_MAX = 500
QUEUE_MAX_BYTES = 2 * 1024 * 1024
FLUSH_EVERY_S = 1.0
FLUSH_BATCH = 50
DEDUP_WINDOW_S = 10.0
DEDUP_MAX_FPS = 1000  # 억제 표의 지문 수 상한(넘으면 억제 중인 발생이 없는 지문 중 가장 오래전에 창을 시작한 것부터 잊는다)
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


def _cut(text: str, keep: int, lost: int = 0) -> str:
    """앞 keep 글자 + 잘림 표시. lost = text 에 이미 없는(가림 단계에서 먼저 잘린) 뒤쪽 글자 수 — N 에 더한다.
    keep 이 text 길이 이상이고 먼저 잘린 것도 없으면 text 그대로."""
    if keep >= len(text) and not lost:
        return text
    keep = min(keep, len(text))
    return text[:keep] + _marker(len(text) - keep + lost)


def _limit(text: str, max_chars: int, lost: int = 0) -> tuple[str, int]:
    """글자 상한(잘림 표시 포함)에 맞춘 문자열과 남긴 원문 글자 수."""
    if len(text) <= max_chars and not lost:
        return text, len(text)
    keep = min(len(text), max(0, max_chars - len(_marker(len(text) + lost))))  # 표시의 자릿수를 가장 크게 잡는다 — 늘 상한 안
    return _cut(text, keep, lost), keep


def fit_event(ev: dict[str, Any], lost: dict[str, int] | None = None) -> bytes | None:
    """ev(가린 원문이 든 항목)를 스키마 글자 상한 → 8 KiB 순으로 맞춘 직렬화 바이트. ev 를 고친다. 맞출 수 없으면 None.

    8 KiB 를 넘으면 stack → exception.message → message 순으로, 각 칸은 필요한 만큼만(이분 탐색) 자른다.
    lost: 칸('message' · 'exception.message' · 'exception.stack')마다 ev 에 넣기 전에 이미 잘린 글자 수(MaskFilter 의 LOG_LIMIT) —
    잘림 표시의 N 이 가린 원문 전체를 기준으로 하게 더한다."""
    lost = lost or {}
    exc = ev.get("exception")
    plan: list[tuple[dict[str, Any], str, int, int]] = []
    if exc:
        plan.append((exc, "stack", MAX_STACK, lost.get("exception.stack", 0)))
        if exc.get("message") is not None:
            plan.append((exc, "message", MAX_EXC_MESSAGE, lost.get("exception.message", 0)))
    plan.append((ev, "message", MAX_MESSAGE, lost.get("message", 0)))
    originals = [obj[key] for obj, key, _mx, _lo in plan]
    kept: list[int] = []
    for (obj, key, mx, gone), orig in zip(plan, originals, strict=True):
        obj[key], k = _limit(orig, mx, gone)
        kept.append(k)
    raw = orjson.dumps(ev)
    for (obj, key, _mx, gone), orig, k in zip(plan, originals, kept, strict=True):
        if len(raw) <= ENTRY_MAX_BYTES:
            return raw
        obj[key] = _cut(orig, 0, gone)
        if len(orjson.dumps(ev)) <= ENTRY_MAX_BYTES:
            lo, hi = 0, k  # lo 는 늘 맞는 값이다(표시 자릿수 때문에 크기가 1바이트씩 들쭉날쭉해도 결과는 상한 안)
            while lo < hi:
                mid = (lo + hi + 1) // 2
                obj[key] = _cut(orig, mid, gone)
                if len(orjson.dumps(ev)) <= ENTRY_MAX_BYTES:
                    lo = mid
                else:
                    hi = mid - 1
            obj[key] = _cut(orig, lo, gone)
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
    """가린 글 전체. UTF-8 로 적을 수 없는 글자는 \\udcXX 로(지문 · JSON 이 UTF-8 을 요구한다 — 버리지 않는다)."""
    return printable(mask(text, None) or "")


def _masked_capped(text: str) -> tuple[str, int]:
    """가린 글의 앞 LOG_LIMIT 글자와 그 뒤로 잘린 글자 수 — MaskFilter 와 같은 모양(어느 쪽이 가렸든 지문 · 잘림 표시가 같게)."""
    out = _masked(text)
    return out[:LOG_LIMIT], max(0, len(out) - LOG_LIMIT)


def _was_masked(text: str, whole: dict[str, int], field: str) -> tuple[str, int]:
    """MaskFilter 가 가리고 LOG_LIMIT 에서 자른 칸과 그 뒤로 잘린 글자 수(표시가 말하는 자르기 전 길이 − 남은 길이)."""
    return text, max(0, int(whole.get(field, len(text))) - len(text))


def _exc_of(record: logging.LogRecord) -> BaseException | None:
    return record.exc_info[1] if record.exc_info and record.exc_info[1] is not None else None


def _exc_str(exc: BaseException) -> str:
    """예외 메시지(str). 예외의 __str__ 이 실패하면 빈 값."""
    try:
        return str(exc)
    except Exception:  # noqa: BLE001
        return ""


def _stderr(text: str) -> None:
    try:
        sys.stderr.write(text + "\n")
    except Exception:  # noqa: BLE001, S110 — 표준 오류마저 못 쓰면 더 할 수 있는 것이 없다
        pass


# ── 억제 상태 ───────────────────────────────────────────────────


@dataclass(slots=True)
class _Occurrence:
    """항목 하나의 재료(가린 메시지 · 로거 · 예외 종류는 지문을 구하며 이미 만들었다). 스택 가림 · 직렬화는 싣기로 정한 뒤에만."""

    record: logging.LogRecord
    whole: dict[str, int] | None
    lost: dict[str, int]
    message: str
    logger: str
    exc_type: str
    exc_str: str | None = None  # 붙잡을 때 정한 예외 메시지(가리기 전) — None 이면 항목을 만들 때(곧 발생 때) str(exc)

    def held(self) -> _Occurrence:
        """억제해 붙잡아 둘 때: 레코드를 얕게 복사한다 — 뒤 핸들러(표준 출력 형식기 등)가 레코드를 고쳐도 발생 때의 값으로 만든다.
        예외 메시지 · 트레이스백 글도 지금 정한다(§G9 — 발생 때의 값): 항목은 약 10 s 뒤 전송 루프에서 만들어지는데, 그사이 예외 객체가
        바뀌면(args 고침 등) 메시지가 제 스택과 어긋나고, 예외의 __str__ 이 이벤트 루프에서 돈다. 트레이스백은 MaskFilter 가 이미 글로
        만들었으면(운영 — start 가 붙인다) 그대로, 필터 없이 부른 emit 이면 여기서 만든다(가림은 전처럼 싣기로 정한 뒤)."""
        record = copy.copy(self.record)
        exc = _exc_of(record)
        if exc is not None and record.exc_text is None and record.exc_info:
            record.exc_text = _FMT.formatException(record.exc_info)
        return _Occurrence(
            record,
            self.whole,
            dict(self.lost),
            self.message,
            self.logger,
            self.exc_type,
            _exc_str(exc) if exc is not None else None,
        )


@dataclass(slots=True)
class _Track:
    """지문 하나의 억제 상태(_mu 로 보호)."""

    sent_at: float = float("-inf")  # 창의 시작 — 이 지문의 항목을 마지막으로 만든 시각(뒤늦게 실었으면 그 시각). -inf = 창 없음
    pending: int = 0  # 그 뒤 억제한 수 — 아직 어느 항목에도 실리지 않았다
    last: _Occurrence | None = None  # 마지막 억제 발생(pending > 0 이면 늘 있다)


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
        self._inflight: list[tuple[str, int]] = []  # 보내는 중인 묶음 — 대기열 상한에 함께 센다
        self._inflight_bytes = 0
        self._recent: dict[str, _Track] = {}  # fp → 억제 상태(삽입 순서 = 창을 시작한 순서, 오래된 것부터)
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
        # MaskFilter 가 이미 가린 레코드: 칸은 LOG_LIMIT 에서 잘렸고 자르기 전 길이가 whole 에 있다(다시 가리지 않는다)
        whole = getattr(record, MASKED_ATTR, None)
        whole = whole if isinstance(whole, dict) else None
        lost: dict[str, int] = {}
        try:
            text = record.getMessage()
        except Exception:  # noqa: BLE001 — 형식이 틀린 로그도 원문 형식 문자열로 싣는다
            text = str(record.msg)
        message, lost["message"] = _was_masked(text, whole, "msg") if whole is not None else _masked_capped(text)
        exc = _exc_of(record)
        exc_type = _limit(printable(_type_name(exc)), MAX_EXC_TYPE)[0] if exc is not None else ""
        logger = _limit(printable(record.name), MAX_LOGGER)[0]
        fp = fingerprint(self.service, logger, exc_type, message)
        occ = _Occurrence(record, whole, lost, message, logger, exc_type)
        admitted = self._admit(fp, occ)
        if admitted is None:
            return None
        carried, held = admitted
        try:
            raw = self._event(occ, fp, carried)
        except BaseException:
            self._give_back(fp, carried, held)
            raise
        if raw is None:
            self._give_back(fp, carried, held)
            with self._mu:
                self.dropped += 1
            return None
        if carried:
            with self._mu:
                self.suppressed += carried
        return raw.decode("utf-8"), len(raw)

    def _event(self, occ: _Occurrence, fp: str, carried: int) -> bytes | None:
        """LogEvent 직렬화 바이트(8 KiB 안). 맞출 수 없으면 None."""
        record, whole, lost = occ.record, occ.whole, occ.lost
        exc = _exc_of(record)
        exception: dict[str, Any] | None = None
        if exc is not None and record.exc_info:
            exc_msg = occ.exc_str if occ.exc_str is not None else _exc_str(exc)  # 붙잡은 발생은 붙잡을 때 정한 것
            if whole is not None and record.exc_text is not None:
                stack, lost["exception.stack"] = _was_masked(record.exc_text, whole, "exc_text")
            else:
                stack, lost["exception.stack"] = _masked_capped(record.exc_text or _FMT.formatException(record.exc_info))
            exc_message, lost["exception.message"] = _masked_capped(exc_msg)  # 예외 메시지는 MaskFilter 가 따로 가리지 않는다
            exception = {"type": occ.exc_type, "message": exc_message or None, "stack": stack}
        ev: dict[str, Any] = {
            "v": 1,
            "ts": _iso_ms(record.created),
            "service": self.service,
            "instance": self.instance,
            "level": "ERROR" if record.levelno >= logging.ERROR else "WARN",
            "logger": occ.logger,
            "thread": _limit(printable(record.threadName), MAX_THREAD)[0] if record.threadName else None,
            "message": occ.message,
            "exception": exception,
            "fp": fp,
            "request_id": None,  # 요청 id 는 api MDC 에만 있다 — 수집기·ais 는 늘 null
            "context": _context(record),
            "suppressed": carried,
        }
        return fit_event(ev, lost)

    def _admit(self, fp: str, occ: _Occurrence) -> tuple[int, _Occurrence | None] | None:
        """같은 fp 를 DEDUP_WINDOW_S 안에 이미 실었으면 억제(None) — 이 발생을 그 지문의 마지막 억제 발생으로 붙잡아 둔다(창이 닫히면
        flush_trailing 이 싣는다). 아니면 (실을 억제 수, 그 수에 합친 마지막 억제 발생 — 항목을 만들지 못하면 되돌린다)."""
        now = self._clock()
        with self._mu:
            seen = self._recent.get(fp)
            if seen is not None and now - seen.sent_at < DEDUP_WINDOW_S:
                seen.pending += 1
                seen.last = occ.held()
                return None
            if seen is None:
                if len(self._recent) >= DEDUP_MAX_FPS:
                    self._forget_locked()
                seen = _Track()
            else:
                del self._recent[fp]
            carried, held = seen.pending, seen.last
            seen.sent_at, seen.pending, seen.last = now, 0, None
            self._recent[fp] = seen  # 끝으로 — 삽입 순서 = 창을 시작한 순서
            return carried, held

    def _forget_locked(self) -> None:
        """_mu 안에서, 지문 표가 가득일 때 하나를 잊는다: 억제 중인 발생이 없는 지문 중 가장 오래전에 창을 시작한 것(창 안이면 그 지문의
        다음 발생이 조금 일찍 실릴 뿐 잃는 발생은 없다). 모든 지문에 억제 중인 발생이 있으면 가장 오래된 것 — 그 억제 중인 수는
        어느 항목에도 실리지 못하므로 버림으로 센다."""
        victim = next((fp for fp, seen in self._recent.items() if not seen.pending), None)
        if victim is None:
            victim = next(iter(self._recent))
        self.dropped += self._recent.pop(victim).pending

    def _give_back(self, fp: str, carried: int, held: _Occurrence | None) -> None:
        """_admit 이 창을 연 항목을 대기열에 넣지 못했다: 보낸 것이 없으니 창을 닫고, 실어 가던 억제 수와 그 마지막 억제 발생을
        되돌린다(다음 항목 · 주기가 싣는다 — 그사이 새로 억제한 발생이 있으면 그것이 마지막)."""
        with self._mu:
            seen = self._recent.get(fp)
            if seen is None:
                self.dropped += carried  # 그사이 지문 표에서 잊혔다 — 되돌릴 곳이 없다
                return
            seen.sent_at = float("-inf")
            seen.pending += carried
            if seen.last is None:
                seen.last = held

    def flush_trailing(self, *, everything: bool = False, deadline: float | None = None) -> int:
        """계약 v5 §G9 뒤늦게 싣기: 억제 중인 발생(k건)이 있고 창이 닫힌(everything 이면 창과 무관하게 — 종료 때) 지문마다 마지막 억제
        발생 하나로 항목을 만들어(ts · 메시지 · 예외 · context 는 그 발생의 것) suppressed = k − 1 로 대기열에 넣는다. 그 지문의 창은
        지금 다시 시작한다(억제 수 0). 항목을 만들지 못하거나(8 KiB 에 못 맞춤 · 예외) deadline(time.monotonic 기준)을 넘기면 그 k건을
        버림으로 센다. 전송 루프의 주기마다 · aclose 가 부른다. 반환: 대기열에 넣은 항목 수."""
        now = self._clock()
        due: list[tuple[str, int, _Occurrence | None]] = []
        with self._mu:
            for fp, seen in self._recent.items():
                if seen.pending and (everything or now - seen.sent_at >= DEDUP_WINDOW_S):
                    due.append((fp, seen.pending, seen.last))
            for fp, _k, _occ in due:
                seen = self._recent.pop(fp)
                seen.sent_at, seen.pending, seen.last = now, 0, None
                self._recent[fp] = seen  # 창을 지금 다시 시작 — 끝으로
        queued = 0
        for fp, k, occ in due:
            raw: bytes | None = None
            if occ is not None and (deadline is None or time.monotonic() <= deadline):
                try:
                    raw = self._event(occ, fp, k - 1)
                except Exception as e:  # noqa: BLE001 — 한 건 때문에 전송 루프 · 종료가 멈추지 않게(원문은 찍지 않는다 — 비밀값)
                    _stderr(f"logsink: dropped a trailing entry of {occ.record.name!s:.200} ({type(e).__name__})")
            with self._mu:
                if raw is None:
                    self.dropped += k
                    continue
                self.suppressed += k - 1
            self._enqueue(raw.decode("utf-8"), len(raw))
            queued += 1
        return queued

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
        """대기열 + 보내는 중인 묶음이 상한(건수 · 바이트) 안이 될 때까지 대기열의 오래된 것부터 버린다(보내는 중인 묶음은 두고)."""
        while self._q and (
            len(self._q) + len(self._inflight) > self.queue_max or self._qbytes + self._inflight_bytes > self.queue_max_bytes
        ):
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
            return {"log_sent": str(self.sent), "log_dropped": str(self.dropped), "log_suppressed": str(self.suppressed)}

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
                    self._inflight, self._inflight_bytes = [], 0
                    self.sent += len(batch)
                sent += len(batch)
            return sent
        finally:
            _SENDING.reset(token)

    def _take(self) -> list[tuple[str, int]]:
        with self._mu:
            batch = [self._q.popleft() for _ in range(min(self.batch, len(self._q)))]
            size = sum(n for _js, n in batch)
            self._qbytes -= size
            self._inflight, self._inflight_bytes = batch, size
            return batch

    def _put_back(self, batch: list[tuple[str, int]]) -> None:
        with self._mu:
            self._inflight, self._inflight_bytes = [], 0
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
            self.flush_trailing()  # 창이 닫힌 지문의 억제 발생(§G9) — 이 주기에서, 새 태스크 없이
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
            # 레코드를 가리고 표시를 단다 — 표준 출력 핸들러의 필터가 먼저 가렸으면 그대로 둔다(한 레코드에 한 번)
            install_log_masking(self)
            root.addHandler(self)
            self._attached = True
        self._task = asyncio.create_task(self.run(), name="logsink")

    async def aclose(self, drain_s: float = CLOSE_S) -> None:
        """루트 로거에서 떼고, 전송 루프를 멈추고, 억제 중인 발생을 창과 무관하게 뒤늦게 싣고(§G9 — 뒤에 올 주기가 없다), 남은 항목을
        보낸다(백오프와 상관없이 한 번). 둘 다 같은 마감(drain_s) 안 — 넘기면 만들지 못한 발생은 버림으로 센다."""
        if self._attached:
            logging.getLogger().removeHandler(self)
            self._attached = False
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        deadline = time.monotonic() + drain_s
        self.flush_trailing(everything=True, deadline=deadline)
        try:
            async with asyncio.timeout(max(0.0, deadline - time.monotonic())):
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
    """heartbeat · ais 상태 해시의 log_sent · log_dropped · log_suppressed(프로세스 기동 뒤 누계).
    싱크를 껐으면 빈 값(모름 — 0 으로 채우지 않는다)."""
    return sink.metrics() if sink is not None else {"log_sent": "", "log_dropped": "", "log_suppressed": ""}
