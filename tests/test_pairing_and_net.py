import platform
import socket
from typing import Any

import pytest

from phone_mouse import net
from phone_mouse.input import DriverUnavailableError, create_driver
from phone_mouse.input.fake import FakeDriver
from phone_mouse.pairing import generate_token, pairing_url, render_qr


def test_tokens_are_long_url_safe_and_unique() -> None:
    tokens = {generate_token() for _ in range(50)}
    assert len(tokens) == 50
    for token in tokens:
        assert len(token) >= 43
        assert set(token) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def test_pairing_url_puts_the_token_in_the_fragment() -> None:
    assert pairing_url("192.168.1.5", 8765, "tok") == "http://192.168.1.5:8765/#tok"


def test_pairing_url_brackets_ipv6_hosts() -> None:
    assert pairing_url("fe80::1", 8765, "tok") == "http://[fe80::1]:8765/#tok"


def test_render_qr_draws_a_square_block_of_text() -> None:
    lines = render_qr("http://192.168.1.5:8765/#tok").splitlines()
    assert len(lines) > 10
    assert len({len(line) for line in lines}) == 1


class FakeSocket:
    def __init__(self, address: str | None) -> None:
        self._address = address

    def __enter__(self) -> "FakeSocket":
        return self

    def __exit__(self, *args: object) -> None:
        pass

    def connect(self, address: tuple[str, int]) -> None:
        if self._address is None:
            raise OSError("Network is unreachable")

    def getsockname(self) -> tuple[str | None, int]:
        return (self._address, 51000)


@pytest.mark.parametrize(
    ("address", "expected"),
    [
        ("192.168.1.5", "192.168.1.5"),
        ("127.0.0.1", None),
        ("0.0.0.0", None),
        (None, None),
    ],
)
def test_detect_lan_ipv4(
    monkeypatch: pytest.MonkeyPatch, address: str | None, expected: str | None
) -> None:
    def fake_socket(*args: Any, **kwargs: Any) -> FakeSocket:
        return FakeSocket(address)

    monkeypatch.setattr(socket, "socket", fake_socket)
    assert net.detect_lan_ipv4() == expected


def test_create_driver_dry_run_gives_the_fake() -> None:
    assert isinstance(create_driver(dry_run=True), FakeDriver)


def test_create_driver_without_a_real_driver_raises_a_clear_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    with pytest.raises(DriverUnavailableError, match="--dry-run"):
        create_driver(dry_run=False)
