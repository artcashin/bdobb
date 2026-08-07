import { useEffect, useMemo, useState } from "react";
import AnalogFace from "./AnalogFace";

interface ClockRendererProps {
  /** IANA zone names, in display order. */
  zones: string[];
  /** 12-hour, suffixed with a bare A or P, instead of 24-hour. */
  hour12?: boolean;
  /** "dots" for the matrix face, "solid" for the filled one. */
  face?: "dots" | "solid";
  /** "vertical" for the digital list (default), "horizontal" for analog tiles. */
  layout?: "vertical" | "horizontal";
}

/**
 * Compact zone identifiers for the second meta line.
 *
 * Intl offers "Eastern Time" (longGeneric) or "EDT" (short), neither of which
 * is the "US/Eastern" form asked for. That form is the legacy IANA alias, and
 * aliases only exist for some zones, so this covers the ones where the alias
 * is genuinely more readable than the modern name. Everything else falls back
 * to the IANA name itself, which is always correct and already the right shape.
 */
const ZONE_ALIASES: Record<string, string> = {
  "America/New_York": "US/Eastern",
  "America/Chicago": "US/Central",
  "America/Denver": "US/Mountain",
  "America/Los_Angeles": "US/Pacific",
  "America/Anchorage": "US/Alaska",
  "Pacific/Honolulu": "US/Hawaii",
  "Asia/Tokyo": "Japan",
  "Asia/Shanghai": "PRC",
  "Asia/Hong_Kong": "Hongkong",
  "Asia/Singapore": "Singapore",
  "Asia/Kolkata": "India",
  "Europe/London": "GB",
  "Pacific/Auckland": "NZ",
};

/** "Asia/Hong_Kong" -> "Hong Kong". */
function cityOf(zone: string): string {
  const last = zone.split("/").pop() ?? zone;
  return last.replace(/_/g, " ");
}

function zoneLabelOf(zone: string): string {
  return ZONE_ALIASES[zone] ?? zone;
}

/**
 * Usable zones only. An unknown or misspelt IANA name makes DateTimeFormat
 * throw a RangeError, and the field is free text, so a typo is the expected
 * case rather than an exotic one — during render that would escape the card's
 * error boundary.
 */
function usable(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function part(now: Date, zone: string, name: Intl.DateTimeFormatOptions["timeZoneName"]) {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: name })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? ""
  );
}

export default function ClockRenderer({
  zones,
  hour12 = false,
  face = "dots",
  layout = "vertical",
}: ClockRendererProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Aligned to the next second boundary, then every second. A plain 1000ms
    // interval started at mount leaves the display up to a second stale
    // relative to the second it names.
    let interval: ReturnType<typeof setInterval>;
    const align = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 1000);
    }, 1000 - (Date.now() % 1000));
    return () => {
      clearTimeout(align);
      clearInterval(interval);
    };
  }, []);

  const valid = useMemo(() => zones.filter(usable), [zones]);
  const invalid = useMemo(() => zones.filter((z) => !usable(z)), [zones]);

  const rows = useMemo(
    () =>
      valid.map((zone) => ({
        zone,
        city: cityOf(zone),
        label: zoneLabelOf(zone),
        // en-GB gives a zero-padded 24-hour clock. For 12-hour, formatToParts
        // lets the digits and the marker be kept apart, so the marker can be a
        // bare "A"/"P" rather than Intl's "AM"/"PM".
        ...(() => {
          const parts = new Intl.DateTimeFormat(hour12 ? "en-US" : "en-GB", {
            timeZone: zone,
            hour: "2-digit",
            minute: "2-digit",
            hour12,
          }).formatToParts(now);
          const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
          return {
            hh: get("hour"),
            mm: get("minute"),
            meridiem: hour12 ? get("dayPeriod").trim().charAt(0).toUpperCase() : "",
          };
        })(),
        // Intl gives "GMT-04:00"; the padded hour and the ":00" minutes are
        // dropped for the compact form. Half-hour zones such as India keep
        // their minutes, so the trim is conditional rather than a slice.
        offset: part(now, zone, "longOffset")
          .replace(/GMT([+-])0?(\d+):(\d+)/, (_m, sign, h, min) =>
            min === "00" ? `GMT${sign}${h}` : `GMT${sign}${h}:${min}`
          ),
      })),
    [valid, now, hour12]
  );

  if (rows.length === 0) {
    return <div className="renderer-empty">No valid time zones set for this card.</div>;
  }

  if (layout === "horizontal") {
    return (
      <div className="clock-gallery" aria-live="off">
        {rows.map((r) => {
          const hourNum = parseInt(r.hh, 10) % 12;
          const minuteNum = parseInt(r.mm, 10);
          return (
            <div
              className="clock-tile"
              key={r.zone}
              aria-label={`${r.city}, ${r.hh}:${r.mm}, ${r.label}, ${r.offset}`}
            >
              <AnalogFace hour={hourNum} minute={minuteNum} />
              <div className="clock-tile-caption">
                <span className="clock-tile-city">{r.city}</span>
                <span className="clock-tile-region">{r.label}</span>
                <span className="clock-tile-offset">{r.offset}</span>
              </div>
            </div>
          );
        })}
        {invalid.length > 0 && (
          <div className="clock-invalid">Unknown time zone: {invalid.join(", ")}</div>
        )}
      </div>
    );
  }

  return (
    // aria-live off: a list of clocks announcing itself every second would make
    // the card unusable with a screen reader.
    <div className="clock-list" aria-live="off">
      {rows.map((r) => (
        // City and time are double height and flank the meta column, which
        // stacks the offset over the zone at single height. Below a threshold
        // width the meta column drops to its own line — see the container
        // query in styles.css.
        <div className="clock-row" key={r.zone}>
          <span className="clock-city">{r.city}</span>
          <div className="clock-meta">
            <span className="clock-offset">{r.offset}</span>
            <span className="clock-zone">{r.label}</span>
          </div>
          {/* Split so the colon can be pulled in: the face is monospaced, so a
              full-width cell either side of ":" leaves a gap wide enough to
              read as a word break. */}
          <span className={`clock-time ${face === "solid" ? "solid" : ""}`}>
            {r.hh}
            <span className="clock-colon">:</span>
            {r.mm}
            {r.meridiem && <span className="clock-meridiem">{r.meridiem}</span>}
          </span>
        </div>
      ))}
      {invalid.length > 0 && (
        <div className="clock-invalid">Unknown time zone: {invalid.join(", ")}</div>
      )}
    </div>
  );
}
