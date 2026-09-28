"""오류 원문에서 비밀값을 가리는 규칙. 운영 화면·DB 에 저장되는 모든 오류 텍스트와 로그(R-83)가 이 함수를 거친다.

- 모양으로 가리기: key=value · JSON("authKey": "…") · Bearer · Authorization 헤더 · URL userinfo · JWT.
- 값으로 가리기(R-83): 기동 때 register_secrets 로 넘긴 설정 비밀값(KMA 키 · OpenSky client secret · aisstream 키 · Redis/DB 비밀번호)
  자체를 어디에 나오든 가린다 — 공급자가 키를 응답 본문에 되돌려 주는 경우처럼 모양 규칙이 못 잡는 경우를 막는다.
- 로그: install_log_masking 이 핸들러에 MaskFilter 를 붙여 메시지·인자·트레이스백(log.exception)을 모두 가린다.
"""

from __future__ import annotations

import logging
import re

_KEYS = r"(?:client_secret|client_id|serviceKey|authKey|api[_-]?key|password|access_token|refresh_token|token|secret)"
_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)(client_secret=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(client_id=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]+=*"), r"\1***"),
    (re.compile(r"(?i)(authorization:\s*)[^\r\n]+"), r"\1***"),
    (re.compile(r"(?i)(serviceKey=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(authKey=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(api[_-]?key=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(password=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(token=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(secret=)[^&\s]+"), r"\1***"),
    # JSON·파이썬 repr 형태: "authKey": "…" / 'access_token': '…' (R-83 — '=' 가 없어 위 규칙이 못 잡는다)
    (re.compile(rf"""(?i)(["']{_KEYS}["']\s*:\s*["'])[^"']*(["'])"""), r"\1***\2"),
    (re.compile(r"(\w+://[^:/\s]+:)[^@\s]+(@)"), r"\1***\2"),  # scheme://user:pass@host
    (re.compile(r"eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}"), "***jwt***"),
]
MIN_SECRET_LEN = 6  # 이보다 짧은 값은 값으로 가리지 않는다(흔한 글자열을 모두 가려 로그를 망치지 않게)
_SECRETS: set[str] = set()
LOG_LIMIT = 100_000  # 로그 한 줄(트레이스백 포함) 가림 상한 — 넘는 부분은 잘린다


def register_secrets(*values: str | None) -> None:
    """설정 비밀값을 값 치환 목록에 더한다. 빈 값·MIN_SECRET_LEN 보다 짧은 값은 무시한다."""
    for v in values:
        if v and len(v) >= MIN_SECRET_LEN:
            _SECRETS.add(v)


def mask(text: str | None, limit: int = 4000) -> str | None:
    if text is None:
        return None
    out = text
    for pat, repl in _PATTERNS:
        out = pat.sub(repl, out)
    for secret in sorted(_SECRETS, key=len, reverse=True):  # 긴 값부터(다른 값을 품은 값이 먼저 가려지게)
        if secret in out:
            out = out.replace(secret, "***")
    return out[:limit]


class MaskFilter(logging.Filter):
    """로그 레코드의 메시지(인자 포함)·트레이스백·스택을 mask 로 가린다. 핸들러에 붙여 모든 로거의 레코드에 적용한다."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 — 형식 오류인 로그도 버리지 않는다(원문 형식 문자열만 가린다)
            msg = str(record.msg)
        record.msg, record.args = mask(msg, LOG_LIMIT) or "", None
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = mask(record.exc_text, LOG_LIMIT)
        if record.stack_info:
            record.stack_info = mask(record.stack_info, LOG_LIMIT)
        return True


def install_log_masking(*handlers: logging.Handler) -> None:
    """handlers(없으면 루트 로거의 핸들러 전부)에 MaskFilter 를 한 번씩 붙인다."""
    for h in handlers or tuple(logging.getLogger().handlers):
        if not any(isinstance(f, MaskFilter) for f in h.filters):
            h.addFilter(MaskFilter())
