"""끊김 사유 구분: 서버 close 프레임 · 우리가 먼저 닫음(ping timeout 등) · 프레임 없이 끊김 — 공백 사유로 남아 원인 진단에 쓰인다."""

from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK
from websockets.frames import Close

from wakeline_collector.ais.client import _closed_reason


def test_server_close_frame_is_reported_with_code_and_reason():
    assert (
        _closed_reason(ConnectionClosedOK(Close(1000, "bye"), Close(1000, "bye"), rcvd_then_sent=True))
        == "server closed (1000 bye)"
    )
    assert _closed_reason(ConnectionClosedError(Close(1011, ""), None)) == "server closed (1011)"


def test_our_own_close_is_not_blamed_on_the_server():
    e = ConnectionClosedError(None, Close(1011, "keepalive ping timeout"))
    assert _closed_reason(e) == "client closed (1011 keepalive ping timeout)"
    assert _closed_reason(ConnectionClosedError(None, Close(1009, ""))) == "client closed (1009)"


def test_no_frame_either_way_is_a_lost_connection():
    assert _closed_reason(ConnectionClosedError(None, None)) == "connection lost (no close frame)"
