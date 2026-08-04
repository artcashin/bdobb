import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BackendConfig, ParamDef, ParamOption, ParamValues, WidgetDef } from "../lib/types";
import { fetchJson, resolveEndpoint, serializeParams } from "../lib/dataClient";
import { logError } from "../lib/logger";
import { normalizeOptions, resolveOptionsParams } from "../lib/params";

interface ParamControlsProps {
  params: ParamDef[];
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  options?: Record<string, { label: string; value: string | number | boolean | string[] }[]>;
  /**
   * Parameter names supplied by a dashboard group. Marked in the UI because
   * editing one changes every card in the group, which is not something the
   * user should discover by watching other cards reload.
   */
  sharedParams?: Set<string>;
  /**
   * The widget and backend a param's `optionsEndpoint` is resolved against.
   * Both are optional and additive: a caller that omits them keeps the prior
   * behavior exactly (static `param.options`/`options` prop only, no live
   * fetch) -- see docs/MERGE-NOTES.md for which call sites pass them.
   */
  widget?: WidgetDef;
  backend?: BackendConfig;
}

const BLOCKED_PLACEHOLDER = "Select required parameter(s) first";
// Distinct wording from BLOCKED_PLACEHOLDER (desk Finding 7): a failed fetch
// and "waiting on a parent param" are different situations -- one means
// "wait", the other means "something's wrong, maybe retry" -- and must not
// read the same in the UI.
const ERROR_PLACEHOLDER = "Options failed to load";

function isUnset(v: ParamValues[string] | undefined): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Names of "$ref" dependencies in optionsParams whose current value is unset. */
function unresolvedDeps(
  optionsParams: Record<string, string> | null,
  values: ParamValues
): string[] {
  if (!optionsParams) return [];
  return Object.values(optionsParams)
    .filter((v) => v.startsWith("$"))
    .map((v) => v.slice(1))
    .filter((name) => isUnset(values[name]));
}

/**
 * A `<select>` backed by a param's `optionsEndpoint`, fetched and cached
 * per-render here (desk's EndpointSelect, adapted to qwen's whole-values
 * `onSelect` callback and row/label markup instead of desk's per-field
 * `onChange(name, value)`).
 */
