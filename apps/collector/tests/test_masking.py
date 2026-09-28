import re

import pytest

from wakeline_collector.masking import mask


@pytest.mark.parametrize(
    "text,hidden",
    [
        ("POST token client_secret=abc123&grant_type=x", "abc123"),
        ("client_id=myid&x=1", "myid"),
        (
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ),
        ("Bearer abcdefghijklmnop", "abcdefghijklmnop"),
        ("url?serviceKey=SK123&type=json", "SK123"),
        ("rdr_cmp_file.php?tm=1&authKey=KMA_SECRET_1", "KMA_SECRET_1"),
        ("api_key=KEY99", "KEY99"),
        ("password=hunter2", "hunter2"),
        ("token=tok_1", "tok_1"),
        ("secret=s3cr3t", "s3cr3t"),
        ("redis://default:pa55@redis:6379/0", "pa55"),
    ],
)
def test_patterns(text, hidden):
    out = mask(text)
    assert hidden not in out


def test_none_and_limit():
    assert mask(None) is None
    assert len(mask("x" * 10000)) == 4000


# ---- R-83: '=' 없는 JSON 형태 · 설정된 비밀값 그 자체 · 로그 경로 ------------------------------------------------------
@pytest.mark.parametrize(
    "text,hidden",
    [
        ('{"result":"error","authKey":"KMA_SECRET_1"}', "KMA_SECRET_1"),
        ('{"client_secret": "abc123xyz"}', "abc123xyz"),
        ('{"APIKey":"ais-key-777","BoundingBoxes":[]}', "ais-key-777"),  # aisstream 구독 프레임 모양
        ("{'access_token': 'tok_ABCDEF'}", "tok_ABCDEF"),
    ],
)
def test_r83_json_shaped_secrets_are_hidden(text, hidden):
    assert hidden not in mask(text)


def test_r83_registered_secret_values_are_replaced_anywhere():
    from wakeline_collector import masking

    masking.register_secrets("Zq9-KMA-real-key-value", "", "ab")  # 빈 값·너무 짧은 값은 무시(흔한 글자를 가리지 않게)
    try:
        out = mask("upstream echoed Zq9-KMA-real-key-value in its error page (ab)")
        assert "Zq9-KMA-real-key-value" not in out and "(ab)" in out
    finally:
        masking.register_secrets()  # 등록 해제(다른 시험에 영향 없게)
        masking._SECRETS.clear()


def test_r83_log_filter_masks_message_args_and_tracebacks():
    import io
    import logging

    from wakeline_collector import masking

    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    lg = logging.getLogger("test.r83")
    lg.propagate = False
    lg.addHandler(handler)
    masking.register_secrets("VeryS3cretKmaKey")
    try:
        masking.install_log_masking(handler)
        e = ValueError('not gzip: {"authKey":"VeryS3cretKmaKey"}')
        lg.warning("kma radar: %r", e)  # ais/main.py 처럼 %r 로 찍는 예외
        try:
            raise RuntimeError("provider said token=abc.def and VeryS3cretKmaKey")
        except RuntimeError:
            lg.exception("region: unhandled error (#1)")  # scheduler.py 의 log.exception(트레이스백)
    finally:
        lg.removeHandler(handler)
        masking._SECRETS.clear()
    out = buf.getvalue()
    assert "VeryS3cretKmaKey" not in out and "abc.def" not in out
    assert "kma radar:" in out and "Traceback" in out and "RuntimeError" in out  # 내용은 남고 비밀값만 가린다


def test_r83_collector_and_ais_logging_install_the_mask_filter(monkeypatch):
    import logging

    from wakeline_collector import main as col_main
    from wakeline_collector import masking
    from wakeline_collector.ais import main as ais_main

    root = logging.getLogger()
    before = list(root.handlers)
    probe = logging.StreamHandler()
    root.addHandler(probe)
    try:
        col_main.configure_logging(["collector-secret-123"])
        assert any(isinstance(f, masking.MaskFilter) for f in probe.filters)
        probe.filters.clear()
        ais_main._configure_logging(["ais-secret-4567"])
        assert any(isinstance(f, masking.MaskFilter) for f in probe.filters)
        assert "ais-secret-4567" not in mask("x ais-secret-4567 y") and "collector-secret-123" not in mask("collector-secret-123")
    finally:
        root.handlers[:] = before
        masking._SECRETS.clear()


