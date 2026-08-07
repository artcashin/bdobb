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
    fake: bool


def load_config(env: Mapping[str, str] | None = None) -> Config:
    e = os.environ if env is None else env
    raw_allowed = e.get("BRIDGE_ALLOWED_DESTINATIONS", "").strip()
    allowed = (
        frozenset(part.strip() for part in raw_allowed.split(",") if part.strip())
        if raw_allowed
        else None
    )
    return Config(
        pod_host=e.get("SYMPHONY_POD_HOST", ""),
        agent_host=e.get("SYMPHONY_AGENT_HOST", ""),
        bot_username=e.get("SYMPHONY_BOT_USERNAME", ""),
        bot_key_path=e.get("SYMPHONY_BOT_KEY_PATH", ""),
        bind=e.get("BRIDGE_BIND", "127.0.0.1:8099"),
        allowed_destinations=allowed,
        fake=e.get("BRIDGE_FAKE", "") == "1",
    )
