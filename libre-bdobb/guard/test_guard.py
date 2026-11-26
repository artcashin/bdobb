"""Offline tests for the guard: python -m unittest discover -s guard"""
import http.client
import json
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import guard


class Upstream(BaseHTTPRequestHandler):
    """Stands in for Libre Terminal: echoes the headers it was sent."""
    def do_GET(self):
        body = json.dumps({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:6950")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class GuardTest(unittest.TestCase):
    token = ""

    def setUp(self):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        Thread(target=self.upstream.serve_forever, daemon=True).start()
        env = {"LIBRE_GUARD_HOSTS": "localhost,127.0.0.1,openbq.example.ts.net", "LIBRE_GUARD_TOKEN": self.token,
               "LIBRE_GUARD_DATA_PORT": "0", "TERMINAL_V5_PORT": str(self.upstream.server_port),
               "LIBRE_GUARD_VIEWS_PORT": "0", "TERMINAL_UI_PORT": str(self.upstream.server_port)}
        self.config = guard.Config(env)
        self.config.routes = {0: self.upstream.server_port}
        self.server = guard.serve(self.config, "127.0.0.1")[0]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        self.upstream.shutdown(); self.upstream.server_close()

    def get(self, headers=None, path="/widgets.json"):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        body = json.loads(response.read() or b"{}")
        connection.close()
        return response, body

    def test_desktop_origin_is_forwarded_as_a_local_client(self):
        response, body = self.get({"Origin": "tauri://localhost", "Host": "openbq.example.ts.net",
                                   "Sec-Fetch-Site": "cross-site", "Referer": "tauri://localhost/"})
        self.assertEqual(response.status, 200)
        sent = body["headers"]
        self.assertEqual(sent["host"], f"127.0.0.1:{self.upstream.server_port}")
        for stripped in ("origin", "referer", "sec-fetch-site"):
            self.assertNotIn(stripped, sent)
        self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))

    def test_windows_desktop_origin_and_no_origin_pass(self):
        self.assertEqual(self.get({"Origin": "http://tauri.localhost"})[0].status, 200)
        self.assertEqual(self.get()[0].status, 200)

    def test_other_origins_are_refused(self):
        for origin in ("https://evil.example", "http://localhost:1420", "null"):
            self.assertEqual(self.get({"Origin": origin})[0].status, 403, origin)

    def test_cross_site_request_without_origin_is_refused(self):
        self.assertEqual(self.get({"Sec-Fetch-Site": "cross-site"})[0].status, 403)

    def test_unknown_host_is_refused(self):
        self.assertEqual(self.get({"Host": "rebind.example:7900"})[0].status, 421)

    def test_path_and_query_are_forwarded_unchanged(self):
        path = "/api/v1/equity/fundamental/income?symbol=%5EGSPC&provider=yfinance"
        self.assertEqual(self.get(path=path)[1]["path"], path)

    def test_upstream_down_is_a_502(self):
        self.upstream.shutdown(); self.upstream.server_close()
        self.assertEqual(self.get()[0].status, 502)


class TokenTest(GuardTest):
    token = "s3cret-token"

    def test_token_is_required_and_not_forwarded(self):
        self.assertEqual(self.get()[0].status, 401)
        self.assertEqual(self.get({"X-Libre-Token": "wrong"})[0].status, 401)
        for headers in ({"X-Libre-Token": self.token}, {"Authorization": f"Bearer {self.token}"}):
            response, body = self.get(headers)
            self.assertEqual(response.status, 200)
            self.assertNotIn("x-libre-token", body["headers"])
            self.assertNotIn("authorization", body["headers"])

    # the open-access cases above do not apply once a token is set
    def test_desktop_origin_is_forwarded_as_a_local_client(self): pass
    def test_windows_desktop_origin_and_no_origin_pass(self): pass
    def test_path_and_query_are_forwarded_unchanged(self): pass
    def test_upstream_down_is_a_502(self): pass


if __name__ == "__main__":
    unittest.main()
