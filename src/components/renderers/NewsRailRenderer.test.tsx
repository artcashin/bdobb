import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

const logError = vi.fn();
vi.mock("../../lib/logger", () => ({
  logError: (...a: unknown[]) => logError(...a),
}));

// The renderer defaults fetchImpl to the plugin; tests always inject their own.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(() => {
    throw new Error("test must pass fetchImpl");
  }),
}));

import NewsRailRenderer, { type NewsArticle } from "./NewsRailRenderer";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.onclose?.({ code: 1000 });
  }

  serverOpen() {
    this.onopen?.();
  }

  serverMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  serverClose(code: number) {
    this.onclose?.({ code });
  }
}

function article(over: Partial<NewsArticle> & { id: number }): NewsArticle {
  return {
    feed_id: 1,
    title: `headline ${over.id}`,
    link: "https://news.example/story",
    source: "Wire",
    published_at: "2026-08-04T12:00:00",
    sort_at: `2026-08-04T12:00:${String(over.id).padStart(2, "0")}`,
    highlighted: false,
    ...over,
  };
}

const SEED = [
  article({ id: 2, title: "Second headline", source: "Bloomberg Markets" }),
  article({ id: 1, title: "First headline", highlighted: true }),
];

interface FeedFixture {
  id: number;
  favicon: string | null;
}

