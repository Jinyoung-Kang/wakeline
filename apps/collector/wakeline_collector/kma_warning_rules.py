"""기상청 API허브 특보현황(`wrn_now_data.php`, disp=0) 해석 규칙(ADR-036 · SPEC F3).

확인한 모양(2026-10-09 실제 호출 — tests/fixtures/kma_warning):
- EUC-KR 글자(`text/plain;charset=EUC-KR`). 머리 주석(`#` 로 시작) 뒤에 한 특보 한 줄. 특보가 없으면 주석만 온다(빈 목록 — 오류가 아니다).
- 줄 = 쉼표로 나눈 열 10개 + 끝의 `=`: REG_UP, REG_UP_KO, REG_ID, REG_KO, TM_FC, TM_EF, WRN, LVL, CMD, ED_TM. 값은 오른쪽이 공백으로 채워져 있다.
- 시각은 KST(`YYYYMMDDHHMM`). 저장 · 전달은 UTC 로 바꾼다(화면은 KST). 원문 줄은 그대로 남긴다.
- 예비특보(LVL '예비')의 TM_EF 는 정확한 시각이 아니라 때(시간대)를 뜻하는 부호다(머리 주석 그대로): hh:59 · hh:58 →
  02:59 새벽(00–03시) · 05:59 새벽(03–06시) · 08:59 아침(06–09시) · 11:59 오전(09–12시) · 14:59 낮(12–15시) · 17:59 늦은 오후(15–18시) · 20:59 저녁(18–21시) ·
  23:59 밤(21–24시) · 11:58 오전(06–12시) · 17:58 오후(12–18시) · 05:58 새벽(00–06시) · 23:58 밤(18–24시) · 14:58 오후(12–18시). 이때 effective_at 은
  없고(정확한 시각을 짐작하지 않는다) effective_from · effective_to(그 시간대, UTC)와 effective_text(때 이름)를 싣는다. 표에 없는 부호면 시간대도 모른다.
- 모르는 모양의 줄(열 수 · 구역 코드 · 시각이 틀림)은 버리고 센다 — 목록 전체를 버리지 않는다. 글자를 풀 수 없는 줄도 같다(QA-1222 — 전에는 본문 전체를
  한 번에 풀어 EUC-KR 밖의 글자(CP949 확장 한글 '똠' · 깨진 바이트) 하나가 목록 전체를 버렸다). 응답 전체가 풀리지 않을 때만 줄마다 따로 푼다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
ZONE = re.compile(r"^[LS][0-9]{7}$")
TM = re.compile(r"^[0-9]{12}$")
MAX_ROWS = 2_000  # 구역 414개 × 특보 종류 몇 — 넘으면 모양이 틀린 응답으로 본다
# 스트림 계약(schemas/stream_envelope.v1.json wx_warnings_payload)의 글자 수 한도 — 넘는 줄은 그 줄만 버린다(QA-602: 그대로 실으면 api 의 스키마 검사가
# 봉투 전체를 DLQ 로 보내 목록 전체를 잃었다). 계약과 같은 값이어야 한다(tests/test_kma_warning_rules.py 가 계약 파일과 대조한다).
MAX_LEN = {
    "zone_name": 80,
    "parent_name": 80,
    "kind": 16,
    "level": 16,
    "command": 16,
    "effective_text": 80,
    "end_notice": 40,
    "raw": 400,
}
MAX_BYTES = 2 * 2**20

# 예비특보 때 부호(머리 주석 그대로): "HH:MM" → (이름, 시작 시, 끝 시)
PRELIMINARY_SLOTS: dict[str, tuple[str, int, int]] = {
    "02:59": ("새벽", 0, 3),
    "05:59": ("새벽", 3, 6),
    "08:59": ("아침", 6, 9),
    "11:59": ("오전", 9, 12),
    "14:59": ("낮", 12, 15),
    "17:59": ("늦은 오후", 15, 18),
    "20:59": ("저녁", 18, 21),
    "23:59": ("밤", 21, 24),
    "11:58": ("오전", 6, 12),
    "17:58": ("오후", 12, 18),
    "05:58": ("새벽", 0, 6),
    "23:58": ("밤", 18, 24),
    "14:58": ("오후", 12, 18),
}


class WarningResponseError(ValueError):
    """응답 전체가 특보현황의 모양이 아니다(목록을 발행하지 않는다)."""


@dataclass
class ParsedWarnings:
    warnings: list[dict[str, Any]] = field(default_factory=list)
    dropped: list[dict[str, str]] = field(default_factory=list)


def _decode_text(data: bytes) -> str:
    """UTF-8 을 먼저, 아니면 EUC-KR(확인한 응답은 EUC-KR — 조사 때 UTF-8 로 온 적도 있다). 둘 다 아니면 UnicodeDecodeError(EUC-KR 의 것)."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("euc-kr")


