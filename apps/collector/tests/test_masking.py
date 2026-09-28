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
