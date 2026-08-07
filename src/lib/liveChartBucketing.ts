export interface Bar {
  /** Bucket start, epoch ms. */
  date: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** null means this symbol's ticks carry no volume data at all (forex). */
  volume: number | null;
}

export interface SeedBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface Tick {
  symbol: string;
  price?: unknown;
  last_size?: unknown;
}

export const BUCKET_MS: Record<string, number> = {
  "1s": 1_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

export function bucketStartMs(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

function toFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * /series (kdb-backed) emits offset-less ISO timestamps -- e.g.
 * "2026-08-07T18:03:00" -- that are already UTC (timezone-naive pandas
 * timestamps serialized via .isoformat()). `new Date()` parses an
 * offset-less date-*time* string as local time, which would disagree with
 * `applyTick`'s true-UTC `Date.now()` bucket math by the browser's UTC
 * offset. Appending "Z" when no zone is present forces UTC parsing, matching
 * the same pattern NewsRailRenderer.tsx uses for this exact backend shape.
 */
function parseUtc(stamp: string): number {
  return new Date(stamp.endsWith("Z") || stamp.includes("+") ? stamp : `${stamp}Z`).getTime();
}

export function seedToBar(seed: SeedBar): Bar {
  return {
    date: parseUtc(seed.date),
    open: seed.open,
    high: seed.high,
    low: seed.low,
    close: seed.close,
    volume: typeof seed.volume === "number" ? seed.volume : null,
  };
}

/**
 * Folds one live tick into a bar series. Returns a new array -- same length
 * with the last bar updated in place when the tick lands in the current
 * bucket, one longer when it starts a new bucket, or `bars` itself
 * (unchanged reference) when the tick is unusable or older than the current
 * bucket. The unchanged-reference case lets a caller skip a re-render for a
 * true no-op tick.
 */
export function applyTick(bars: Bar[], tick: Tick, bucketMs: number, nowMs: number): Bar[] {
  const price = toFiniteNumber(tick.price);
  if (price === null) return bars;

  const start = bucketStartMs(nowMs, bucketMs);
  const last = bars[bars.length - 1];
  const lastSize = toFiniteNumber(tick.last_size);

  if (last && start < last.date) return bars; // out-of-order / clock skew

  if (last && start === last.date) {
    const updated: Bar = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume: lastSize !== null ? (last.volume ?? 0) + lastSize : last.volume,
    };
    return [...bars.slice(0, -1), updated];
  }

  const fresh: Bar = {
    date: start,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: lastSize !== null ? lastSize : null,
  };
  return [...bars, fresh];
}

/** Whether any bar in the series carries real volume data -- false for a
 * forex symbol, whose ticks are bid/ask quotes with no last_size. The tick
 * recorder coerces a missing last_size to 0.0 rather than null, so a forex
 * seed bar's volume is a number (0), not null -- checking `> 0` as well as
 * non-null is what actually excludes forex, whose bars are all-zero. */
export function hasVolumeData(bars: Bar[]): boolean {
  return bars.some((b) => b.volume !== null && b.volume > 0);
}

/** Percent change from the series' first bar's open -- the shared basis a
 * multi-symbol overlay normalizes every symbol against, so a $150 and a
 * $60,000 symbol share one readable axis. */
export function normalizePercent(bars: Bar[]): { date: number; value: number }[] {
  if (bars.length === 0) return [];
  const base = bars[0].open;
  if (base === 0) return bars.map((b) => ({ date: b.date, value: 0 }));
  return bars.map((b) => ({ date: b.date, value: ((b.close - base) / base) * 100 }));
}
