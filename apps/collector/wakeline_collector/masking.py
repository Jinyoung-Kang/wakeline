"""오류 원문에서 비밀값을 가리는 규칙. 운영 화면·DB 에 저장되는 모든 오류 텍스트와 로그(R-83)가 이 함수를 거친다.

- 모양으로 가리기: key=value · JSON("authKey": "…") · Bearer · Authorization 헤더 · URL userinfo · JWT.
  규칙은 api LogMasker 와 같다 — 언어 간 시험 벡터 schemas/vectors/masking-cases.v1.json(계약 v5 §C5)으로 고정한다.
- 값으로 가리기(R-83): 기동 때 register_secrets 로 넘긴 설정 비밀값(KMA 키 · OpenSky client secret · aisstream 키 · Redis/DB 비밀번호)
  자체를 어디에 나오든 가린다 — 공급자가 키를 응답 본문에 되돌려 주는 경우처럼 모양 규칙이 못 잡는 경우를 막는다.
- 로그: install_log_masking 이 핸들러에 MaskFilter 를 붙여 메시지·인자·트레이스백(log.exception)을 모두 가린다. 한 레코드는 한 번만
  가린다(핸들러가 여럿이어도) — 가린 레코드에 MASKED_ATTR 표시(칸별 '가린 뒤 · 자르기 전' 글자 수)를 달아 두고, 로그 싱크는 그 표시로
  다시 가리지 않고 잘림 표시의 N 을 정확히 센다(계약 v5 §C1).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable

_KEYS = r"(?:client_secret|client_id|serviceKey|authKey|api[_-]?key|password|access_token|refresh_token|token|secret)"
_B64URL = r"[A-Za-z0-9\-_]"


def _userinfo(m: re.Match[str]) -> str:
    return m.group(1) + "***@" if m.group(2) else m.group(0)


def _jwt(m: re.Match[str]) -> str:
    return "***jwt***" if m.group(1) is not None else m.group(0)


_PATTERNS: list[tuple[re.Pattern[str], str | Callable[[re.Match[str]], str]]] = [
    (re.compile(r"(?i)(client_secret=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(client_id=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9\-._~+/]+=*"), r"\1***"),
    (re.compile(r"(?i)(authorization:\s*)[^\r\n]+"), r"\1***"),
    (re.compile(r"(?i)(serviceKey=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(authKey=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(api[_-]?key=)[^&\s]+"), r"\1***"),
    # 계약 v5 §C5: 쿼리 파라미터 key · apikey · access_key(?/& 뒤만 — 'cache key=' 같은 낱말은 두지 않는다). Java LogMasker 와 같은 규칙
    (re.compile(r"(?i)([?&](?:key|apikey|access_key)=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(password=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(token=)[^&\s]+"), r"\1***"),
    (re.compile(r"(?i)(secret=)[^&\s]+"), r"\1***"),
    # JSON·파이썬 repr 형태: "authKey": "…" / 'access_token': '…' (R-83 — '=' 가 없어 위 규칙이 못 잡는다)
    (re.compile(rf"""(?i)(["']{_KEYS}["']\s*:\s*["'])[^"']*(["'])"""), r"\1***\2"),
    # 아래 두 규칙은 Java LogMasker 의 되짚기 정규식과 글자 하나까지 같은 결과를 내되, 시간은 글자 수에 비례하게 쓴 것이다(계약 v5 §C2 —
    # 가리는 동안 이벤트 루프를 막지 않는다). 같은 결과인지는 tests/test_masking.py 가 무작위 글 20,000개로 견준다.
    # scheme://user:pass@host = (?<!\w)(\w+://[^:/\s]+:)[^@\s]+(@). (?<!\w): 낱말 처음에서만 시작한다(낱말 안에서 시작하는 일치는
    # 그 낱말 처음에서도 일치하고 왼쪽 것이 먼저 잡힌다). '@' 없이 공백·끝에서 멈추면 그 구간을 그대로 두고 건너뛴다 — 구간 안의 다른
    # 시작점은 userinfo 가 이 시작점의 userinfo 보다 뒤에서 시작해 같은 공백·끝에서 멈추므로 역시 일치하지 않는다.
    (re.compile(r"(?<!\w)(\w+://[^:/\s]+:)[^@\s]+(@)?"), _userinfo),
    # JWT = eyJ[..]{10,}\.[..]{10,}\.[..]{10,}. 'eyJ' 에서 일치하지 않으면 그 base64url 글자열 끝까지 건너뛴다 — 같은 글자열 안의
    # 뒤쪽 'eyJ' 는 같은 곳에서 끊기고(첫 칸은 더 짧다) 뒤에 오는 '.' 칸도 같아서 역시 일치하지 않는다.
    (re.compile(rf"eyJ(?:({_B64URL}{{10,}}\.{_B64URL}{{10,}}\.{_B64URL}{{10,}})|{_B64URL}*)"), _jwt),
]
MIN_SECRET_LEN = 6  # 이보다 짧은 값은 값으로 가리지 않는다(흔한 글자열을 모두 가려 로그를 망치지 않게)
_SECRETS: set[str] = set()
LOG_LIMIT = 100_000  # 로그 한 줄(트레이스백 포함) 가림 상한 — 넘는 부분은 잘린다
# MaskFilter 가 가린 레코드의 표시: {칸(msg · exc_text · stack_info): 가린 뒤 · 자르기 전 글자 수}
MASKED_ATTR = "wakeline_masked"