def decode_lines(body: bytes) -> tuple[list[str], list[dict[str, str]]]:
    """본문 → (풀린 줄, 풀지 못한 줄의 dropped 기록). 본문 전체가 한 글로 풀리면 그 글의 줄. 아니면 바이트 줄(LF · CR · CRLF — EUC-KR · UTF-8 의
    여러 바이트 글자 안에는 이 바이트가 없다)마다 따로 풀고, 풀리지 않는 특보 줄만 버린다(QA-1222). 풀리지 않는 주석 줄('#')은 세지 않는다 — 주석은
    원래 읽지 않고, dropped 가 0 이 아니면 api 가 특보 끝내기를 미룬다(QA-1203). 그래도 머리 주석이 없으면 응답 전체가 글이 아닌 것으로 보고
    WarningResponseError(본문 전체를 풀 때 처음 실패한 바이트 위치)."""
    if len(body) > MAX_BYTES:
        raise WarningResponseError(f"response too large ({len(body)} bytes)")
    try:
        return _decode_text(body).splitlines(), []
    except UnicodeDecodeError as e:
        whole_error = f"neither UTF-8 nor EUC-KR (byte {e.start})"
    lines: list[str] = []
    bad: list[dict[str, str]] = []
    for raw in body.splitlines():
        try:
            lines.extend(_decode_text(raw).splitlines())
        except UnicodeDecodeError as e:
            if raw.startswith(b"#"):
                continue
            shown = raw.decode("euc-kr", errors="replace").strip()[:200]
            bad.append({"reason": f"neither UTF-8 nor EUC-KR (byte {e.start} of the line)", "line": shown})
    if not any(line.startswith("#") and "REG_ID" in line for line in lines):
        raise WarningResponseError(whole_error)
    return lines, bad


def kst_to_utc(tm: str) -> datetime:
    return datetime.strptime(tm, "%Y%m%d%H%M").replace(tzinfo=KST).astimezone(UTC)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _effective(tm_ef: str, preliminary: bool) -> dict[str, Any]:
    if not preliminary:
        return {"effective_at": iso(kst_to_utc(tm_ef))}
    slot = PRELIMINARY_SLOTS.get(f"{tm_ef[8:10]}:{tm_ef[10:12]}")
    day = datetime.strptime(tm_ef[:8], "%Y%m%d").replace(tzinfo=KST)
    if slot is None:
        return {"effective_text": f"{day:%m-%d} 때 모름(부호 {tm_ef[8:10]}:{tm_ef[10:12]})"}
    name, h0, h1 = slot
    return {
        "effective_from": iso(day + timedelta(hours=h0)),
        "effective_to": iso(day + timedelta(hours=h1)),
        "effective_text": f"{day:%m-%d} {name}({h0:02d}–{h1:02d}시 KST)",
    }


def parse_line(line: str) -> dict[str, Any]:
    """한 줄 → 특보 하나. 틀리면 ValueError(까닭)."""
    body = line.rstrip()
    if not body.endswith("="):
        raise ValueError("line does not end with '='")
    cols = [c.strip() for c in body[:-1].split(",")]
    if cols and cols[-1] == "":
        cols = cols[:-1]  # 끝 '=' 앞의 쉼표
    if len(cols) == 9:
        cols.append("")  # ED_TM 이 비면 공백만 남아 끝 쉼표와 합쳐진다
    if len(cols) != 10:
        raise ValueError(f"expected 10 columns, got {len(cols)}")
    reg_up, reg_up_ko, reg_id, reg_ko, tm_fc, tm_ef, wrn, lvl, cmd, ed_tm = cols
    if not ZONE.match(reg_id):
        raise ValueError("bad zone code")
    if not TM.match(tm_fc) or not TM.match(tm_ef):
        raise ValueError("bad time")
    if not wrn or not lvl or not cmd:
        raise ValueError("missing kind/level/command")
    preliminary = lvl == "예비"
    w: dict[str, Any] = {
        "zone_code": reg_id,
        "zone_name": reg_ko,
        "sea": reg_id.startswith("S"),
        "kind": wrn,
        "level": lvl,
        "command": cmd,
        "preliminary": preliminary,
        "issued_at": iso(kst_to_utc(tm_fc)),
        **_effective(tm_ef, preliminary),
        "raw": body,
    }
    if ZONE.match(reg_up):
        w["parent_code"] = reg_up
        if reg_up_ko:
            w["parent_name"] = reg_up_ko
    if ed_tm:
        w["end_notice"] = ed_tm
    for k, n in MAX_LEN.items():
        v = w.get(k)
        if isinstance(v, str) and len(v) > n:
            raise ValueError(f"{k} longer than {n} characters")
    return w


def parse(body: bytes) -> ParsedWarnings:
    """응답 바이트 → 특보 목록 · 버린 줄. 머리 주석이 없으면 특보현황 응답이 아니다(오류 문서 · 인증 실패 글 등)."""
    lines, undecodable = decode_lines(body)
    if not any(line.startswith("#") and "REG_ID" in line for line in lines):
        text = "\n".join(lines)
        raise WarningResponseError(f"not a warning list: {text.strip()[:80]!r}")
    out = ParsedWarnings(dropped=undecodable)
    rows = [line for line in lines if line.strip() and not line.startswith("#")]
    if len(rows) + len(undecodable) > MAX_ROWS:
        raise WarningResponseError(f"too many rows ({len(rows) + len(undecodable)})")
    for line in rows:
        try:
            out.warnings.append(parse_line(line))
        except (ValueError, OverflowError) as e:  # OverflowError: 날짜 계산이 넘침(QA-603) — 그 줄만 버린다
            out.dropped.append({"reason": str(e), "line": line.strip()[:200]})
    return out
