import pytest

from phone_mouse.session import ClickCounter, RateLimiter, SessionSettings, origin_matches_host


@pytest.mark.parametrize(
    ("origin", "host", "expected"),
    [
        ("http://192.168.1.5:8765", "192.168.1.5:8765", True),
        ("https://192.168.1.5:8765", "192.168.1.5:8765", True),
        ("http://MyMac.local:8765", "mymac.local:8765", True),
        ("http://192.168.1.5:8765", "192.168.1.5:9999", False),
        ("http://evil.example", "192.168.1.5:8765", False),
        ("null", "192.168.1.5:8765", False),
        ("file://192.168.1.5:8765", "192.168.1.5:8765", False),
        (None, "192.168.1.5:8765", False),
        ("http://192.168.1.5:8765", None, False),
        ("", "", False),
    ],
)
def test_origin_must_match_host(origin: str | None, host: str | None, expected: bool) -> None:
    assert origin_matches_host(origin, host) is expected


def test_rate_limiter_allows_the_limit_and_rejects_one_more() -> None:
    limiter = RateLimiter(limit=240, window=1.0)
    assert all(limiter.allow(10.0) for _ in range(240))
    assert not limiter.allow(10.0)


def test_rate_limiter_window_slides() -> None:
    limiter = RateLimiter(limit=2, window=1.0)
    assert limiter.allow(0.0)
    assert limiter.allow(0.5)
    assert not limiter.allow(0.9)
    assert limiter.allow(1.6)  # 0.0 and 0.5 have left the window; 0.9 and 1.6 remain
    assert not limiter.allow(1.7)


def test_click_counter_counts_quick_repeats_up_to_three() -> None:
    clicks = ClickCounter(interval=0.3)
    assert [clicks.register("left", t) for t in (0.0, 0.1, 0.2, 0.3, 0.4)] == [1, 2, 3, 3, 3]


def test_click_counter_resets_after_a_pause_or_on_another_button() -> None:
    clicks = ClickCounter(interval=0.3)
    assert clicks.register("left", 0.0) == 1
    assert clicks.register("left", 0.4) == 1
    assert clicks.register("right", 0.5) == 1
    assert clicks.register("left", 0.6) == 1


def test_settings_repr_hides_the_token() -> None:
    assert "s3cret" not in repr(SessionSettings(token="s3cret"))