def register_secrets(*values: str | None) -> None:
    """설정 비밀값을 값 치환 목록에 더한다. 빈 값·MIN_SECRET_LEN 보다 짧은 값은 무시한다."""
    for v in values:
        if v and len(v) >= MIN_SECRET_LEN:
            _SECRETS.add(v)


def mask(text: str | None, limit: int | None = 4000) -> str | None:
    """text 를 가린 뒤 앞 limit 글자(None 이면 자르지 않는다)."""
    if text is None:
        return None
    out = text
    for pat, repl in _PATTERNS:
        out = pat.sub(repl, out)
    for secret in sorted(_SECRETS, key=len, reverse=True):  # 긴 값부터(다른 값을 품은 값이 먼저 가려지게)
        if secret in out:
            out = out.replace(secret, "***")
    return out if limit is None else out[:limit]


class MaskFilter(logging.Filter):
    """로그 레코드의 메시지(인자 포함)·트레이스백·스택을 mask 로 가린다. 핸들러에 붙여 모든 로거의 레코드에 적용한다.

    가린 칸은 LOG_LIMIT 에서 자르고, 자르기 전 길이를 MASKED_ATTR 에 남긴다. 이미 표시가 있는 레코드(다른 핸들러의 필터가 가린 것)는
    그대로 둔다 — 같은 글을 다시 훑지 않고, 잘린 글로 길이를 다시 재서 원래 길이를 잃지도 않는다."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(getattr(record, MASKED_ATTR, None), dict):
            return True
        whole: dict[str, int] = {}
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 — 형식 오류인 로그도 버리지 않는다(원문 형식 문자열만 가린다)
            msg = str(record.msg)
        record.msg, record.args = _mask_capped(msg, "msg", whole), None
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = _mask_capped(record.exc_text, "exc_text", whole)
        if record.stack_info:
            record.stack_info = _mask_capped(record.stack_info, "stack_info", whole)
        setattr(record, MASKED_ATTR, whole)
        return True


def _mask_capped(text: str, field: str, whole: dict[str, int]) -> str:
    out = mask(text, None) or ""
    whole[field] = len(out)
    return out[:LOG_LIMIT]


def install_log_masking(*handlers: logging.Handler) -> None:
    """handlers(없으면 루트 로거의 핸들러 전부)에 MaskFilter 를 한 번씩 붙인다."""
    for h in handlers or tuple(logging.getLogger().handlers):
        if not any(isinstance(f, MaskFilter) for f in h.filters):
            h.addFilter(MaskFilter())
