"""오류 원문에서 비밀값을 가리는 규칙(10패턴). 운영 화면·DB 에 저장되는 모든 오류 텍스트가 이 함수를 거친다."""

from __future__ import annotations

import re

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
    (re.compile(r"(\w+://[^:/\s]+:)[^@\s]+(@)"), r"\1***\2"),  # scheme://user:pass@host
    (re.compile(r"eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}"), "***jwt***"),
]


def mask(text: str | None, limit: int = 4000) -> str | None:
    if text is None:
        return None
    out = text
    for pat, repl in _PATTERNS:
        out = pat.sub(repl, out)
    return out[:limit]
