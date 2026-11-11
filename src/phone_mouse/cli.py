"""Command-line entry point."""

import argparse
import logging
import sys
from collections.abc import Sequence
from typing import Final

import uvicorn

from phone_mouse import __version__
from phone_mouse.app import create_app
from phone_mouse.input import DriverUnavailableError, create_driver
from phone_mouse.net import detect_lan_ipv4
from phone_mouse.pairing import generate_token, pairing_url, print_pairing_banner
from phone_mouse.session import SessionSettings

DEFAULT_PORT: Final = 8765
_WILDCARD_HOSTS: Final = frozenset({"0.0.0.0", "::"})
_WS_MAX_FRAME_BYTES: Final = 64 * 1024


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="phone-mouse",
        description="Use your iPhone as a trackpad for this Mac.",
    )
    parser.add_argument(
        "--host",
        help="address to listen on (default: this Mac's local network address)",
    )
    parser.add_argument("--port", type=_port, default=DEFAULT_PORT, help=f"default: {DEFAULT_PORT}")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="log gestures instead of moving the real cursor (works on any OS)",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    try:
        driver = create_driver(dry_run=args.dry_run)
    except DriverUnavailableError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    host: str | None = args.host or detect_lan_ipv4()
    if host is None:
        print(
            "error: could not find this Mac's local network address. "
            "Connect to Wi-Fi, or pass --host <address>.",
            file=sys.stderr,
        )
        return 2
    url_host = (detect_lan_ipv4() or host) if host in _WILDCARD_HOSTS else host

    token = generate_token()
    app = create_app(SessionSettings(token=token), driver)
    print_pairing_banner(pairing_url(url_host, args.port, token))
    uvicorn.run(app, host=host, port=args.port, ws_max_size=_WS_MAX_FRAME_BYTES)
    return 0


def _port(value: str) -> int:
    port = int(value)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


if __name__ == "__main__":
    raise SystemExit(main())