function okFetch(articles: NewsArticle[] = SEED, feeds: FeedFixture[] = []) {
  return vi.fn(async (url: string | URL) => {
    const body = String(url).includes("/api/feeds")
      ? { feeds }
      : { articles, next_cursor: null };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function renderRail(over: Partial<Parameters<typeof NewsRailRenderer>[0]> = {}) {
  return render(
    <NewsRailRenderer
      url="https://openbb.example.ts.net:8088"
      user="art"
      token=""
      theme="dark"
      fetchImpl={okFetch()}
      {...over}
    />
  );
}

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

describe("NewsRailRenderer", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    openUrl.mockClear();
    logError.mockClear();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("seeds from /api/news and renders time, source, and highlight", async () => {
    const fetchImpl = okFetch();
    renderRail({ fetchImpl });
    expect(await screen.findByText("Second headline")).toBeInTheDocument();
    expect(screen.getByText("First headline")).toBeInTheDocument();
    expect(screen.getByText("Bloomberg Markets")).toBeInTheDocument();
    const rows = document.querySelectorAll(".news-row");
    // Newest (higher sort_at) first.
    expect(rows[0].textContent).toContain("Second headline");
    expect(rows[1].className).toContain("highlighted");
    const calledUrl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://openbb.example.ts.net:8088/api/news?user=art&limit=100");
  });

  it("sends the token as an Authorization header, never in the REST URL", async () => {
    const fetchImpl = okFetch();
    renderRail({ fetchImpl, token: "tkn-0123456789abcdef0123456789abcdef" });
    await screen.findByText("Second headline");
    const [calledUrl, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string, RequestInit,
    ];
    expect(calledUrl).not.toContain("token");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tkn-0123456789abcdef0123456789abcdef"
    );
  });

  it("dials ws(s)://.../ws/news — token in the query only in token mode", async () => {
    renderRail();
    await screen.findByText("Second headline");
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(lastSocket().url).toBe(
      "wss://openbb.example.ts.net:8088/ws/news?user=art"
    );
  });

  it("prepends live frames and dedupes by id", async () => {
    renderRail();
    await screen.findByText("Second headline");
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    act(() => {
      lastSocket().serverOpen();
      lastSocket().serverMessage(article({ id: 3, title: "Breaking now" }));
      lastSocket().serverMessage(article({ id: 3, title: "Breaking now" })); // dupe
    });
    const rows = document.querySelectorAll(".news-row");
    expect(rows[0].textContent).toContain("Breaking now");
    expect(screen.getAllByText("Breaking now")).toHaveLength(1);
  });

  it("treats a 401 seed as terminal — no socket, no retry", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    renderRail({ fetchImpl });
    expect(await screen.findByText(/Not authorized/)).toBeInTheDocument();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("treats websocket close 4401 as terminal, other closes as reconnect", async () => {
    vi.useFakeTimers();
    const fetchImpl = okFetch();
    renderRail({ fetchImpl });
    await act(async () => {}); // flush the seed promise
    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => lastSocket().serverClose(1006));
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    await act(async () => {}); // flush the re-seed
    expect(MockWebSocket.instances).toHaveLength(2); // re-dialed
    act(() => lastSocket().serverClose(4401));
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(MockWebSocket.instances).toHaveLength(2); // terminal — no third dial
    expect(screen.getByText(/Not authorized/)).toBeInTheDocument();
  });

  it("opens a headline on double-click via the opener plugin, http(s) only", async () => {
    renderRail({
      fetchImpl: okFetch([
        article({ id: 5, title: "Real story", link: "https://news.example/a" }),
        article({ id: 6, title: "Hostile story", link: "javascript:alert(1)" }),
      ]),
    });
    fireEvent.dblClick(await screen.findByText("Real story"));
    expect(openUrl).toHaveBeenCalledWith("https://news.example/a");
    openUrl.mockClear();
    fireEvent.dblClick(screen.getByText("Hostile story"));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("asks for a URL rather than fetching when unconfigured", () => {
    const fetchImpl = okFetch();
    renderRail({ url: "", fetchImpl });
    expect(screen.getByText(/Set the ticker URL/)).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  describe("favicons", () => {
    it("fetches /api/feeds once on mount with the same auth header as the seed call", async () => {
      const fetchImpl = okFetch(SEED, [{ id: 1, favicon: "data:image/x-icon;base64,AAA" }]);
      renderRail({ fetchImpl, token: "tkn-0123456789abcdef0123456789abcdef" });
      await screen.findByText("Second headline");

      const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const feedsCall = calls.find(([u]) => String(u).includes("/api/feeds"));
      expect(feedsCall).toBeDefined();
      const [calledUrl, init] = feedsCall as [string, RequestInit];
      expect(calledUrl).toBe("https://openbb.example.ts.net:8088/api/feeds?user=art");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer tkn-0123456789abcdef0123456789abcdef"
      );
      // Called exactly once, matching the seed call's own single-call shape.
      expect(calls.filter(([u]) => String(u).includes("/api/feeds"))).toHaveLength(1);
    });

    it("renders the favicon next to the source for a feed that has one", async () => {
      const fetchImpl = okFetch(SEED, [{ id: 1, favicon: "data:image/x-icon;base64,AAA" }]);
      renderRail({ fetchImpl });
      await screen.findByText("Second headline");
      // SEED's second article (id 1, "First headline") has feed_id: 1 (the
      // article() factory's default) and should get the icon.
      const row = screen.getByText("First headline").closest(".news-row")!;
      const img = row.querySelector(".news-favicon") as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.src).toBe("data:image/x-icon;base64,AAA");
      expect(img!.alt).toBe("");
    });

    it("renders no icon for a feed with a null favicon or an unlisted feed_id", async () => {
      const fetchImpl = okFetch(SEED, [{ id: 1, favicon: null }]); // feed_id 2 (SEED's other article) is absent entirely
      renderRail({ fetchImpl });
      await screen.findByText("Second headline");
      expect(document.querySelectorAll(".news-favicon")).toHaveLength(0);
    });

    it("stays fully functional when the feeds fetch fails, logging once and not throwing", async () => {
      const fetchImpl = vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/feeds")) throw new Error("network down");
        return new Response(JSON.stringify({ articles: SEED, next_cursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;
      renderRail({ fetchImpl });
      // Headlines still work.
      expect(await screen.findByText("Second headline")).toBeInTheDocument();
      expect(document.querySelectorAll(".news-favicon")).toHaveLength(0);
      await waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
      expect(logError.mock.calls[0][0]).toContain("favicon");
    });

    it("also logs once (and renders no icon) when the feeds endpoint returns a non-OK status", async () => {
      const fetchImpl = vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/feeds")) {
          return new Response("", { status: 500 });
        }
        return new Response(JSON.stringify({ articles: SEED, next_cursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;
      renderRail({ fetchImpl });
      expect(await screen.findByText("Second headline")).toBeInTheDocument();
      expect(document.querySelectorAll(".news-favicon")).toHaveLength(0);
      await waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
      expect(logError.mock.calls[0][0]).toContain("500");
    });
  });
});
