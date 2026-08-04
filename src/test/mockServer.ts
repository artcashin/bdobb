import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const widgetsJson = readFileSync(path.join(here, "fixtures/widgets.fixture.json"), "utf8");
const historicalJson = readFileSync(path.join(here, "fixtures/historical.fixture.json"), "utf8");

export interface MockBackend {
  url: string;
  requests: { url: string; headers: Record<string, string> }[];
  close(): Promise<void>;
}

export function startMockBackend(): Promise<MockBackend> {
  const requests: MockBackend["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)])
      ),
    });
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/widgets.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(widgetsJson);
    } else if (u.pathname === "/api/v1/equity/price/historical") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(historicalJson);
    } else if (u.pathname === "/api/v1/imf_utils/presentation_table") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>IMF</h1><script>document.title='ok'</script></body></html>");
    } else if (u.pathname === "/boom") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"detail":"kaboom"}');
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
