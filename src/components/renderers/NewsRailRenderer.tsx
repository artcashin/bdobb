import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { logError } from "../../lib/logger";
import { rethrowWithScopeHelp } from "../../lib/httpScope";

/**
 * News rail (v8, Ep. 8): live headlines from an rss-ticker backend, drawn
 * natively rather than framed.
 *
 * Protocol: GET {url}/api/news?user=&limit= seeds the list (token, when
 * present, travels as an Authorization header — never in this URL); then a
 * websocket to {url}/ws/news streams new articles as bare payload frames.
 * The websocket cannot carry headers, so in token mode (and only there, and
 * only on that URL) the token rides the query string — under tailscale_auth
 * both calls authenticate by the Serve-injected identity and no token exists
 * anywhere. A 401 (or websocket close 4401) is terminal: reconnecting against
 * a rejecting server is a self-inflicted denial of service, so the rail says
 * "unauthorized" and stops.
 */

const RETRY_MS = 3000;
const SEED_LIMIT = 100;
/** Rows kept in memory; the ticker's own scrollback serves deeper history. */
const MAX_ROWS = 300;

export interface NewsArticle {
  id: number;
  feed_id: number;
  title: string;
  link: string | null;
  source: string | null;
  published_at: string | null;
  sort_at: string | null;
  highlighted: boolean;
}

interface NewsRailRendererProps {
  url: string;
  user: string;
  token: string;
  theme: "dark";
  /** Test seam; defaults to the Tauri HTTP plugin (CORS-free, scoped). */
  fetchImpl?: typeof fetch;
}

