import pytest

from skywx_collector.masking import mask


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
