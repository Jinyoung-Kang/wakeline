"""후보 4: 원천 보관(raw_store — 72 h, 가리지 않음)은 성공 응답 본문에 되돌아온 키를 그대로 디스크에 남기는가 — 가짜 키로.
또 저장된 실제 응답(fixtures/ · tests/fixtures/)에 키 · 키 이름이 되돌아오는 모양이 있는지 훑는다.
실행: cd apps/collector && uv run --offline python ../../docs/qa/2026-10-aws/evidence/collector/c4_raw_store_keeps_echoed_key.py
"""

import gzip
import tempfile
from pathlib import Path

from wakeline_collector import masking
from wakeline_collector.raw_store import RawStore

FAKE = "QAc4fakeServiceKey0123456789abcdef"
masking.register_secrets(FAKE)
with tempfile.TemporaryDirectory() as d:
    ref = RawStore(d).save("portmis", f'<response><header><resultCode>00</resultCode></header><echo serviceKey="{FAKE}"/></response>'.encode())
    data = gzip.decompress((Path(d) / ref).read_bytes()).decode()
    print(f"raw ref {ref}: fake key on disk = {FAKE in data} (masking registered = {FAKE in masking._SECRETS})")

root = Path.cwd().parents[1]
hits = []
for f in [*root.joinpath("fixtures").glob("*"), *root.joinpath("apps/collector/tests/fixtures").rglob("*")]:
    if f.is_file():
        b = f.read_bytes().lower()
        for k in (b"servicekey", b"authkey", b"apikey", b"api_key", b"client_secret", b"access_token"):
            if k in b:
                hits.append((f.relative_to(root), k.decode()))
print(f"stored real responses scanned: key names found = {hits or 'none'}")