function normalizeBase(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

function asArticle(x: unknown): NewsArticle | null {
  if (x === null || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "number" || typeof r.title !== "string") return null;
  return {
    id: r.id,
    feed_id: typeof r.feed_id === "number" ? r.feed_id : -1,
    title: r.title,
    link: typeof r.link === "string" ? r.link : null,
    source: typeof r.source === "string" ? r.source : null,
    published_at: typeof r.published_at === "string" ? r.published_at : null,
    sort_at: typeof r.sort_at === "string" ? r.sort_at : null,
    highlighted: r.highlighted === true,
  };
}

function rowTime(a: NewsArticle): string {
  const stamp = a.sort_at ?? a.published_at;
  if (!stamp) return "";
  const d = new Date(stamp.endsWith("Z") || stamp.includes("+") ? stamp : `${stamp}Z`);
  if (Number.isNaN(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Only http(s) links may open — feeds are remote input. */
function safeLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return u.protocol === "http:" || u.protocol === "https:" ? link : null;
  } catch {
    return null;
  }
}

type RailState = "live" | "connecting" | "unauthorized" | "error";

export default function NewsRailRenderer({
  url, user, token, theme, fetchImpl = tauriFetch,
}: NewsRailRendererProps) {
  const base = useMemo(() => normalizeBase(url), [url]);
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [state, setState] = useState<RailState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const articlesRef = useRef<NewsArticle[]>([]);

  const merge = useCallback((incoming: NewsArticle[], { prepend }: { prepend: boolean }) => {
    const have = new Set(articlesRef.current.map((a) => a.id));
    const fresh = incoming.filter((a) => !have.has(a.id));
    if (fresh.length === 0) return;
    const next = prepend
      ? [...fresh, ...articlesRef.current]
      : [...articlesRef.current, ...fresh];
    // Newest first by the server's own sort key; the seed arrives sorted and
    // live frames are newest by construction, so this is a cheap invariant
    // repair rather than the ordering mechanism.
    next.sort((a, b) => (b.sort_at ?? "").localeCompare(a.sort_at ?? "") || b.id - a.id);
    articlesRef.current = next.slice(0, MAX_ROWS);
    setArticles(articlesRef.current);
  }, []);

  const seed = useCallback(async (): Promise<boolean> => {
    if (!base || !user) return false;
    const target = `${base}/api/news?user=${encodeURIComponent(user)}&limit=${SEED_LIMIT}`;
    let res: Response;
    try {
      try {
        res = await fetchImpl(target, {
          method: "GET",
          headers: {
            Accept: "application/json",
            // Token mode: as a header, so it never appears in this URL (or in
            // any proxy's request-line log of it).
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      } catch (e) {
        rethrowWithScopeHelp(e, target);
      }
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
    if (res.status === 401) {
      setState("unauthorized");
      return false;
    }
    if (!res.ok) {
      setState("error");
      setError(`HTTP ${res.status} from the ticker`);
      return false;
    }
    const body: unknown = await res.json().catch(() => null);
    const list = Array.isArray((body as { articles?: unknown[] })?.articles)
      ? ((body as { articles: unknown[] }).articles)
      : [];
    merge(list.map(asArticle).filter((a): a is NewsArticle => a !== null), { prepend: false });
    setError(null);
    return true;
  }, [base, user, token, fetchImpl, merge]);

  const wsUrl = useMemo(() => {
    if (!base || !user) return null;
    const q = new URLSearchParams({ user });
    // The browser WebSocket API cannot set headers; the token query param is
    // the documented fallback for exactly this call. Blank under tailscale_auth.
    if (token) q.set("token", token);
    return `${base.replace(/^http/, "ws")}/ws/news?${q.toString()}`;
  }, [base, user, token]);

  useEffect(() => {
    articlesRef.current = [];
    setArticles([]);
    if (!base || !user) {
      setState("error");
      setError(base ? "Set the ticker user id." : "Set the ticker URL.");
      return;
    }
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let sock: WebSocket | null = null;

    const connect = async () => {
      if (disposed) return;
      setState("connecting");
      // Re-seeding on every (re)connect doubles as gap-fill: whatever arrived
      // while the socket was down is in the first page, merged by id.
      const ok = await seed();
      if (disposed || !ok || !wsUrl) return;
      try {
        sock = new WebSocket(wsUrl);
      } catch (e) {
        logError(`news rail: websocket open failed: ${String(e)}`);
        setState("error");
        return;
      }
      sock.onopen = () => setState("live");
      sock.onmessage = (ev: MessageEvent) => {
        let msg: unknown;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const a = asArticle(msg);
        if (a) merge([a], { prepend: true });
      };
      sock.onclose = (ev: CloseEvent) => {
        sock = null;
        if (disposed) return;
        if (ev.code === 4401) {
          // Terminal by contract: waiting cannot fix bad credentials.
          setState("unauthorized");
          return;
        }
        setState("connecting");
        retry = setTimeout(connect, RETRY_MS);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      sock?.close();
    };
  }, [base, user, wsUrl, seed, merge]);

  const openArticle = useCallback((a: NewsArticle) => {
    const link = safeLink(a.link);
    if (!link) return;
    openUrl(link).catch((e) => logError(`news rail: openUrl failed: ${String(e)}`));
  }, []);

  if (state === "unauthorized") {
    return (
      <div className={`news-rail ${theme}`}>
        <div className="renderer-empty">
          Not authorized by the ticker. Check the user id and token — or, under
          tailscale_auth, that this device is on the tailnet and untagged.
        </div>
      </div>
    );
  }

  return (
    <div className={`news-rail ${theme}`}>
      <div className="news-rail-status">
        <span
          className={`live-dot ${state === "live" ? "on" : "off"}`}
          title={state === "live" ? "Streaming" : "Reconnecting…"}
          aria-hidden="true"
        />
        <span className="news-rail-status-label">
          {state === "live" ? "live" : state === "error" ? "error" : "connecting…"}
        </span>
        {error && <span className="news-rail-error">{error}</span>}
      </div>
      {articles.length === 0 && !error ? (
        <div className="renderer-empty">No headlines yet.</div>
      ) : (
        <ul className="news-rail-list">
          {articles.map((a) => (
            <li
              key={a.id}
              className={`news-row${a.highlighted ? " highlighted" : ""}`}
              // Single click is deliberately a no-op (matching the ticker's
              // own widget): a rail full of single-click landmines makes
              // scrolling hazardous. Double-click or Enter opens.
              onDoubleClick={() => openArticle(a)}
              onKeyDown={(e) => {
                if (e.key === "Enter") openArticle(a);
              }}
              tabIndex={0}
            >
              <span className="news-time">{rowTime(a)}</span>
              <span className="news-source">{a.source ?? ""}</span>
              <span className="news-title">{a.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
