"""libre-bdobb guard: lets BDOBB reach a Libre Terminal that only answers its own local page.

Libre Terminal refuses any request whose Host is not this computer or whose Origin is not its
own page. BDOBB's desktop app always sends its own Origin, so every request is refused. The guard
sits in the same container, applies the same kind of checks with BDOBB added to the allow-list,
then forwards the request as a plain local client (local Host, no Origin).

Standard library only. Configuration is by environment variable; see README.md.
"""
from __future__ import annotations

import hmac
import http.client
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

DESKTOP_ORIGINS = "tauri://localhost,http://tauri.localhost"
# Never forwarded: they describe the caller's page, which the upstream would refuse, or the hop.
STRIP_REQUEST = {"host", "origin", "referer", "connection", "keep-alive", "proxy-connection", "upgrade",
                 "te", "trailer", "transfer-encoding", "sec-fetch-site", "sec-fetch-mode",
                 "sec-fetch-dest", "sec-fetch-user", "x-libre-token"}
# The upstream's CORS answers name its own page; the desktop app does not use CORS.
STRIP_RESPONSE = {"connection", "keep-alive", "transfer-encoding", "content-length",
                  "access-control-allow-origin", "access-control-allow-credentials", "vary"}


def csv(value: str) -> set[str]:
    return {item.strip().lower() for item in value.split(",") if item.strip()}


class Config:
    def __init__(self, env=os.environ):
        self.origins = csv(env.get("LIBRE_GUARD_ORIGINS", DESKTOP_ORIGINS))
        self.hosts = csv(env.get("LIBRE_GUARD_HOSTS", "localhost,127.0.0.1"))
        self.token = env.get("LIBRE_GUARD_TOKEN", "").strip()
        self.timeout = float(env.get("LIBRE_GUARD_TIMEOUT", "120"))
        self.upstream_host = env.get("LIBRE_GUARD_UPSTREAM_HOST", "127.0.0.1")
        # listen port -> Libre Terminal port
        self.routes = {int(env.get("LIBRE_GUARD_DATA_PORT", "7900")): int(env.get("TERMINAL_V5_PORT", "6900")),
                       int(env.get("LIBRE_GUARD_VIEWS_PORT", "7950")): int(env.get("TERMINAL_UI_PORT", "6950"))}


def hostname(host_header: str) -> str:
    """The name part of a Host header, lower case, without the port ([::1]:80 -> [::1])."""
    value = host_header.strip().lower()
    if value.startswith("["):
        return value.split("]", 1)[0] + "]"
    return value.rsplit(":", 1)[0] if ":" in value else value


def refusal(headers, config: Config) -> tuple[int, str] | None:
    """Why this request is refused, or None when it may be forwarded."""
    if "*" not in config.hosts and hostname(headers.get("Host", "")) not in config.hosts:
        return 421, "This guard does not answer for that host name."
    origin = headers.get("Origin")
    if origin is not None:
        if origin.strip().lower() not in config.origins:
            return 403, "Refused: this origin is not on the guard's allow-list."
    elif (headers.get("Sec-Fetch-Site") or "").strip().lower() == "cross-site":
        return 403, "Refused: cross-site request."
    if config.token:
        bearer = headers.get("Authorization", "")
        offered = headers.get("X-Libre-Token") or (bearer[7:] if bearer[:7].lower() == "bearer " else "")
        if not hmac.compare_digest(offered.encode(), config.token.encode()):
            return 401, "A valid guard token is required."
    return None


def handler_for(config: Config, target_port: int):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "libre-bdobb-guard"
        sys_version = ""

        def _reply(self, status: int, detail: str):
            body = json.dumps({"detail": detail}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _forward(self):
            refused = refusal(self.headers, config)
            if refused:
                return self._reply(*refused)
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._reply(400, "Bad Content-Length.")
            body = self.rfile.read(length) if length > 0 else None
            headers = {k: v for k, v in self.headers.items() if k.lower() not in STRIP_REQUEST}
            if config.token and headers.get("Authorization", "")[:7].lower() == "bearer ":
                del headers["Authorization"]          # the guard's own token is not the upstream's business
            headers["Host"] = f"127.0.0.1:{target_port}"
            upstream = http.client.HTTPConnection(config.upstream_host, target_port, timeout=config.timeout)
            try:
                upstream.request(self.command, self.path, body=body, headers=headers)
                response = upstream.getresponse()
                data = response.read()
            except (OSError, http.client.HTTPException) as error:
                return self._reply(502, f"Libre Terminal did not answer: {type(error).__name__}.")
            finally:
                upstream.close()
            try:
                self.send_response(response.status)
                for name, value in response.getheaders():
                    if name.lower() not in STRIP_RESPONSE:
                        self.send_header(name, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)
            except OSError:          # the caller hung up before the answer was written
                self.close_connection = True

        do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = _forward

        def log_message(self, *args):          # request lines may carry symbols a user typed; keep them out of logs
            pass

    return Handler


def serve(config: Config, bind: str = "0.0.0.0") -> list[ThreadingHTTPServer]:
    servers = []
    for listen_port, target_port in config.routes.items():
        server = ThreadingHTTPServer((bind, listen_port), handler_for(config, target_port))
        server.daemon_threads = True
        Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    return servers


def main():
    config = Config()
    serve(config, os.environ.get("LIBRE_GUARD_BIND", "0.0.0.0"))
    routes = ", ".join(f":{a} -> :{b}" for a, b in config.routes.items())
    print(f"guard listening ({routes}); origins: {sorted(config.origins)}; hosts: {sorted(config.hosts)}; "
          f"token: {'required' if config.token else 'not set'}", flush=True)
    try:
        import signal
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        signal.pause()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