# ---- 계약 v5 §C5: 언어 간 시험 벡터(Java LogMasker 와 글자 하나까지 같은 결과) -----------------------------------------------
def _vectors() -> dict:
    import json

    from conftest import ROOT

    return json.loads((ROOT / "schemas" / "vectors" / "masking-cases.v1.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", _vectors()["cases"], ids=lambda c: c["input"][:40])
def test_v5_c5_masking_vectors_match_exactly(case):
    assert mask(case["input"], _vectors()["limit"]) == case["expected"]


@pytest.mark.parametrize(
    "text,expected",
    [
        ("https://h.test/p?key=ABCDEFGH12345", "https://h.test/p?key=***"),
        ("https://h.test/p?a=1&KEY=abc&b=2", "https://h.test/p?a=1&KEY=***&b=2"),
        ("https://h.test/p?access_key=AKIA123 then", "https://h.test/p?access_key=*** then"),
        ("https://h.test/p?apikey=z9", "https://h.test/p?apikey=***"),
        # 쿼리 파라미터가 아닌 'key=' 는 새 규칙 밖이다(다른 뜻의 낱말까지 가리지 않게)
        ("cache key=region:36.5 hit", "cache key=region:36.5 hit"),
        ("monkey=1&x=2", "monkey=1&x=2"),
    ],
)
def test_v5_c5_query_key_rule(text, expected):
    assert mask(text) == expected


def test_v5_masking_is_linear_on_long_word_runs():
    """URL userinfo 규칙이 긴 낱말 글자열(base64·16진 덤프 등)에서 되짚기로 제곱 시간이 되지 않는다 — 로그 한 줄(LOG_LIMIT)을 가리는
    동안 이벤트 루프가 멈추면 안 된다(계약 v5 §C2). 결과는 그대로다: 낱말 안에서 시작하는 일치는 그 낱말 처음에서도 일치한다."""
    import time

    from wakeline_collector import masking

    blob = "A" * masking.LOG_LIMIT
    t0 = time.perf_counter()
    assert mask(blob, masking.LOG_LIMIT) == blob
    assert mask("x" + "가" * 50_000 + " redis://u:pw9@h", masking.LOG_LIMIT).endswith(" redis://u:***@h")
    assert time.perf_counter() - t0 < 1.0
    assert mask("jdbc:postgresql://u:p@db/x") == "jdbc:postgresql://u:***@db/x"


def test_v5_masking_is_linear_on_separator_delimited_urls_and_jwt_runs():
    """공백 없는 긴 글(압축 JSON 의 포트 달린 URL 목록 · 'a://x:' 반복 · 'eyJ' 반복)에서 userinfo · JWT 규칙이 시작점마다 줄 끝까지
    다시 훑으면 제곱 시간이다 — 로그 한 건을 가리는 동안 이벤트 루프가 몇 초씩 멈춘다(계약 v5 §C2). 결과는 그대로여야 한다."""
    import time

    tiles = '{"tiles":[' + ",".join(f'"https://m{i}.tiles.test:8443/z/{i}.png"' for i in range(1500)) + "]}"
    cases = ["a://x:" * 5000, "eyJ" * 10_000, tiles]
    t0 = time.perf_counter()
    for text in cases:
        assert mask(text, None) == text  # '@' · 점 세 칸이 없다 — 가릴 것 없음
    assert time.perf_counter() - t0 < 1.0  # 선형이면 ~0.05 s, 고치기 전(제곱)은 2.9 s — 부하가 큰 기계에서도 흔들리지 않게
    assert mask("a://x:" * 3 + "pw@h") == "a://x:***@h"
    assert mask("eyJ" * 3 + "a" * 10 + ".b" + "b" * 10 + ".c" + "c" * 10) == "***jwt***"


# 바꾸기 전의 두 규칙(되짚기 정규식) — 새 규칙이 글자 하나까지 같은 결과를 내는지 무작위 글로 견준다(Java LogMasker 와 같은 규칙 유지)
_OLD_USERINFO = re.compile(r"(?<!\w)(\w+://[^:/\s]+:)[^@\s]+(@)")
_OLD_JWT = re.compile(r"eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}")


def _old_mask(text: str) -> str:
    from wakeline_collector import masking

    out = text
    for pat, repl in masking._PATTERNS[:-2]:
        out = pat.sub(repl, out)
    out = _OLD_USERINFO.sub(r"\1***\2", out)
    return _OLD_JWT.sub("***jwt***", out)


def test_v5_linear_userinfo_and_jwt_rules_give_the_same_output_as_the_backtracking_ones():
    import random

    rnd = random.Random(20260929)
    parts = [
        " ",
        "\n",
        *"a|b9|x|_|-|가|é|:|//|://|/|@|.|=|&|eyJ|abcdefghij|0123456789|redis://|https://|u:|pw@|h:6379".split("|"),
    ]
    parts += ["eyJhbGciOiJIUzI1NiJ9.", "eyJ0eXAiOiJKV1Qi", "sig_-012345678.", "password=", "?key="]
    for _ in range(20_000):
        text = "".join(rnd.choice(parts) for _ in range(rnd.randint(0, 40)))
        assert mask(text, None) == _old_mask(text), repr(text)
