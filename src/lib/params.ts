import type { ParamOption, ParamValues, WidgetDef } from "./types";

/**
 * `$currentDate`, optionally with an offset: `$currentDate-1w`, `$currentDate+3d`.
 * Units are h(ours) d(ays) w(eeks) M(onths) y(ears) — case-sensitive, since
 * `m` would be ambiguous between minutes and months.
 */
const CURRENT_DATE = /^\$currentDate(?:([+-])(\d+)([hdwMy]))?$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local YYYY-MM-DD. Deliberately not toISOString, which converts to UTC and
 *  can land on the wrong day for anyone west of Greenwich. */
function localISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Resolves a `$currentDate` expression to a local date string.
 * Any other string is returned unchanged — most defaults are plain values.
 */
export function resolveDefaultValue(value: string, now: Date = new Date()): string {
  const m = CURRENT_DATE.exec(value.trim());
  if (!m) return value;

  const [, sign, amountRaw, unit] = m;
  const d = new Date(now.getTime());

  if (sign && amountRaw && unit) {
    const amount = Number(amountRaw) * (sign === "-" ? -1 : 1);
    switch (unit) {
      case "h": d.setHours(d.getHours() + amount); break;
      case "d": d.setDate(d.getDate() + amount); break;
      case "w": d.setDate(d.getDate() + amount * 7); break;
      // setMonth clamps: Jan 31 minus one month is Mar 3 in some engines
      // unless the day is pinned first. Clamp to the target month's length.
      case "M": {
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + amount);
        d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
        break;
      }
      case "y": {
        const day = d.getDate();
        d.setDate(1);
        d.setFullYear(d.getFullYear() + amount);
        d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
        break;
      }
    }
  }

  return localISODate(d);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * The starting values for a widget's parameters.
 *
 * Hidden params are included: `show: false` means "sent but not user-editable",
 * so omitting them would drop a required value from every request.
 */
export function initialParamValues(widget: WidgetDef, now: Date = new Date()): ParamValues {
  const out: ParamValues = {};
  for (const param of widget.params) {
    const value = param.value;
    out[param.paramName] = typeof value === "string" ? resolveDefaultValue(value, now) : value;
  }
  return out;
}

/**
 * Resolves a param's `optionsParams` (the query params sent to its
 * `optionsEndpoint`) against the card's current values. A `$name` value is a
 * reference to another param's current value; anything else is a literal.
 *
 * Unresolved refs map to `null` rather than being dropped, so a caller can
 * still see the key was requested (and, e.g., skip the fetch until it's set).
 */
export function resolveOptionsParams(
  optionsParams: Record<string, string> | null,
  values: ParamValues
): ParamValues {
  if (!optionsParams) return {};
  const out: ParamValues = {};
  for (const [key, v] of Object.entries(optionsParams)) {
    out[key] = v.startsWith("$") ? values[v.slice(1)] ?? null : v;
  }
  return out;
}

/**
 * Normalizes an `optionsEndpoint` response into `ParamOption[]`.
 * Accepts a bare array of scalars (label === value) or `{label, value}`
 * objects; anything else (wrong shape, not an array) yields `[]` rather than
 * throwing, since this reads live, un-typed backend data.
 */
export function normalizeOptions(json: unknown): ParamOption[] {
  if (!Array.isArray(json)) return [];
  const out: ParamOption[] = [];
  for (const item of json) {
    if (typeof item === "string" || typeof item === "number") {
      out.push({ label: String(item), value: item });
    } else if (item !== null && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (rec.value !== undefined || rec.label !== undefined) {
        out.push({
          label: String(rec.label ?? rec.value ?? ""),
          value: (rec.value ?? String(rec.label ?? "")) as ParamOption["value"],
        });
      }
    }
  }
  return out;
}
