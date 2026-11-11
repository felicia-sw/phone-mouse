"""Find this machine's address on the local network."""

import ipaddress
import socket

# TEST-NET-1 (RFC 5737). connect() on a UDP socket only picks a route; no packet is sent.
_ROUTE_PROBE = ("192.0.2.1", 9)


def detect_lan_ipv4() -> str | None:
    """The IPv4 address of the interface holding the default route, or None if there is none."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(_ROUTE_PROBE)
            address = sock.getsockname()[0]
    except OSError:
        return None
    if not isinstance(address, str):
        return None
    parsed = ipaddress.ip_address(address)
    if parsed.is_loopback or parsed.is_unspecified:
        return None
    return address
