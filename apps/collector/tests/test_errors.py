"""운영 화면·실행 기록·로그에 싣는 오류 문구(describe_error). 실제로 보였던 repr 문구가 읽히는 한 줄이 되는지 고정한다."""

from __future__ import annotations

import httpx
import pytest

from wakeline_collector.errors import describe_error
from wakeline_collector.http import HostNotAllowed, ProviderHttpError, RequestTimedOut, ResponseTooLarge
from wakeline_collector.ratelimit import Throttled

# 운영 화면에 실제로 보였던 adsb.lol 429 본문(nginx 기본 오류 쪽, ProviderHttpError 가 앞 200자만 담는다)
NGINX_429 = (
    "<html>\r\n<head><title>429 Too Many Requests</title></head>\r\n<body>\r\n"
    "<center><h1>429 Too Many Requests</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n"
)


def _req(
    url: str = "https://apihub.kma.go.kr/api/typ01/url/rdr_cmp_file_list.php?authKey=SECRETKEY123", **timeout
) -> httpx.Request:
    t = {"connect": 4.0, "read": 8.0, "write": 8.0, "pool": 8.0, **timeout}
    return httpx.Request("GET", url, extensions={"timeout": t})


def _with_request(exc: httpx.RequestError, req: httpx.Request) -> httpx.RequestError:
    exc.request = req
    return exc


# ---- ProviderHttpError --------------------------------------------------------------------------------------------
def test_http_429_html_body_uses_title_not_the_markup():
    e = ProviderHttpError(429, NGINX_429)
    assert repr(e).startswith("ProviderHttpError('HTTP 429: <html>\\r\\n<head><title>429 To")  # 보였던 문구(수정 전)
    assert describe_error(e) == "HTTP 429 Too Many Requests"


def test_http_html_without_title_falls_back_to_status_phrase():
    assert describe_error(ProviderHttpError(502, "<html><body><h1>oops</h1></body></html>")) == "HTTP 502 Bad Gateway"
    assert describe_error(ProviderHttpError(503, "<!DOCTYPE html>\n<html lang=en><head><meta charset=utf-8>")) == (
        "HTTP 503 Service Unavailable"
    )


def test_http_title_other_than_the_code_is_kept():
    body = "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>"
    assert describe_error(ProviderHttpError(403, body)) == "HTTP 403 Just a moment..."


def test_http_non_html_body_adds_first_120_chars_on_one_line():
    assert describe_error(ProviderHttpError(404, '{"response": "unknown callsign"}')) == (
        'HTTP 404 Not Found — {"response": "unknown callsign"}'
    )
    long = "error:\r\n  " + "x" * 300
    out = describe_error(ProviderHttpError(500, long))
    assert out == "HTTP 500 Internal Server Error — error: " + "x" * (120 - len("error: "))
    assert "\n" not in out and "\r" not in out


def test_http_unknown_code_and_empty_body():
    assert describe_error(ProviderHttpError(599, "")) == "HTTP 599"
    assert describe_error(ProviderHttpError(418, "")) == "HTTP 418 I'm a Teapot"


def test_http_without_content_keeps_only_code_and_phrase():
    """content=False(노선 조회 — 응답 내용을 다른 곳에 남기지 않는다): 본문·제목을 싣지 않는다."""
    assert describe_error(ProviderHttpError(404, '{"response": "unknown callsign"}'), content=False) == "HTTP 404 Not Found"
    body = "<html><head><title>Just a moment...</title></head></html>"
    assert describe_error(ProviderHttpError(403, body), content=False) == "HTTP 403 Forbidden"


def test_http_body_is_masked():
    out = describe_error(ProviderHttpError(401, '{"error": "bad key", "authKey": "SECRETKEY123"}'))
    assert "SECRETKEY123" not in out and out.startswith("HTTP 401 Unauthorized — ")


# ---- httpx 시간 초과 -----------------------------------------------------------------------------------------------
def test_read_timeout_names_phase_limit_and_host():
    e = _with_request(httpx.ReadTimeout(""), _req(read=15.0))
    assert repr(e) == "ReadTimeout('')"  # 보였던 문구(수정 전)
    assert describe_error(e) == "ReadTimeout — read 제한 15 s 초과 (apihub.kma.go.kr)"


def test_connect_timeout_uses_the_connect_value():
    e = _with_request(httpx.ConnectTimeout(""), _req("https://api.adsb.lol/v2/point/1/2/3"))
    assert repr(e) == "ConnectTimeout('')"
    assert describe_error(e) == "ConnectTimeout — connect 제한 4 s 초과 (api.adsb.lol)"