function EndpointOptionsField({
  param, widget, backend, values, onSelect, sharedTag, labelClasses, baseClasses, inputId,
}: {
  param: ParamDef;
  widget: WidgetDef;
  backend: BackendConfig;
  values: ParamValues;
  onSelect: (paramName: string, value: string | number | boolean | string[]) => void;
  sharedTag: ReactNode;
  labelClasses: string;
  baseClasses: string;
  inputId: string;
}) {
  const paramName = param.paramName;
  const currentValue = values[paramName];
  const [fetchedOptions, setFetchedOptions] = useState<ParamOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  const resolved = resolveOptionsParams(param.optionsParams, values);
  const blocked = unresolvedDeps(param.optionsParams, values).length > 0;
  // Stable string key so the effect only re-fires when the RESOLVED
  // optionsParams actually change, not on every render.
  const depsKey = JSON.stringify(resolved);

  useEffect(() => {
    if (blocked) {
      // A parent param is still unset: don't fetch, and don't show stale
      // options (or a stale error) from a previous (differently-scoped) fetch.
      setFetchedOptions([]);
      setError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const url = resolveEndpoint(backend.baseUrl, param.optionsEndpoint!);
        for (const [k, v] of Object.entries(serializeParams(resolved))) {
          url.searchParams.set(k, v);
        }
        const json = await fetchJson(url.toString(), backend, undefined, controller.signal);
        if (!cancelled) {
          setFetchedOptions(normalizeOptions(json));
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          const message = `optionsEndpoint failed for ${widget.id}.${paramName}: ${String(e)}`;
          logError(message);
          // Clear stale options too: showing leftover choices from a prior
          // (differently-scoped) success alongside an error would suggest
          // they're still valid for the current dependency values.
          setFetchedOptions([]);
          setError(message);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // depsKey is a stable serialization of `resolved`; backend.baseUrl covers
    // the backend changing under the same widget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, depsKey, backend.baseUrl, param.optionsEndpoint, widget.id, paramName]);

  const disabled = blocked || error !== null;
  // NOT gated on `fetchedOptions.length > 0`: options start empty and
  // populate async, and gating on their presence flipped `multiple` (and the
  // `value` prop's array-vs-scalar shape) between the pre-fetch and
  // post-fetch render -- with an array `currentValue` (the normal shape for
  // a multiSelect param) that produced React's "value prop supplied to
  // <select> must be a scalar value if multiple is false" warning during the
  // loading window.
  const isMultiSelect = param.multiSelect;

  return (
    <div className="param-controls-row">
      <label htmlFor={inputId} className={labelClasses}>
        {param.label} {param.value === null ? "*" : ""}
        {sharedTag}
      </label>
      <select
        id={inputId}
        multiple={isMultiSelect}
        disabled={disabled}
        value={
          isMultiSelect && Array.isArray(currentValue)
            ? currentValue
            : ((currentValue as string | number) ?? "")
        }
        onChange={(e) => {
          const selected = Array.from(e.target.selectedOptions, (option) => option.value);
          onSelect(paramName, isMultiSelect ? selected : (selected?.[0] ?? ""));
        }}
        className={baseClasses}
        style={{ minHeight: "auto" }}
      >
        {/* Only for single-select: in a multi-select, this blank option is a
            real selectable list item, not a placeholder, and picking it
            injects "" into the values array -- serializeParams then joins it
            straight into the query string (e.g. "AAPL,"), corrupting the
            request. Single-select has no such risk: selecting "" just clears
            the (scalar) value, mirroring qwen's static-options branches. */}
        {!isMultiSelect && (
          <option value="">
            {blocked ? BLOCKED_PLACEHOLDER : error !== null ? ERROR_PLACEHOLDER : "—"}
          </option>
        )}
        {fetchedOptions.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      {error !== null && (
        <span className="param-controls-help" role="alert">
          ⚠ Failed to load options
        </span>
      )}
      {param.description && <span className="param-controls-help">{param.description}</span>}
    </div>
  );
}

const PARTIAL_NUMBER_RE = /^-?\d*\.?\d*$/;

function toNumberDisplay(v: ParamValues[string]): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const n = Number(v);
  return Number.isFinite(n) ? String(v) : "";
}

/**
 * Buffers the raw typed string locally so an intermediate value like "0." or
 * a lone "-" isn't wiped by the coerced-number value bouncing back through
 * `onChange` (desk Finding 6) -- with the qwen number input's plain
 * `Number(e.target.value)`, typing "-" alone produced `NaN`, which
 * `typeof NaN === "number"` then rendered as the literal text "NaN".
 */
function NumberField({
  paramName, value, onChange, className, placeholder,
}: {
  paramName: string;
  value: ParamValues[string];
  onChange: (paramName: string, value: string | number | boolean | string[] | null) => void;
  className: string;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState(() => toNumberDisplay(value));
  const prevValue = useRef(value);
  if (prevValue.current !== value) {
    prevValue.current = value;
    const display = toNumberDisplay(value);
    if (display !== raw) setRaw(display);
  }
  return (
    <input
      id={`param-${paramName}`}
      type="text"
      inputMode="decimal"
      value={raw}
      onChange={(e) => {
        const s = e.target.value;
        setRaw(s);
        if (s === "") {
          onChange(paramName, null);
          return;
        }
        if (!PARTIAL_NUMBER_RE.test(s)) return; // leave raw as typed, don't propagate garbage
        const n = Number(s);
        if (Number.isFinite(n)) onChange(paramName, n);
        // else: partial value like "-" or "." alone -- wait for more input.
      }}
      className={className}
      placeholder={placeholder}
    />
  );
}

export function ParamControls({
  params,
  values,
  onChange,
  options = {},
  sharedParams,
  widget,
  backend,
}: ParamControlsProps) {

  const handleParamChange = (
    paramName: string,
    value: string | number | boolean | string[] | null
  ) => {
    onChange({ ...values, [paramName]: value });
  };

  const renderParamInput = (param: ParamDef) => {
    if (!param.show) return null;

    const paramName = param.paramName;
    const currentValue = values[paramName];
    const explicitOptions = options[paramName];
    const paramOptions = explicitOptions || param.options || [];

    const baseClasses = "param-controls-input";
    const shared = sharedParams?.has(paramName) ?? false;
    const labelClasses = `param-controls-label${shared ? " shared" : ""}`;
    const inputId = (name: string) => `param-${name}`;

    // Real text rather than a CSS ::after marker, so the fact that an edit
    // will move several cards is announced, not just coloured.
    const sharedTag = shared ? (
      <span className="param-controls-shared" title="Shared across grouped cards">
        {" "}
        (shared)
      </span>
    ) : null;

    // Any param carrying optionsEndpoint gets a live-fetched dropdown
    // regardless of its declared type (desk Finding 10) -- e.g. a
    // `type: "text"` param can still reference an options endpoint in
    // widgets.json. An explicit `options[paramName]` override (pre-resolved
    // by the caller) always wins and skips the fetch. `widget`/`backend` are
    // optional so a caller that hasn't wired them keeps the old
    // static-options-only behavior instead of silently never rendering.
    if (!explicitOptions && param.optionsEndpoint && widget && backend) {
      return (
        <EndpointOptionsField
          key={paramName}
          param={param}
          widget={widget}
          backend={backend}
          values={values}
          onSelect={handleParamChange}
          sharedTag={sharedTag}
          labelClasses={labelClasses}
          baseClasses={baseClasses}
          inputId={inputId(paramName)}
        />
      );
    }

    // A text param carrying a fixed option list is a dropdown, not a free-text
    // box. widgets.json uses that shape — the reference backend's "year" param
    // is type "text" with options — and rendering it as an input made a
    // constrained choice look like something the user had to type exactly.
    if (
      paramOptions.length > 0 &&
      (param.type === "text" || param.type === "ticker" || param.type === "number")
    ) {
      return (
        <div key={paramName} className="param-controls-row">
          <label htmlFor={inputId(paramName)} className={labelClasses}>
            {param.label} {param.value === null ? "*" : ""}
            {sharedTag}
          </label>
          <select
            id={inputId(paramName)}
            value={(currentValue as string | number) ?? ""}
            onChange={(e) => handleParamChange(paramName, e.target.value)}
            className={baseClasses}
          >
            {paramOptions.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </select>
          {param.description && <span className="param-controls-help">{param.description}</span>}
        </div>
      );
    }

    switch (param.type) {
      case "text":
      case "date":
      case "ticker":
        return (
          <div key={paramName} className="param-controls-row">
            <label htmlFor={inputId(paramName)} className={labelClasses}>
              {param.label} {param.value === null ? "*" : ""}
              {sharedTag}
            </label>
            <input
              id={inputId(paramName)}
              type={param.type === "date" ? "date" : "text"}
              value={(currentValue as string) ?? ""}
              onChange={(e) => handleParamChange(paramName, e.target.value)}
              className={baseClasses}
              placeholder={param.description}
            />
            {param.description && <span className="param-controls-help">{param.description}</span>}
          </div>
        );

      case "number":
        return (
          <div key={paramName} className="param-controls-row">
            <label htmlFor={inputId(paramName)} className={labelClasses}>
              {param.label} {param.value === null ? "*" : ""}
              {sharedTag}
            </label>
            <NumberField
              paramName={paramName}
              value={currentValue}
              onChange={handleParamChange}
              className={baseClasses}
              placeholder={param.description}
            />
            {param.description && <span className="param-controls-help">{param.description}</span>}
          </div>
        );

      case "boolean":
        return (
          <div key={paramName} className="param-controls-row" style={{ display: "flex", alignItems: "center" }}>
            <input
              id={inputId(paramName)}
              type="checkbox"
              checked={currentValue === true}
              onChange={(e) => handleParamChange(paramName, e.target.checked)}
              className="param-controls-checkbox"
            />
            <label htmlFor={inputId(paramName)} className={labelClasses}>
              {param.label}
              {sharedTag}
              {param.description && <span className="param-controls-help">{param.description}</span>}
            </label>
          </div>
        );

      case "endpoint":
        const hasOptions = paramOptions.length > 0;
        const isMultiSelect = param.multiSelect && hasOptions;

        if (hasOptions) {
          return (
            <div key={paramName} className="param-controls-row">
              <label htmlFor={inputId(paramName)} className={labelClasses}>
                {param.label} {param.value === null ? "*" : ""}
                {sharedTag}
              </label>
              <select
                id={inputId(paramName)}
                multiple={isMultiSelect}
                value={isMultiSelect && Array.isArray(currentValue) ? currentValue : ((currentValue as string | number) ?? "")}
                onChange={(e) => {
                  const selected = Array.from(
                    e.target.selectedOptions,
                    (option) => option.value
                  );
                  handleParamChange(
                    paramName,
                    isMultiSelect ? selected : selected?.[0] ?? ""
                  );
                }}
                className={baseClasses}
                style={{ minHeight: "auto" }}
              >
                {paramOptions.map((opt) => (
                  <option key={String(opt.value)} value={String(opt.value)}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        return (
          <div key={paramName} className="param-controls-row">
            <label htmlFor={inputId(paramName)} className={labelClasses}>{param.label}</label>
            <input
              id={inputId(paramName)}
              type="text"
              value={(currentValue as string) ?? ""}
              onChange={(e) => handleParamChange(paramName, e.target.value)}
              className={baseClasses}
              placeholder={param.description}
            />
            {param.description && <span className="param-controls-help">{param.description}</span>}
          </div>
        );

      case "form":
      case "tabs":
        console.warn(`Param type "${param.type}" is unsupported in v1`);
        return null;

      default:
        return (
          <div key={paramName} className="param-controls-row">
            <label htmlFor={inputId(paramName)} className={labelClasses}>{param.label}</label>
            <input
              id={inputId(paramName)}
              type="text"
              value={(currentValue as string) ?? ""}
              onChange={(e) => handleParamChange(paramName, e.target.value)}
              className={baseClasses}
              placeholder={param.description}
            />
            {param.description && <span className="param-controls-help">{param.description}</span>}
          </div>
        );
    }
  };

  return (
    <div className="param-controls">
      <div className="param-controls-title">Parameters</div>
      <form onSubmit={(e) => e.preventDefault()}>{params.map(renderParamInput)}</form>
    </div>
  );
}

export default ParamControls;
