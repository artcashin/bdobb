"""Environment parsing. The service is configured entirely by env vars plus a
mounted key file -- nothing is read from a config file in the image."""

import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    pod_host: str
    agent_host: str
    bot_username: str
    bot_key_path: str
    bind: str
    # None means no allowlist is configured (all destinations permitted).
    # An empty frozenset would mean "permit nothing", which is why blank input
    # must normalise to None rather than to an empty set.
    allowed_destinations: frozenset[str] | None
    # None means "operator did not override" -- app/main.py fills in a default
    # (loopback plus whatever BRIDGE_BIND resolves to) at app-creation time.
    # Unlike allowed_destinations, None here is NOT "no restriction": Host/
    # Origin checking (DNS-rebinding protection) stays on regardless; only the
    # allowlist contents are defaulted.
    allowed_hosts: frozenset[str] | None
    fake: bool


def _parse_comma_separated(raw: str) -> frozenset[str] | None:
    """Same three-state contract as BRIDGE_ALLOWED_DESTINATIONS: blank,
    whitespace-only, and comma-only input all collapse to None rather than an
    empty frozenset, so a typo can't silently produce "permit/allow nothing"
    (allowed_destinations) or "match nothing, i.e. reject everything"
    (allowed_hosts)."""
    parsed = frozenset(part.strip() for part in raw.strip().split(",") if part.strip())
    return parsed or None


def load_config(env: Mapping[str, str] | None = None) -> Config:
    e = os.environ if env is None else env
    return Config(
        pod_host=e.get("SYMPHONY_POD_HOST", ""),
        agent_host=e.get("SYMPHONY_AGENT_HOST", ""),
        bot_username=e.get("SYMPHONY_BOT_USERNAME", ""),
        bot_key_path=e.get("SYMPHONY_BOT_KEY_PATH", ""),
        bind=e.get("BRIDGE_BIND", "127.0.0.1:8099"),
        allowed_destinations=_parse_comma_separated(e.get("BRIDGE_ALLOWED_DESTINATIONS", "")),
        allowed_hosts=_parse_comma_separated(e.get("BRIDGE_ALLOWED_HOSTS", "")),
        fake=e.get("BRIDGE_FAKE", "") == "1",
    )