def test_write_and_pool_timeouts_and_fractional_limit():
    assert describe_error(_with_request(httpx.WriteTimeout(""), _req(write=7.5))) == (
        "WriteTimeout — write 제한 7.5 s 초과 (apihub.kma.go.kr)"
    )
    assert describe_error(_with_request(httpx.PoolTimeout(""), _req())) == "PoolTimeout — pool 제한 8 s 초과 (apihub.kma.go.kr)"


def test_timeout_without_request_does_not_invent_a_limit():
    """요청이 붙지 않은 예외(시험·직접 만든 예외)는 제한값·호스트를 모른다 — 지어내지 않는다."""
    assert describe_error(httpx.ReadTimeout("")) == "ReadTimeout — read 제한 초과"


def test_request_timed_out_keeps_its_message():
    e = RequestTimedOut("apihub.kma.go.kr: no complete response within 40 s")
    assert describe_error(e) == "RequestTimedOut — apihub.kma.go.kr: no complete response within 40 s"


# ---- httpx 연결·프로토콜 오류 ---------------------------------------------------------------------------------------
def test_connect_error_empty_message_says_connection_failed():
    e = _with_request(httpx.ConnectError(""), _req("https://opendata.adsb.fi/api/v2/lat/1/lon/2/dist/3"))
    assert repr(e) == "ConnectError('')"
    assert describe_error(e) == "ConnectError — 연결 실패 (opendata.adsb.fi)"


def test_connect_error_adds_the_cause_text():
    e = _with_request(httpx.ConnectError(""), _req("https://api.adsb.lol/x"))
    e.__cause__ = OSError(111, "Connection refused")
    assert describe_error(e) == "ConnectError — 연결 실패 (api.adsb.lol): OSError: [Errno 111] Connection refused"


def test_connect_error_with_message_and_protocol_error():
    e = _with_request(httpx.ConnectError("[Errno -2] Name or service not known"), _req("https://api.adsb.lol/x"))
    assert describe_error(e) == "ConnectError — [Errno -2] Name or service not known (api.adsb.lol)"
    p = _with_request(httpx.RemoteProtocolError(""), _req("https://api.adsb.lol/x"))
    assert describe_error(p) == "RemoteProtocolError — 연결 실패 (api.adsb.lol)"
    p2 = _with_request(httpx.RemoteProtocolError("Server disconnected without sending a response."), _req())
    assert describe_error(p2) == "RemoteProtocolError — Server disconnected without sending a response. (apihub.kma.go.kr)"


def test_read_error_empty_message():
    assert describe_error(_with_request(httpx.ReadError(""), _req())) == "ReadError — 응답 읽기 실패 (apihub.kma.go.kr)"


# ---- 그 밖 -------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "exc,expected",
    [
        (
            Throttled("api.adsb.lol", "cooling down 60 s after HTTP 429"),
            "Throttled — throttled api.adsb.lol: cooling down 60 s after HTTP 429",
        ),
        (ResponseTooLarge("9000000 bytes > 8388608"), "ResponseTooLarge — 9000000 bytes > 8388608"),
        (HostNotAllowed("evil.example"), "HostNotAllowed — evil.example"),
        (ValueError("not gzip: '# file not exist'"), "ValueError — not gzip: '# file not exist'"),
        (KeyError("icaoId"), "KeyError — 'icaoId'"),
        (RuntimeError(), "RuntimeError"),
    ],
    ids=lambda v: v if isinstance(v, str) else type(v).__name__,
)
def test_other_errors_keep_their_message_prefixed_by_type(exc, expected):
    assert describe_error(exc) == expected


def test_other_errors_without_content_keep_only_the_type():
    assert describe_error(ValueError("response said: secret route data"), content=False) == "ValueError"


def test_single_line_masked_and_bounded():
    out = describe_error(ValueError("line1\nline2 password=hunter2 " + "y" * 1000))
    assert "\n" not in out and "hunter2" not in out
    assert out.startswith("ValueError — line1 line2 password=***")
    assert len(out) <= 300


def test_every_description_starts_with_the_type_or_http_code():
    """로그 지문(fp)이 종류별로 묶이도록 — 앞머리는 예외 종류(HTTP 오류는 'HTTP <code>')."""
    cases = [
        ProviderHttpError(429, NGINX_429),
        _with_request(httpx.ReadTimeout(""), _req()),
        _with_request(httpx.ConnectError(""), _req()),
        RequestTimedOut("x"),
        Throttled("h", "r"),
    ]
    heads = [describe_error(e).split(" ", 1)[0] for e in cases]
    assert heads == ["HTTP", "ReadTimeout", "ConnectError", "RequestTimedOut", "Throttled"]
