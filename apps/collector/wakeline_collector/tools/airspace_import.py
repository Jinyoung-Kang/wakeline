"""공역 자료 가져오기(ADR-034 · SPEC F1-1) — `make airspace-import f=<KMZ·KML> [edition="AIP 25년 5차"]`.

파일은 표준 입력으로만 받는다(컨테이너는 읽기 전용 루트 · 볼륨을 더 열지 않는다). 국토교통부 저작물이라 저장소에 넣지 않는다.
  python -m wakeline_collector.tools.airspace_import [--edition 이름] [--dry-run] < 파일
--dry-run 은 해석 결과만 보이고 DB 에 닿지 않는다. 종료 코드: 0 성공 · 1 자료 거절 · 2 DB 실패 · 3 인자 오류.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import sys

from wakeline_collector import airspace, airspace_store, db
from wakeline_collector.masking import mask


def _read_stdin() -> bytes:
    data = sys.stdin.buffer.read(airspace.MAX_INPUT_BYTES + 1)
    if len(data) > airspace.MAX_INPUT_BYTES:
        raise airspace.AirspaceTooLarge(f"input too large (> {airspace.MAX_INPUT_BYTES} bytes)")
    return data


def _report(res: airspace.ParseResult, sha: str) -> None:
    print(f"원본 SHA-256 {sha}")
    print(f"문서 이름: {res.document_name or '—'} · 도형 {len(res.features)}개 · 점 {res.points:,}개")
    for k, v in res.counts().items():
        print(f"  {k:<14} {v}")
    if res.skipped:
        print("건너뜀: " + ", ".join(f"{k} {v}" for k, v in sorted(res.skipped.items())))


async def _write(label: str, sha: str, res: airspace.ParseResult) -> airspace_store.ImportReport:
    pool = await db.open_pool()
    try:
        return await airspace_store.import_edition(pool, label=label, sha256=sha, res=res)
    finally:
        await pool.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="airspace_import", description="공역 KMZ/KML 을 표준 입력으로 받아 가져온다")
    ap.add_argument("--edition", help="기준 차수 이름(예: 'AIP 25년 5차'). 없으면 KML 문서 이름")
    ap.add_argument("--dry-run", action="store_true", help="해석만 하고 DB 에 쓰지 않는다")
    args = ap.parse_args(argv)
    if sys.stdin.isatty():
        print("파일을 표준 입력으로 주세요: … < 파일.kmz", file=sys.stderr)
        return 3
    try:
        data = _read_stdin()
        sha = hashlib.sha256(data).hexdigest()
        res = airspace.parse(data)
    except airspace.AirspaceError as e:
        print(f"거절: {e}", file=sys.stderr)
        return 1
    _report(res, sha)
    label = " ".join((args.edition or res.document_name or "").split())
    if not 1 <= len(label) <= 80:
        print("기준 차수 이름이 없거나 80자를 넘는다 — --edition 으로 준다", file=sys.stderr)
        return 3
    if not res.features:
        print("거절: 도형이 하나도 없다", file=sys.stderr)
        return 1
    if args.dry_run:
        print(f"(dry-run) 기준 차수 '{label}' — DB 에 쓰지 않음")
        return 0
    try:
        rep = asyncio.run(_write(label, sha, res))
    except Exception as e:  # noqa: BLE001 — 명령의 끝: 까닭을 보이고 실패 코드(되돌려졌다 — 한 트랜잭션)
        print(f"DB 실패(아무것도 바뀌지 않음): {type(e).__name__}: {(mask(str(e)) or '')[:300]}", file=sys.stderr)
        return 2
    if rep.status == "already_active":
        print(f"이미 켜진 차수다(id {rep.edition_id}) — 바꾼 것 없음")
    elif rep.status == "reactivated":
        print(f"같은 원본의 옛 차수(id {rep.edition_id})를 다시 켰다 — 앞 차수 id {rep.previous_active}")
    else:
        print(
            f"가져옴: 차수 id {rep.edition_id} '{label}' · 도형 {rep.inserted}개(고친 도형 {rep.fixed} · 고쳐도 빈 도형 {rep.dropped}) · "
            f"앞 차수 id {rep.previous_active if rep.previous_active is not None else '없음'} 은 끔(지우지 않음). api 는 60 s 안에 바꾼다"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
