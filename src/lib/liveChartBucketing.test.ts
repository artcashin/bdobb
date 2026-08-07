import { describe, expect, it } from "vitest";
import {
  applyTick, bucketStartMs, hasVolumeData, normalizePercent, seedToBar, BUCKET_MS,
  type Bar,
} from "./liveChartBucketing";

describe("bucketStartMs", () => {
  it("floors a timestamp to the bucket boundary", () => {
    expect(bucketStartMs(65_000, BUCKET_MS["1m"])).toBe(60_000);
    expect(bucketStartMs(119_999, BUCKET_MS["1m"])).toBe(60_000);
    expect(bucketStartMs(120_000, BUCKET_MS["1m"])).toBe(120_000);
  });
});

describe("seedToBar", () => {
  it("parses an ISO date string into an epoch-ms bar, as UTC", () => {
    const bar = seedToBar({
      date: "2026-08-07T13:59:00", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100,
    });
    expect(bar.date).toBe(Date.UTC(2026, 7, 7, 13, 59, 0));
    expect(bar).toMatchObject({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 });
  });

  it("treats a non-numeric volume as no volume data", () => {
    const bar = seedToBar({
      date: "2026-08-07T13:59:00", open: 1, high: 1, low: 1, close: 1, volume: null,
    });
    expect(bar.volume).toBeNull();
  });

  it("parses an offset-less timestamp as UTC, not browser-local time", () => {
    // /series (kdb-backed) emits offset-less ISO strings that are already
    // UTC. If seedToBar let `new Date()` parse them as local time, this
    // would drift by the test runner's UTC offset.
    const bar = seedToBar({
      date: "2026-08-07T18:03:00", open: 1, high: 1, low: 1, close: 1, volume: null,
    });
    expect(bar.date).toBe(Date.UTC(2026, 7, 7, 18, 3, 0));
  });
});

describe("applyTick", () => {
  const bucketMs = BUCKET_MS["1m"];
  const seed: Bar[] = [{ date: 0, open: 100, high: 101, low: 99, close: 100, volume: 50 }];

  it("updates high/low/close/volume within the same bucket", () => {
    const t1 = applyTick(seed, { symbol: "AAPL", price: 102, last_size: 5 }, bucketMs, 30_000);
    expect(t1).toHaveLength(1);
    expect(t1[0]).toMatchObject({ high: 102, low: 99, close: 102, volume: 55 });

    const t2 = applyTick(t1, { symbol: "AAPL", price: 98, last_size: 3 }, bucketMs, 45_000);
    expect(t2[0]).toMatchObject({ high: 102, low: 98, close: 98, volume: 58 });
  });

  it("starts a new bar when the tick crosses a bucket boundary", () => {
    const next = applyTick(seed, { symbol: "AAPL", price: 103, last_size: 2 }, bucketMs, 65_000);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      date: 60_000, open: 103, high: 103, low: 103, close: 103, volume: 2,
    });
    expect(next[0]).toBe(seed[0]); // the prior bar is untouched
  });

  it("drops a tick older than the in-progress bucket", () => {
    const advanced = applyTick(seed, { symbol: "AAPL", price: 103 }, bucketMs, 65_000);
    const dropped = applyTick(advanced, { symbol: "AAPL", price: 999 }, bucketMs, 10_000);
    expect(dropped).toBe(advanced); // unchanged reference: a true no-op
  });

  it("ignores a tick with a missing or non-finite price", () => {
    expect(applyTick(seed, { symbol: "AAPL", price: undefined }, bucketMs, 30_000)).toBe(seed);
    expect(applyTick(seed, { symbol: "AAPL", price: NaN }, bucketMs, 30_000)).toBe(seed);
  });

  it("starts a bar with null volume for a tick with no last_size (forex)", () => {
    const next = applyTick([], { symbol: "EURUSD", price: 1.08 }, bucketMs, 0);
    expect(next[0].volume).toBeNull();
  });

  it("updates the seeded bar in place for a tick a few seconds later in the same UTC bucket", () => {
    // Regression test for the seed/live time-base mismatch: /series emits
    // offset-less timestamps that seedToBar must parse as UTC (see the
    // seedToBar UTC test above). If seedToBar instead parsed them as
    // browser-local time, the seeded bar's `date` would be shifted by the
    // browser's UTC offset relative to `Date.now()`-derived tick timing, and
    // in any timezone behind UTC the tick's bucket start would land BEFORE
    // the (wrongly shifted-later) seeded bar -- tripping applyTick's
    // out-of-order guard and silently dropping every live tick forever.
    //
    // nowMs is built explicitly via Date.UTC, not by re-parsing seed.date
    // with `new Date()`, so this test doesn't repeat the bug it's meant to
    // catch.
    const seeded = seedToBar({
      date: "2026-08-07T18:03:00", open: 100, high: 101, low: 99, close: 100, volume: null,
    });
    const nowMs = Date.UTC(2026, 7, 7, 18, 3, 5); // 5s after the seed bar's bucket start
    const next = applyTick([seeded], { symbol: "AAPL", price: 102.5 }, bucketMs, nowMs);

    expect(next).toHaveLength(1); // updated in place, not dropped or appended
    expect(next[0].close).toBe(102.5);
    expect(next[0].date).toBe(seeded.date);
  });
});

describe("hasVolumeData", () => {
  it("is false when every bar has null volume", () => {
    expect(hasVolumeData([{ date: 0, open: 1, high: 1, low: 1, close: 1, volume: null }])).toBe(false);
  });
  it("is true when at least one bar has real volume", () => {
    expect(hasVolumeData([
      { date: 0, open: 1, high: 1, low: 1, close: 1, volume: null },
      { date: 1, open: 1, high: 1, low: 1, close: 1, volume: 10 },
    ])).toBe(true);
  });
  it("is false for all-zero (non-null) volume bars -- the forex seed shape", () => {
    // The tick recorder coerces a missing last_size (forex has none -- it's
    // bid/ask quotes) to 0.0 rather than null, so forex seed bars arrive with
    // volume: 0, a number. hasVolumeData must still treat this as "no volume
    // data" so the spec's forex-never-shows-volume rule holds for the seed
    // path, not just the live-tick path.
    expect(hasVolumeData([
      { date: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 },
      { date: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    ])).toBe(false);
  });
});

describe("normalizePercent", () => {
  it("computes percent change from the first bar's open", () => {
    const bars: Bar[] = [
      { date: 0, open: 100, high: 100, low: 100, close: 100, volume: null },
      { date: 1, open: 105, high: 105, low: 105, close: 110, volume: null },
    ];
    expect(normalizePercent(bars)).toEqual([
      { date: 0, value: 0 },
      { date: 1, value: 10 },
    ]);
  });

  it("does not divide by zero when the first bar's open is 0", () => {
    const bars: Bar[] = [{ date: 0, open: 0, high: 0, low: 0, close: 5, volume: null }];
    expect(normalizePercent(bars)).toEqual([{ date: 0, value: 0 }]);
  });

  it("returns an empty array for an empty series", () => {
    expect(normalizePercent([])).toEqual([]);
  });
});
