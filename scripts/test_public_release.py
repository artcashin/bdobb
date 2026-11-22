import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("public-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PublicReleaseTests(unittest.TestCase):
    def test_rejects_minified_defaults_without_echoing_values(self):
        for key in release.DEFAULTS:
            payload = f'var e={{{key}:`https://internal.example.invalid`}}'.encode()
            with self.assertRaisesRegex(release.GateError, key):
                release.check_bytes(payload, "frontend.js")

    def test_rejects_private_tailnet_dns_in_binary_and_utf16(self):
        host = "internal." + "tail" + "0123abcd" + ".ts.net"
        for encoding in ("utf-8", "utf-16le", "utf-16be"):
            with self.assertRaisesRegex(release.GateError, "Tailnet hostname"):
                release.check_bytes(host.encode(encoding), "payload")

    def test_allows_empty_defaults_and_documentation_hosts(self):
        release.check_bytes(b'const e={VITE_RITA_URL:``,VITE_OPENBB_API_URL:"",VITE_MCP_SERVERS:\'\'};', "app.js")
        release.check_bytes(b"https://api.your-tailnet.ts.net", "help.md")

    def test_stager_enforces_every_target_bundle_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            asset = d / "app.deb"
            asset.touch()
            with self.assertRaisesRegex(release.GateError, "Expected"):
                release.select_assets([asset], "Linux")


if __name__ == "__main__":
    unittest.main()
