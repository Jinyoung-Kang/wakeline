#!/usr/bin/env python3
"""UN/LOCODE 항구 표 만들기(계약 v4 §B): datasets/un-locode 의 data/code-list.csv 에서 항구(기능 1)·내륙항(기능 8) 항목만 골라
apps/api/src/main/resources/data/unlocode-ports.tsv 를 쓴다. api(DestinationParser)가 기동할 때 한 번 읽어 AIS 목적지의 UN/LOCODE 를 푼다.

- 자료: UNECE UN/LOCODE 를 datasets/un-locode 가 CSV 로 옮긴 것(ODC-PDDL-1.0). 파일 머리에 출처·라이선스·판·내려받은 날·행 수를 적는다.
- 골라내기: Function 의 첫 글자가 '1'(항구)이거나 어디든 '8'(내륙항)이 있는 줄. 같은 코드가 여러 줄(다른 언어 이름)이면 원본 순서의 첫 줄.
- name_collision: 5자 코드가 UN/LOCODE 의 어떤 지명(글자로만 된 이름, 대소문자 무시)과 같으면 1(예: 코드 CAVAN = 지명 Cavan).
  붙임형 목적지 'CAVAN' 은 코드로도 지명으로도 읽히므로 api 가 ambiguous 로 표시한다.
- 판(版): code-list.csv 에는 판 표기가 없다 — 추정해 적지 않고 '표기 없음' 과 원본 SHA-256 을 적는다.

apps/collector 의 uv 환경에서 실행한다(표준 라이브러리만 쓴다):
  cd apps/collector && uv run python ../../tools/gen_unlocode.py                       # 기본 URL 에서 내려받는다
  cd apps/collector && uv run python ../../tools/gen_unlocode.py --csv code-list.csv   # 이미 받은 파일(내려받은 날 = 파일 수정 날짜, UTC)
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import re
import sys
import urllib.parse
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_URL = "https://raw.githubusercontent.com/datasets/un-locode/main/data/code-list.csv"
DEFAULT_OUT = ROOT / "apps" / "api" / "src" / "main" / "resources" / "data" / "unlocode-ports.tsv"
COLUMNS = ("code", "name", "country", "subdivision", "function", "name_collision")
REQUIRED = ("Country", "Location", "Name", "NameWoDiacritics", "Subdivision", "Function")
COUNTRY = re.compile(r"^[A-Z]{2}$")
LOCATION = re.compile(r"^[A-Z0-9]{3}$")
SUBDIVISION = re.compile(r"^[A-Z0-9]{1,3}$")
FUNCTION = re.compile(r"^[0-9B-]{8}$")
_SPACES = re.compile(r"\s+")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


@dataclass(frozen=True)
class Port:
    code: str
    name: str
    country: str
    subdivision: str
    function: str
    name_collision: bool


def is_port(function: str) -> bool:
    """항구(첫 자리 '1') 또는 내륙항('8' 이 어디든)."""
    return function[:1] == "1" or "8" in function


def clean(text: str) -> str:
    """TSV 에 안전한 한 줄: 제어문자(탭·줄바꿈 포함)를 공백으로, 연속 공백은 하나로, 앞뒤 공백 제거."""
    return _SPACES.sub(" ", _CONTROL.sub(" ", text)).strip()


def letter_names(rows: Iterable[dict[str, str]]) -> set[str]:
    """글자로만 된 5자 지명(대문자) — Name 과 NameWoDiacritics 모두. 붙임형 코드와 겹치는지 볼 때만 쓰므로 5자만 모은다."""
    out: set[str] = set()
    for r in rows:
        for n in (r.get("Name") or "", r.get("NameWoDiacritics") or ""):
            n = n.strip()
            if len(n) == 5 and n.isascii() and n.isalpha():
                out.add(n.upper())
    return out


def select_ports(rows: list[dict[str, str]]) -> tuple[list[Port], int]:
    """항구 항목(코드순)과 형식이 틀려 뺀 줄 수."""
    names = letter_names(rows)
    seen: dict[str, Port] = {}
    skipped = 0
    for r in rows:
        function = (r.get("Function") or "").strip()
        if not is_port(function):
            continue
        country, location = (r.get("Country") or "").strip(), (r.get("Location") or "").strip()
        name = clean(r.get("Name") or "")
        subdivision = (r.get("Subdivision") or "").strip()
        if not (COUNTRY.match(country) and LOCATION.match(location) and FUNCTION.match(function) and name):
            skipped += 1
            continue
        if subdivision and not SUBDIVISION.match(subdivision):
            subdivision = ""  # 형식이 틀린 행정구역 코드는 싣지 않는다(모름)
        code = country + location
        if code in seen:
            continue
        seen[code] = Port(code, name, country, subdivision, function, code in names)
    return sorted(seen.values(), key=lambda p: p.code), skipped


def read_rows(raw: bytes) -> list[dict[str, str]]:
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"), newline="")))
    if not rows:
        raise ValueError("code-list.csv has no rows")
    missing = [c for c in REQUIRED if c not in rows[0]]
    if missing:
        raise ValueError(f"code-list.csv lacks columns: {', '.join(missing)}")
    return rows


def render(ports: list[Port], *, source: str, downloaded: date, sha256: str, source_rows: int) -> str:
    head = [
        "# UN/LOCODE 항구·내륙항(Function 첫 자리 1 또는 8 포함) — tools/gen_unlocode.py 가 만든 파일, 손으로 고치지 않는다.",
        f"# source: {source}",
        "# origin: UNECE UN/LOCODE (datasets/un-locode 가 CSV 로 옮김)",
        "# licence: ODC-PDDL-1.0",
        "# edition: code-list.csv 에 판 표기 없음 — 아래 내려받은 날의 파일(sha256)",
        f"# downloaded: {downloaded.isoformat()}",
        f"# source_sha256: {sha256}",
        f"# source_rows: {source_rows}",
        f"# rows: {len(ports)}",
        "# name_collision: 1 = 5자 코드가 UN/LOCODE 의 어떤 지명(글자로만 된 이름, 대소문자 무시)과 같다(예: CAVAN).",
        "\t".join(COLUMNS),
    ]
    body = ["\t".join((p.code, p.name, p.country, p.subdivision, p.function, "1" if p.name_collision else "0")) for p in ports]
    return "\n".join(head + body) + "\n"


def download(url: str) -> bytes:
    if urllib.parse.urlsplit(url).scheme != "https":
        raise ValueError("--url must be https")
    req = urllib.request.Request(url, headers={"User-Agent": "wakeline-gen-unlocode"})  # noqa: S310 — https 만 허용(위에서 검사)
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310
        return r.read()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--csv", type=Path, help="already downloaded code-list.csv (no network access)")
    ap.add_argument("--url", default=DEFAULT_URL, help="code-list.csv URL (used when --csv is absent)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output TSV")
    ap.add_argument(
        "--downloaded", type=date.fromisoformat, help="download date YYYY-MM-DD (default: file mtime UTC or today UTC)"
    )
    a = ap.parse_args(argv)

    if a.csv:
        raw = a.csv.read_bytes()
        source = a.url  # 이미 받은 파일의 출처(기본 URL)
        downloaded = a.downloaded or datetime.fromtimestamp(a.csv.stat().st_mtime, UTC).date()
    else:
        raw = download(a.url)
        source = a.url
        downloaded = a.downloaded or datetime.now(UTC).date()
    try:
        rows = read_rows(raw)
    except (UnicodeDecodeError, ValueError, csv.Error) as e:
        print(f"cannot read code-list.csv: {e}", file=sys.stderr)
        return 1
    ports, skipped = select_ports(rows)
    text = render(ports, source=source, downloaded=downloaded, sha256=hashlib.sha256(raw).hexdigest(), source_rows=len(rows))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(text, encoding="utf-8", newline="\n")
    collisions = sum(1 for p in ports if p.name_collision)
    print(f"{a.out}: {len(ports)} ports ({collisions} name collisions) from {len(rows)} rows; {skipped} malformed rows skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
