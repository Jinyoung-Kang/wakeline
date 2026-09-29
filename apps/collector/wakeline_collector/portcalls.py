"""한국 항만 입출항(ADR-022 · 개정) — 해양수산부_선박운항정보(PORT-MIS) Info5 XML 응답 → 입출항 색인 행(DB port_call — V15).

공급자: GET https://apis.data.go.kr/1192000/VsslEtrynd5/Info5 (serviceKey · prtAgCd · sde · ede · pageNo · numOfRows ≤ 50 · deGb · clsgn).
응답은 JSON 을 요청해도 XML 이다: response/header/resultCode("00" = 정상)·resultMsg, body/items/item[], body/totalCount.
- **clsgn(호출부호) 파라미터는 거르지 않는다**(배포 뒤 확인 — docs/review/evidence/public-data-apis-2026-09-29.txt 마지막 절). 그래서 선택한 선박마다
  묻지 않고, 항만청 · KST 날짜 하루씩 모든 신고를 받아 색인한다(jobs/portcalls_index). api 가 AIS 호출부호로 색인을 찾는다.
- 읽는 필드는 실제 응답으로 확인한 이름뿐이다(fixtures/portmis_info5_busan_V7A3884.xml — 전체 기록 · portmis_info5_empty.xml — 빈 응답).
  모르는 요소는 무시하고, 없는 요소는 None. 문자열은 제어·서식 문자를 지우고 공백을 하나로 모은 뒤 길이를 자른다(route.clean_text). 코드는 모양만 검사한다.
- 예외 메시지는 고정 문구 + 공급자가 준 resultCode·resultMsg(가린 뒤 · 자른 것) 또는 뜻밖의 XML 의 뿌리 이름·글(가린 뒤 · 자른 것)이다.
- 호출부호 정규화(normalize_call_sign)는 api(PortCallReader.normalizeCallSign)와 같은 규칙이다 — 언어 간 벡터 schemas/vectors/call-sign-cases.v1.json.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET  # noqa: S405 — DOCTYPE·ENTITY 가 있는 문서는 파싱 전에 거절한다(아래 _refuse_dtd)
from dataclasses import dataclass, fields
from datetime import UTC, date, datetime, timedelta, timezone

from wakeline_collector.masking import mask
from wakeline_collector.route import clean_text

SOURCE = "해양수산부 선박운항정보(PORT-MIS)"
WINDOW_DAYS = 30  # 색인이 늘 덮으려는 창: 오늘(KST) − 30일 ~ 오늘

# AIS 호출부호 칸은 7자(schemas/ship_static.v1.json). 3자 미만은 찾지 않는다(우리 입력 규칙 — ADR-022).
CALL_SIGN_RE = re.compile(r"^[A-Z0-9]{3,7}$")
_PORT_AUTHORITY_CODE_RE = re.compile(r"^[0-9]{3}$")
_PORT_CODE_RE = re.compile(r"^[A-Z0-9]{2,10}$")
TEXT_MAX = 80
ERROR_MAX = 200
_ERROR_TEXT_MAX = 120  # 오류 문구에 싣는 공급자 글의 상한

# 항만청 코드(국가물류통합정보센터 nlic.go.kr 항만청코드 표 — 표에는 11행이라 적혀 있으나 10개가 실려 있다).
# 2026-09-29 각 코드로 API 를 불러 이 이름(prtAgNm)이 돌아옴을 확인했다. 이 밖의 항만청은 묻지 않는다(ADR-022).
PORT_AUTHORITIES: tuple[tuple[str, str], ...] = (
    ("020", "부산"),
    ("030", "인천"),
    ("200", "동해"),
    ("300", "대산"),
    ("500", "군산"),
    ("610", "목포"),
    ("620", "여수"),
    ("700", "포항"),
    ("810", "마산"),
    ("820", "울산"),
)

KST = timedelta(hours=9)  # 한국 표준시는 UTC+9 고정(일광 절약 시간 없음)


class PortCallParseError(ValueError):
    """응답 모양이 확인한 구조와 다름. 메시지는 고정 문구(+ 뜻밖의 뿌리 이름·글, 가린 뒤)뿐이다."""


class PortCallApiError(RuntimeError):
    """resultCode 가 "00"(정상)이 아니다. 메시지 = "resultCode <code> · <resultMsg>"(가린 뒤 · 자른 것)."""

    def __init__(self, code: str, message: str | None):
        text = f"resultCode {code}" + (f" · {message}" if message else "")
        super().__init__(_safe(text))
        self.code = code


def _safe(text: str, limit: int = ERROR_MAX) -> str:
    return (mask(clean_text(text, 10_000) or "", None) or "")[:limit]


def normalize_call_sign(raw: object) -> str | None:
    """앞뒤 공백 제거 · ASCII 가 아니면 None · 대문자 · `^[A-Z0-9]{3,7}$` 일 때만(api PortCallReader.normalizeCallSign 과 같은 규칙).
    가운데 공백·기호는 지우지 않는다 — 다른 호출부호로 바꿔 묻지 않는다."""
    if not isinstance(raw, str) or not raw.isascii():
        return None
    cs = raw.strip().upper()
    return cs if CALL_SIGN_RE.fullmatch(cs) else None


def _iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


_DTD_RE = re.compile(rb"<!(?:DOCTYPE|ENTITY)", re.IGNORECASE)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child(el: ET.Element | None, name: str) -> ET.Element | None:
    if el is None:
        return None
    for c in el:
        if _local(c.tag) == name:
            return c
    return None


def _children(el: ET.Element | None, name: str) -> list[ET.Element]:
    return [] if el is None else [c for c in el if _local(c.tag) == name]


def _text(el: ET.Element | None, name: str, limit: int = TEXT_MAX) -> str | None:
    c = _child(el, name)
    return None if c is None else clean_text(c.text, limit)


def _code(el: ET.Element, name: str, pattern: re.Pattern[str]) -> str | None:
    c = _child(el, name)
    if c is None or not isinstance(c.text, str) or not c.text.isascii():
        return None
    s = c.text.strip().upper()
    return s if pattern.fullmatch(s) else None


def _time(v: str | None) -> datetime | None:
    """시간대가 있는 ISO-8601 시각만(UTC 로). 날짜만·시간대 없음·읽을 수 없음은 None."""
    if v is None or len(v) > 40 or "T" not in v:
        return None
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return dt.astimezone(UTC) if dt.tzinfo is not None else None


def _refuse_dtd(body: bytes) -> None:
    """DOCTYPE·ENTITY 선언이 있는 문서는 읽지 않는다(엔티티 확장 · 외부 참조 — 확인한 응답에는 없다)."""
    if _DTD_RE.search(body):
        raise PortCallParseError("DOCTYPE/ENTITY refused")


def _leaf_text(root: ET.Element) -> str:
    parts = [t for t in (clean_text(e.text, _ERROR_TEXT_MAX) for e in root.iter()) if t]
    return " ".join(parts)[:_ERROR_TEXT_MAX]


# ---- 입출항 색인(ADR-022 개정 — clsgn 이 거르지 않아 호출부호 없이 항만청 · 날짜별로 모두 받는다) ------------------------------------------
# 선택한 선박마다 clsgn 으로 묻는 대신, 항만청 10곳의 날짜별 입출항 신고를 모두 받아 DB(port_call — V15)에 두고 api 가 호출부호로 찾는다.
# 한 번에 받는 단위 = (항만청, KST 날짜 하루): sde = ede = 그 날짜, deGb=I(입항일 기준), 모든 쪽. 그래서 행마다 원천이 그 행을 올린 날짜
# (listed_date)를 안다 — 입항 신고 시각이 없거나 읽을 수 없어도 30일 창에 넣을 수 있다.
# 확인한 것(실제 전체 기록 fixtures/portmis_info5_busan_V7A3884.xml): details/detail 마다 reqstSeNm(최초 · 최종 — 신고의 판) · etryndNm(입항 · 출항),
# 입항 detail 의 etryptDt(+09:00) · 출항 detail 의 tkoffDt(+09:00) · laidupFcltyNm(계류 시설 — 선석) · ibobprtNm. 오프셋이 없는 필드
# (tkoffPrrrnDt 출항 예정 · dstnEtryptDt 등 "YYYY-MM-DD HH:MM:SS")는 시간대를 자료가 말하지 않으므로 시각으로 읽지 않는다.
REVISIONS: tuple[str, ...] = (
    "최종",
    "최초",
)  # 신고의 판 — 앞의 것이 우선(최종이 있으면 최종, 없으면 최초). 다른 이름은 읽지 않는다(순서를 모른다)
ENTRY, EXIT = "입항", "출항"
_TIME_TAG = {ENTRY: "etryptDt", EXIT: "tkoffDt"}  # 종류마다 시각 필드가 다르다(확인한 그대로 — 출항 detail 에는 etryptDt 가 없다)
_KEY_PART_RE = re.compile(r"^[0-9A-Za-z]{1,16}$")  # 입항년도 · 입항횟수 — 모양만(실제 예 "2026" · "005")
_SHORT_CODE_RE = re.compile(r"^[A-Z0-9]{1,10}$")  # 국적 코드 · 선종 코드(실제 예 "MH" · "14")
KST_TZ = timezone(KST)


def kst_date(at: datetime) -> date:
    """이 순간의 KST 날짜(UTC+9 고정)."""
    return at.astimezone(KST_TZ).date()


@dataclass(frozen=True)
class PortCallRow:
    """색인 한 행(DB port_call) — 자연 키 (prt_ag_cd, clsgn, etrypt_year, etrypt_co). 모르는 값은 None(지어 채우지 않는다).

    entry_at · exit_at: 입항 detail 의 etryptDt · 출항 detail 의 tkoffDt(+09:00 만)를 판 순서(REVISIONS)대로 — 시각이 있는 첫 판의 것, 그 판 안에서
    서로 다른 시각이 있으면 고르지 않는다: 시각도 판 이름도 None(뒤 판으로 내려가지 않는다 — 더 나중 판이 있는데 옛 판을 답으로 보이지 않게).
    판 이름은 시각이 있을 때만 있다(V15 CHECK port_call_revision_needs_time — 어기면 그 날 전체가 되돌려진다).
    berth = 고른 입항 신고의 laidupFcltyNm(입항 신고를 고르지 못했으면 고른 출항 신고의 것).
    """

    prt_ag_cd: str
    clsgn: str
    etrypt_year: str
    etrypt_co: str
    listed_date: date
    prt_ag_nm: str | None = None
    vssl_nm: str | None = None
    nationality_cd: str | None = None
    nationality_nm: str | None = None
    kind_cd: str | None = None
    kind_nm: str | None = None
    purpose_nm: str | None = None
    first_port_cd: str | None = None
    first_port_nm: str | None = None
    prev_port_cd: str | None = None
    prev_port_nm: str | None = None
    next_port_cd: str | None = None
    next_port_nm: str | None = None
    dest_port_cd: str | None = None
    dest_port_nm: str | None = None
    entry_at: datetime | None = None
    entry_revision: str | None = None
    exit_at: datetime | None = None
    exit_revision: str | None = None
    berth: str | None = None

    @property
    def key(self) -> tuple[str, str, str, str]:
        return self.prt_ag_cd, self.clsgn, self.etrypt_year, self.etrypt_co

    def as_dict(self) -> dict[str, str | None]:
        """열 이름 → 값(날짜 · 시각은 ISO, 시각은 UTC 'Z'). 언어 간 fixture(fixtures/portcall_row_V7A3884.json)와 DB 인자의 원본."""
        out: dict[str, str | None] = {}
        for f in fields(self):
            v = getattr(self, f.name)
            if isinstance(v, datetime):
                out[f.name] = _iso(v)
            elif isinstance(v, date):
                out[f.name] = v.isoformat()
            else:
                out[f.name] = v
        return out


@dataclass(frozen=True)
class IndexPage:
    """(항만청, 날짜) 요청 한 쪽의 해석. 완전성은 받는 쪽(작업)이 모든 쪽을 모은 뒤 판단한다.

    items: 이 쪽의 item 수(원문) · rows: 색인에 넣을 행 · unmatchable: 호출부호가 없거나 조회 형식 밖(AIS 호출부호와 맞출 수 없다 — 완전성을
    해치지 않는다) · unkeyed: 호출부호는 맞는데 입항년도 · 입항횟수가 없거나 모양 밖(행을 둘 수 없다 — 그 날은 완전하지 않다) ·
    foreign: 요청한 항만청이 아닌 item(원천이 prtAgCd 를 거르지 않았다 — 그 날은 믿지 않는다) · date_mismatch: 입항 시각의 KST 날짜가 요청한 날과
    다른 행 수(원천의 날짜 필터 의미를 확인하는 신호 — 행은 둔다)."""

    total: int
    items: int
    rows: list[PortCallRow]
    unmatchable: int = 0
    unkeyed: int = 0
    foreign: int = 0
    date_mismatch: int = 0


def _pick(details: list[ET.Element], kind: str) -> tuple[datetime | None, str | None, ET.Element | None]:
    """(시각, 판, 고른 detail). 판 순서대로 이 종류의 신고 중 시각이 있는 첫 판 — 그 판 안의 시각이 둘 이상이면 (None, None, None):
    판 이름만 남기지 않고(무엇의 판인지 모른다 — V15 CHECK), 뒤 판(최초)으로 내려가지도 않는다(최종이 있는데 최초를 답으로 보이지 않는다)."""
    tag = _TIME_TAG[kind]
    for rev in REVISIONS:
        same = [d for d in details if _text(d, "reqstSeNm") == rev and _text(d, "etryndNm") == kind]
        timed = [(t, d) for d in same if (t := _time(_text(d, tag, 64))) is not None]
        if not timed:
            continue
        if len({t for t, _ in timed}) > 1:
            return None, None, None  # 같은 판에 서로 다른 시각 — 고르지 않는다
        return timed[0][0], rev, timed[0][1]
    return None, None, None


def _short(el: ET.Element, name: str) -> str | None:
    return _code(el, name, _SHORT_CODE_RE)


def _key_part(el: ET.Element, name: str) -> str | None:
    v = _text(el, name, 32)
    return v if v is not None and _KEY_PART_RE.fullmatch(v) else None


def _index_row(el: ET.Element, clsgn: str, day: date) -> PortCallRow | None:
    """item → 행. 입항년도 · 입항횟수가 없으면 None(자연 키를 만들 수 없다 — 짓지 않는다)."""
    year, count = _key_part(el, "etryptYear"), _key_part(el, "etryptCo")
    pa = _code(el, "prtAgCd", _PORT_AUTHORITY_CODE_RE)
    if year is None or count is None or pa is None:
        return None
    details = _children(_child(el, "details"), "detail")
    entry_at, entry_rev, entry_d = _pick(details, ENTRY)
    exit_at, exit_rev, exit_d = _pick(details, EXIT)
    berth_from = entry_d if entry_d is not None else exit_d
    return PortCallRow(
        prt_ag_cd=pa,
        clsgn=clsgn,
        etrypt_year=year,
        etrypt_co=count,
        listed_date=day,
        prt_ag_nm=_text(el, "prtAgNm"),
        vssl_nm=_text(el, "vsslNm"),
        nationality_cd=_short(el, "vsslNltyCd"),
        nationality_nm=_text(el, "vsslNltyNm"),
        kind_cd=_short(el, "vsslKndCd"),
        kind_nm=_text(el, "vsslKndNm"),
        purpose_nm=_text(el, "etryptPurpsNm"),
        first_port_cd=_code(el, "frstDpmprtNatPrtCd", _PORT_CODE_RE),
        first_port_nm=_text(el, "frstDpmprtPrtNm"),
        prev_port_cd=_code(el, "prvsDpmprtNatPrtCd", _PORT_CODE_RE),
        prev_port_nm=_text(el, "prvsDpmprtPrtNm"),
        next_port_cd=_code(el, "nxlnptNatPrtCd", _PORT_CODE_RE),
        next_port_nm=_text(el, "nxlnptPrtNm"),
        dest_port_cd=_code(el, "dstnNatPrtCd", _PORT_CODE_RE),
        dest_port_nm=_text(el, "dstnPrtNm"),
        entry_at=entry_at,
        entry_revision=entry_rev if entry_at is not None else None,  # 판 이름은 시각과 함께만(V15 CHECK)
        exit_at=exit_at,
        exit_revision=exit_rev if exit_at is not None else None,
        berth=_text(berth_from, "laidupFcltyNm") if berth_from is not None else None,
    )


def parse_index_page(body: bytes, port_authority: str, day: date) -> IndexPage:
    """(항만청, 날짜 하루) 응답 한 쪽 → IndexPage. resultCode 가 "00" 이 아니면 PortCallApiError, 모양이 다르면 PortCallParseError."""
    body_el, total = _checked_body(body)
    rows: list[PortCallRow] = []
    items = unmatchable = unkeyed = foreign = mismatch = 0
    for el in _children(_child(body_el, "items"), "item"):
        items += 1
        if _code(el, "prtAgCd", _PORT_AUTHORITY_CODE_RE) != port_authority:
            foreign += 1
            continue
        c = _child(el, "clsgn")
        cs = normalize_call_sign(c.text if c is not None else None)
        if cs is None:
            unmatchable += 1
            continue
        row = _index_row(el, cs, day)
        if row is None:
            unkeyed += 1
            continue
        if row.entry_at is not None and kst_date(row.entry_at) != day:
            mismatch += 1
        rows.append(row)
    return IndexPage(total, items, rows, unmatchable, unkeyed, foreign, mismatch)


def _checked_body(body: bytes) -> tuple[ET.Element | None, int]:
    """공통 검사: DTD 거절 · XML · 뿌리 response · resultCode "00" · totalCount 숫자. (body 요소, totalCount)."""
    _refuse_dtd(body)
    try:
        root = ET.fromstring(body)  # noqa: S314 — DTD 는 위에서 거절했다(expat ≥ 2.4 의 확장 폭탄 방어도 있다)
    except ET.ParseError:
        raise PortCallParseError("response is not XML") from None
    if _local(root.tag) != "response":
        text = _leaf_text(root)
        raise PortCallParseError(_safe(f"unexpected response (root <{_local(root.tag)[:40]}>{': ' + text if text else ''})"))
    header = _child(root, "header")
    code = _text(header, "resultCode", 16)
    if code is None:
        raise PortCallParseError("resultCode missing")
    if code != "00":
        raise PortCallApiError(code, _text(header, "resultMsg", _ERROR_TEXT_MAX))
    body_el = _child(root, "body")
    total_raw = _text(body_el, "totalCount", 16)
    if total_raw is None or not total_raw.isdigit():
        raise PortCallParseError("totalCount missing or invalid")
    return body_el, int(total_raw)


# ---- 색인 범위(port_call_coverage — V15) -------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Coverage:
    """항만청 하나의 색인 범위: [covered_from, covered_to](KST 날짜, 양끝 포함)의 모든 날을 쪽을 끝까지 받아 한 번 이상 색인했다.
    refreshed_at = 마지막으로 끝난 꼬리 갱신(최근 3일 — 오늘 포함)이 시작한 때: 그 순간까지 올라온 신고는 covered_to 까지 모두 색인에 있다.
    꼬리 갱신을 끝낸 적이 없으면 None."""

    covered_from: date
    covered_to: date
    refreshed_at: datetime | None = None


def merge_day(cov: Coverage | None, day: date, *, reset: bool = False) -> Coverage | None:
    """하루(day)를 완전히 받았다 → 새 범위. 범위와 이어지거나 겹치면 넓히고(refreshed_at 은 그대로), 이어지지 않으면 None(범위는 그대로 — 받은
    행은 둔다). 범위가 없거나 reset 이면 [day, day] 로 새로 시작한다(창 밖으로 오래된 범위를 버릴 때 — refreshed_at 은 None)."""
    if reset or cov is None:
        return Coverage(day, day, None)
    if cov.covered_from - timedelta(days=1) <= day <= cov.covered_to + timedelta(days=1):
        return Coverage(min(cov.covered_from, day), max(cov.covered_to, day), cov.refreshed_at)
    return None
