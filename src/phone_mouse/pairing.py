"""Pairing token, pairing URL and the terminal QR code."""

import io
import secrets
import sys

import qrcode


def generate_token() -> str:
    """A fresh secret for this run. It lives only in memory."""
    return secrets.token_urlsafe(32)


def pairing_url(host: str, port: int, token: str) -> str:
    # The token goes in the fragment, which browsers never send to the server,
    # so it cannot end up in request lines or access logs.
    url_host = f"[{host}]" if ":" in host else host
    return f"http://{url_host}:{port}/#{token}"


def render_qr(data: str) -> str:
    """The QR code as plain text, dark modules drawn with block characters."""
    buffer = io.StringIO()
    _make_qr(data).print_ascii(out=buffer)
    return buffer.getvalue()


def print_pairing_banner(url: str) -> None:
    print("\nScan this with your iPhone camera (same Wi-Fi network):\n", flush=True)
    if sys.stdout.isatty():
        # TTY mode paints a white background, so it scans on dark and light terminals alike.
        _make_qr(url).print_ascii(out=sys.stdout, tty=True)
    else:
        print(render_qr(url), end="")
    print(f"\nOr open this address in Safari: {url}", flush=True)
    print("Keep this window open while you use it. Press Ctrl+C to stop.\n", flush=True)


def _make_qr(data: str) -> qrcode.QRCode:
    qr = qrcode.QRCode(border=2)
    qr.add_data(data)
    qr.make(fit=True)
    return qr
