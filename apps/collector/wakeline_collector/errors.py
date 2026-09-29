"""운영 화면(공급자 상태 last_error)·실행 기록(ingest_run.error_text)·작업 로그에 싣는 오류 문구 — 한 곳에서 만든다.

repr(e) 는 읽히지 않았다: "ProviderHttpError('HTTP 429: <html>\\r\\n<head><title>429 To…" · "ReadTimeout('')" · "ConnectError('')".
규칙(앞머리는 늘 예외 종류 — 로그 지문 fp 가 종류별로 묶인다. HTTP 오류는 'HTTP <code>' 가 종류다):
- ProviderHttpError → "HTTP <code> <사유>". 사유는 HTML 본문의 <title>(앞의 상태 코드는 뺀다), 없으면 http.HTTPStatus 문구.
  HTML 이 아닌 본문은 앞 BODY_HEAD 글자를 한 줄로 덧붙인다(" — …"). 모르는 코드는 문구 없이 "HTTP <code>".
- httpx 시간 초과(ConnectTimeout·ReadTimeout·WriteTimeout·PoolTimeout) → "<Type> — <단계> 제한 <N> s 초과 (<host>)".
  N 은 그 요청에 실제로 걸린 값(request.extensions["timeout"])이다. 요청이 붙어 있지 않으면 N·호스트를 쓰지 않는다(지어내지 않는다).
- httpx 연결·프로토콜·읽기·쓰기 오류 → "<Type> — <메시지> (<host>)". 메시지가 비면 "연결 실패"(읽기·쓰기 오류는 "응답 읽기 실패"·"요청 보내기 실패")
  에 원인 사슬(__cause__/__context__)의 첫 비어 있지 않은 글을 ": <원인 종류>: <글>" 로 덧붙인다.
- 그 밖(RequestTimedOut·Throttled·ValueError …) → "<Type> — <메시지>"(메시지가 비면 "<Type>").
- content=False: 응답에서 온 글(본문·제목·예외 메시지)을 싣지 않는다 — 노선 조회처럼 응답 내용을 다른 곳에 남기지 않는 호출자용.
- 늘 한 줄, masking.mask 로 가리고 LIMIT 글자에서 자른다.
"""

from __future__ import annotations

import http
import re

import httpx

from wakeline_collector.http import ProviderHttpError, RequestTimedOut
from wakeline_collector.masking import mask

BODY_HEAD = 120  # HTML 이 아닌 오류 본문에서 덧붙이는 앞부분 글자 수
LIMIT = 300  # 한 문구의 상한(공급자 상태 해시는 500, 로그 한 줄에서 읽히는 길이)

_WS = re.compile(r"\s+")
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
_TIMEOUT_PHASE: tuple[tuple[type[httpx.TimeoutException], str], ...] = (
    (httpx.ConnectTimeout, "connect"),
    (httpx.ReadTimeout, "read"),
    (httpx.WriteTimeout, "write"),
    (httpx.PoolTimeout, "pool"),
)


def _one_line(text: str) -> str:
    return _WS.sub(" ", text).strip()


def _num(v: float) -> str:
    return f"{v:g}"


def _looks_html(body: str) -> bool:
    head = body.lstrip()[:64].lower()
    return head.startswith(("<!doctype html", "<html", "<head", "<body")) or "<title" in body.lower()


def _phrase(code: int) -> str | None:
    try:
        return http.HTTPStatus(code).phrase
    except ValueError:
        return None


def _http(e: ProviderHttpError, content: bool) -> str:
    code = e.status
    body = e.body_head or ""
    head = f"HTTP {code}"
    if content and _looks_html(body):
        m = _TITLE.search(body)
        title = _one_line(m.group(1)) if m else ""
        title = re.sub(rf"^{code}\b[\s:.\-–—]*", "", title).strip()  # "429 Too Many Requests" → "Too Many Requests"
        reason = title or _phrase(code)
        return f"{head} {reason}" if reason else head
    reason = _phrase(code)
    out = f"{head} {reason}" if reason else head
    snippet = _one_line(body)[:BODY_HEAD] if content else ""
    return f"{out} — {snippet}" if snippet else out


def _request(e: httpx.RequestError) -> httpx.Request | None:
    try:
        return e.request
    except RuntimeError:  # 요청이 붙지 않은 예외(.request 가 설정되지 않음)
        return None


def _host(req: httpx.Request | None) -> str:
    return f" ({req.url.host})" if req is not None and req.url.host else ""


def _cause_text(e: BaseException) -> str:
    """원인 사슬에서 처음으로 글이 있는 예외 — ": <종류>: <글>". 없으면 빈 글."""
    seen: set[int] = set()
    cur = e.__cause__ or e.__context__
    for _ in range(4):
        if cur is None or id(cur) in seen:
            break
        seen.add(id(cur))
        text = _one_line(str(cur))
        if text:
            return f": {type(cur).__name__}: {text}"
        cur = cur.__cause__ or cur.__context__
    return ""


def _timeout(e: httpx.TimeoutException) -> str:
    phase = next((p for cls, p in _TIMEOUT_PHASE if isinstance(e, cls)), None)
    name = type(e).__name__
    if phase is None:  # 알 수 없는 시간 초과 하위 종류 — 메시지만
        msg = _one_line(str(e))
        return f"{name} — {msg}" if msg else name
    req = _request(e)
    limit = None
    if req is not None:
        t = req.extensions.get("timeout")
        if isinstance(t, dict) and isinstance(t.get(phase), int | float):
            limit = float(t[phase])
    lim = f" {_num(limit)} s" if limit is not None else ""
    return f"{name} — {phase} 제한{lim} 초과{_host(req)}"


def _transport(e: httpx.RequestError, content: bool) -> str:
    name = type(e).__name__
    req = _request(e)
    msg = _one_line(str(e)) if content else ""
    if msg:
        return f"{name} — {msg}{_host(req)}"
    if isinstance(e, httpx.ReadError):
        what = "응답 읽기 실패"
    elif isinstance(e, httpx.WriteError):
        what = "요청 보내기 실패"
    else:
        what = "연결 실패"
    return f"{name} — {what}{_host(req)}{_cause_text(e) if content else ''}"


def describe_error(e: BaseException, *, content: bool = True, limit: int = LIMIT) -> str:
    """오류 한 줄(가린 뒤 limit 글자). 모듈 설명의 규칙을 따른다."""
    if isinstance(e, ProviderHttpError):
        out = _http(e, content)
    elif isinstance(e, RequestTimedOut):  # httpx.TimeoutException 하위지만 우리 전체 상한 — 메시지가 설명이다
        msg = _one_line(str(e)) if content else ""
        out = f"{type(e).__name__} — {msg}" if msg else type(e).__name__
    elif isinstance(e, httpx.TimeoutException):
        out = _timeout(e)
    elif isinstance(e, httpx.RequestError):
        out = _transport(e, content)
    else:
        msg = _one_line(str(e)) if content else ""
        out = f"{type(e).__name__} — {msg}" if msg else type(e).__name__
    return (mask(out, None) or "")[:limit]
