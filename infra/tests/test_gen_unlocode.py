"""tools/gen_unlocode.py 단위 시험(계약 v4 §B). 네트워크를 쓰지 않는다 — 합성 code-list.csv 로 임시 디렉터리에서 돈다.

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("gen_unlocode", ROOT / "tools" / "gen_unlocode.py")
gen = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules["gen_unlocode"] = gen  # dataclass 가 모듈을 찾을 수 있게
_spec.loader.exec_module(gen)

HEAD = "Change,Country,Location,Name,NameWoDiacritics,Subdivision,Status,Function,Date,IATA,Coordinates,Remarks\n"
# 합성 행(실제 표의 모양만 따른다): 항구 · 내륙항 · 항구 아님 · 같은 코드의 다른 이름 · 형식 오류 · 코드와 같은 지명
ROWS = [
    ",ZZ,ABC,Alpha Port,Alpha Port,01,AI,1-3-----,2401,,,",
    ",ZZ,IN8,Inland\tTown,Inland Town,,RL,--3--68-,2401,,,",
    ",ZZ,RDX,Road Only,Road Only,,RL,--3-----,2401,,,",
    ",ZZ,ABC,Alpha Other Name,Alpha Other Name,01,AI,1-3-----,2401,,,",
    ",Z1,BAD,Bad Country,Bad Country,,RL,1-------,2401,,,",
    ",ZZ,VAN,Vantown,Vantown,XX9,RL,1-------,2401,,,",
    ",YY,CAV,Zzvan,Zzvan,,RL,--3-----,2401,,,",
    ",QQ,ÉVI,Évian,Evian,,RL,--3-----,2401,,,",
    ",ZZ,EVI,Zz Evi,Zz Evi,TOOLONG,RL,1-------,2401,,,",
]
CSV = (HEAD + "\n".join(ROWS) + "\n").encode("utf-8")


class GenUnlocodeTest(unittest.TestCase):
    def test_is_port(self) -> None:
        self.assertTrue(gen.is_port("1-------"))
        self.assertTrue(gen.is_port("--3--68-"))
        self.assertFalse(gen.is_port("-2345---"))
        self.assertFalse(gen.is_port(""))

    def test_clean(self) -> None:
        self.assertEqual(gen.clean("  a\tb\r\n  c\x7f "), "a b c")

    def test_letter_names_are_five_letter_ascii_names(self) -> None:
        names = gen.letter_names(gen.read_rows(CSV))
        self.assertIn("ZZVAN", names)
        self.assertIn("EVIAN", names)  # 발음 구별 기호 없는 이름으로
        self.assertNotIn("ALPHA PORT", names)

    def test_select_ports(self) -> None:
        ports, skipped = gen.select_ports(gen.read_rows(CSV))
        self.assertEqual([p.code for p in ports], ["ZZABC", "ZZEVI", "ZZIN8", "ZZVAN"])
        self.assertEqual(skipped, 1)  # 나라 코드 형식 오류
        by = {p.code: p for p in ports}
        self.assertEqual(by["ZZABC"].name, "Alpha Port")  # 같은 코드는 원본 순서의 첫 줄
        self.assertEqual(by["ZZABC"].subdivision, "01")
        self.assertEqual(by["ZZIN8"].name, "Inland Town")  # 탭은 공백으로
        self.assertEqual(by["ZZEVI"].subdivision, "")  # 형식이 틀린 행정구역은 싣지 않는다
        self.assertFalse(by["ZZABC"].name_collision)
        self.assertTrue(by["ZZVAN"].name_collision)  # 코드 ZZVAN = 다른 곳의 지명 Zzvan(항구가 아니어도)

    def test_name_collision_needs_a_matching_place_name(self) -> None:
        rows = [r for r in gen.read_rows(CSV) if r["Name"] != "Zzvan"]
        by = {p.code: p for p in gen.select_ports(rows)[0]}
        self.assertFalse(by["ZZVAN"].name_collision)

    def test_read_rows_requires_columns(self) -> None:
        with self.assertRaises(ValueError):
            gen.read_rows(b"Country,Location\nZZ,ABC\n")
        with self.assertRaises(ValueError):
            gen.read_rows(HEAD.encode())

    def test_main_writes_the_tsv_with_a_header(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "code-list.csv", Path(d) / "out" / "ports.tsv"
            src.write_bytes(CSV)
            os.utime(src, (1_790_000_000, 1_790_000_000))  # 2026-09-21 UTC
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(gen.main(["--csv", str(src), "--out", str(out)]), 0)
            lines = out.read_text(encoding="utf-8").splitlines()
            head = [line for line in lines if line.startswith("#")]
            self.assertIn("# licence: ODC-PDDL-1.0", head)
            self.assertIn("# downloaded: 2026-09-21", head)
            self.assertIn("# rows: 4", head)
            self.assertIn(f"# source_rows: {len(ROWS)}", head)
            self.assertIn(f"# source: {gen.DEFAULT_URL}", head)
            body = [line for line in lines if not line.startswith("#")]
            self.assertEqual(body[0], "\t".join(gen.COLUMNS))
            self.assertEqual(body[1], "ZZABC\tAlpha Port\tZZ\t01\t1-3-----\t0")
            self.assertEqual(len(body), 5)
            with contextlib.redirect_stdout(io.StringIO()):
                gen.main(["--csv", str(src), "--out", str(out), "--downloaded", "2026-09-28"])
            self.assertIn("# downloaded: 2026-09-28", out.read_text(encoding="utf-8"))
            src.write_bytes(b"\xff\xfe")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(gen.main(["--csv", str(src), "--out", str(out)]), 1)

    def test_download_is_https_only(self) -> None:
        with self.assertRaises(ValueError):
            gen.download("http://example.invalid/code-list.csv")

    def test_render_marks_collisions(self) -> None:
        p = gen.Port("ZZVAN", "Vantown", "ZZ", "", "1-------", True)
        text = gen.render([p], source="s", downloaded=date(2026, 9, 28), sha256="0" * 64, source_rows=1)
        self.assertTrue(text.endswith("ZZVAN\tVantown\tZZ\t\t1-------\t1\n"))


if __name__ == "__main__":
    unittest.main()
