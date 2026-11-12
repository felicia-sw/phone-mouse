import os
import platform
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx2 as httpx
import pytest

from phone_mouse import __version__, cli


def test_version_flag_prints_version_and_exits_zero(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["--version"])

    assert exit_info.value.code == 0
    assert capsys.readouterr().out.strip() == f"phone-mouse {__version__}"


@pytest.mark.parametrize("port", ["0", "65536", "http"])
def test_invalid_port_is_rejected(port: str) -> None:
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["--dry-run", "--port", port])
    assert exit_info.value.code == 2


def test_without_dry_run_and_no_real_driver_exits_with_a_clear_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    assert cli.main(["--host", "127.0.0.1"]) == 2
    assert "--dry-run" in capsys.readouterr().err


def test_no_network_address_exits_with_a_clear_error(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(cli, "detect_lan_ipv4", lambda: None)
    assert cli.main(["--dry-run"]) == 2
    assert "--host" in capsys.readouterr().err


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


def test_dry_run_starts_prints_url_and_qr_and_serves_healthz(tmp_path: Path) -> None:
    port = _free_port()
    stderr_path = tmp_path / "stderr.log"
    with stderr_path.open("w") as stderr:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "phone_mouse.cli",
                "--dry-run",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        try:
            status = _wait_for_healthz(port)
        finally:
            process.terminate()
            stdout, _ = process.communicate(timeout=10)

    assert status == 200, stderr_path.read_text()
    assert f"http://127.0.0.1:{port}/#" in stdout
    assert "█" in stdout  # the QR code


def _wait_for_healthz(port: int) -> int:
    # trust_env=False: never route a localhost request through a configured proxy.
    with httpx.Client(trust_env=False) as client:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                return client.get(f"http://127.0.0.1:{port}/healthz").status_code
            except httpx.TransportError:
                time.sleep(0.1)
    return 0
