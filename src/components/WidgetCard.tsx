import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorBoundary from "./ErrorBoundary";
import type { CardView, DashboardCard, ParamGroup, ParamValues, WidgetDef } from "../lib/types";
import { effectiveParams, groupedParamNames, splitParamEdit } from "../lib/paramGroups";
import { useDashboardStore } from "../stores/dashboardStore";
import ParamControls from "./ParamControls";
import { useRegistryStore } from "../stores/registryStore";
import { useBackendsStore } from "../stores/backendsStore";
import { fetchWidgetData, fetchWidgetHtml } from "../lib/dataClient";
import { buildFigureFromRecords, canToggleChart } from "../lib/chartShapes";
import { logError } from "../lib/logger";
import {
  CLOCK_ZONES_PARAM, CLOCK_TZ_PARAM, CLOCK_HOUR12_PARAM, CLOCK_DEFAULT_ZONES,
  CLOCK_CYCLE_PARAM, CLOCK_FACE_PARAM, CLOCK_LAYOUT_PARAM,
  NOTE_TEXT_PARAM, WEBSITE_URL_PARAM,
  NEWS_URL_PARAM, NEWS_USER_PARAM, NEWS_TOKEN_PARAM,
  SYMPHONY_POD_URL_PARAM, SYMPHONY_STREAM_ID_PARAM, SYMPHONY_MODE_PARAM, SYMPHONY_THEME_PARAM,
  BUILTIN_CLOCK_ID, BUILTIN_NEWS_ID, BUILTIN_NOTE_ID, BUILTIN_WEBSITE_ID, BUILTIN_SYMPHONY_ID,
  findBuiltin, isBuiltinBackend,
} from "../lib/builtins";
import NewsRailRenderer from "./renderers/NewsRailRenderer";
import ClockRenderer from "./renderers/ClockRenderer";
import NoteRenderer from "./renderers/NoteRenderer";
import ChartRenderer from "./renderers/ChartRenderer";
import HtmlRenderer from "./renderers/HtmlRenderer";
import IframeRenderer from "./renderers/IframeRenderer";
import MarkdownRenderer from "./renderers/MarkdownRenderer";
import TableRenderer from "./renderers/TableRenderer";
import KeysRenderer from "./renderers/KeysRenderer";
import LiveGridRenderer from "./renderers/LiveGridRenderer";
import MetricRenderer from "./renderers/MetricRenderer";
import RawJsonView from "./renderers/RawJsonView";
import UnsupportedRenderer from "./renderers/UnsupportedRenderer";
import SymphonyRenderer from "./renderers/SymphonyRenderer";

export interface WidgetCardProps {
  card: DashboardCard;
}

/**
 * Stable empty array for the groups selector. Returning a fresh `[]` from a
 * zustand selector makes every read look like a change under Object.is, which
 * re-renders forever.
 */
const NO_GROUPS: ParamGroup[] = [];

export default function WidgetCard({ card }: WidgetCardProps) {
  const removeCard = useDashboardStore((s) => s.removeCard);
  const updateCardView = useDashboardStore((s) => s.updateCardView);
  const updateCardParams = useDashboardStore((s) => s.updateCardParams);
  const setGroupValue = useDashboardStore((s) => s.setGroupValue);
  const groups = useDashboardStore(
    (s) => s.dashboards.find((d) => d.id === s.activeId)?.groups ?? NO_GROUPS
  );
  const registryWidget = useRegistryStore((s) => s.find(card.backendId, card.widgetId));
  // Built-ins have no backend and are not in the registry; resolving them here
  // keeps the rest of the card — layout, params, groups, views — unchanged.
  const builtin = isBuiltinBackend(card.backendId);
  const widget = builtin ? findBuiltin(card.widgetId) : registryWidget;
  // Resolve the card's own backend so its baseUrl and auth headers are used.
  const backend = useBackendsStore((s) => s.backends.find((b) => b.id === card.backendId));
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  // Edited locally and applied on demand: committing on every keystroke would
  // refetch per character.
  const [draftParams, setDraftParams] = useState<ParamValues>(card.params);

  // A grouped parameter comes from the shared group value, not from the card.
  const fetchParams = useMemo(
    () => effectiveParams(widget, card, groups),
    [widget, card, groups]
  );

  // Which controls are shared, so ParamControls can say so and applyParams
  // knows where each edit belongs.
  const sharedParams = useMemo(
    () => groupedParamNames(widget, card, groups),
    [widget, card, groups]
  );


  // Re-sync when the card's stored params change from elsewhere (a reload, or
  // another edit), but not while the user is mid-edit.
  useEffect(() => {
    if (!paramsOpen) setDraftParams(fetchParams);
  }, [fetchParams, paramsOpen]);


  /**
   * Identifies the newest request. Widget fetches are not cancellable and
   * complete out of order — editing params, or clicking Refresh twice, leaves
   * two in flight, and the slower earlier one used to land last and overwrite
   * the fresher payload. A card would then display data for parameters the
   * controls no longer showed. The counter also covers unmount, since the
   * effect's cleanup bumps it.
   */
  const requestSeq = useRef(0);

  /**
   * Aborts the in-flight network request when a newer one supersedes it or
   * the card unmounts (desk's fetch hardening; Task 6 threaded the signal
   * through dataClient). The seq guard above is still required alongside it:
   * abort is not instantaneous, so a superseded request can still settle and
   * must not own the UI state.
   */
  const abortRef = useRef<AbortController | null>(null);

  const loadWidgetData = useCallback(async () => {
    if (!widget) return;
    // A note is text the user typed and a clock is the system time; there is
    // nothing to request, and no backend to request it from.
    if (builtin) return;
    if (!backend) {
      setError(`Backend "${card.backendId}" is not configured.`);
      return;
    }
    // iframe widgets load their endpoint directly in the frame; there is no
    // JSON payload to fetch, and requesting one would fail against an app URL.
    if (widget.type === "iframe") return;

    const seq = ++requestSeq.current;
    // Cancel the superseded request at the network layer too, not just in
    // state: its seq no longer matches, so nothing it could deliver is usable.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const values = fetchParams;
      const opts = { raw: card.view === "raw" as const, theme: "dark" as const };
      // html/markdown endpoints return text, not JSON — fetchWidgetData would
      // throw in res.json(). Unless the raw view is selected, in which case the
      // endpoint serves its JSON form.
      const wantsText =
        (widget.type === "html" || widget.type === "markdown") && card.view !== "raw";
      const result = wantsText
        ? await fetchWidgetHtml(backend, widget, values, undefined, controller.signal)
        : await fetchWidgetData(backend, widget, values, opts, undefined, controller.signal);
      if (seq !== requestSeq.current) return;
      setData(result);
    } catch (e) {
      // A superseded request's failure is not this card's error to show: the
      // newer request is still running and owns the outcome. This also
      // swallows the AbortError our own cancellation above provokes.
      if (seq !== requestSeq.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      logError(`widget ${widget.id} fetch failed: ${msg}`);
      setError(msg);
    } finally {
      // Only the newest request may clear the spinner; an older one finishing
      // would otherwise report the card as loaded while a fetch is still open.
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [widget, builtin, backend, card.backendId, fetchParams, card.view]);

  useEffect(() => {
    loadWidgetData();
    return () => {
      requestSeq.current++;
      // Unmount (or a dependency change about to refetch): stop the open
      // request instead of letting it run to completion for nobody.
      abortRef.current?.abort();
    };
  }, [loadWidgetData]);

  const handleRefresh = useCallback(() => {
    loadWidgetData();
  }, [loadWidgetData]);

  const applyParams = useCallback(() => {
    // Grouped values belong to the dashboard, not the card. Writing them onto
    // the card would persist a value the group immediately masks, so the
    // control would snap back and the edit would look lost.
    const { cardParams, groupUpdates } = splitParamEdit(widget, card, groups, draftParams);

    updateCardParams(card.uuid, cardParams).catch((e) =>
      logError(`updateCardParams failed: ${String(e)}`)
    );
    for (const u of groupUpdates) {
      setGroupValue(u.id, u.value).catch((e) =>
        logError(`setGroupValue failed: ${String(e)}`)
      );
    }
    setParamsOpen(false);
  }, [updateCardParams, setGroupValue, card, widget, groups, draftParams]);

  const handleViewToggle = useCallback((newView: CardView) => {
    updateCardView(card.uuid, newView).catch((e) =>
      logError(`updateCardView failed: ${String(e)}`)
    );
  }, [updateCardView, card.uuid]);

  const renderContent = () => {
    if (loading) return <div className="loading">Loading...</div>;
    if (error) return <div className="error">{error}</div>;
    if (!widget) return null;

    const theme: "dark" = "dark";
    const widgetDef = widget as WidgetDef;

    if (card.widgetId === BUILTIN_NOTE_ID) {
      return (
        <NoteRenderer
          text={String(card.params[NOTE_TEXT_PARAM] ?? "")}
          onChange={(text) =>
            updateCardParams(card.uuid, { ...card.params, [NOTE_TEXT_PARAM]: text }).catch((e) =>
              logError(`note save failed: ${String(e)}`)
            )
          }
        />
      );
    }
    if (card.widgetId === BUILTIN_WEBSITE_ID) {
      return (
        <IframeRenderer
          data={null}
          widgetDef={widgetDef}
          theme={theme}
          src={String(fetchParams[WEBSITE_URL_PARAM] ?? "")}
          emptyHint="Set a URL in this card's parameters to embed a page."
        />
      );
    }
    if (card.widgetId === BUILTIN_NEWS_ID) {
      return (
        <NewsRailRenderer
          url={String(fetchParams[NEWS_URL_PARAM] ?? "")}
          user={String(fetchParams[NEWS_USER_PARAM] ?? "")}
          token={String(fetchParams[NEWS_TOKEN_PARAM] ?? "")}
          theme={theme}
        />
      );
    }
    if (card.widgetId === BUILTIN_CLOCK_ID) {
      // `timezone` is the pre-list param. Reading it as a fallback keeps a card
      // created before the widget became a list showing the zone it was set to.
      const raw =
        String(fetchParams[CLOCK_ZONES_PARAM] ?? "") ||
        String(fetchParams[CLOCK_TZ_PARAM] ?? "") ||
        CLOCK_DEFAULT_ZONES;
      // hourCycle replaced a boolean `hour12`; the old value is still read so a
      // card saved on 12-hour does not silently flip back to 24.
      const cycle = String(fetchParams[CLOCK_CYCLE_PARAM] ?? "");
      const hour12 = cycle ? cycle === "12" : fetchParams[CLOCK_HOUR12_PARAM] === true;
      return (
        <ClockRenderer
          zones={raw.split(",").map((z) => z.trim()).filter(Boolean)}
          hour12={hour12}
          face={fetchParams[CLOCK_FACE_PARAM] === "solid" ? "solid" : "dots"}
          layout={fetchParams[CLOCK_LAYOUT_PARAM] === "horizontal" ? "horizontal" : "vertical"}
        />
      );
    }
    if (card.widgetId === BUILTIN_SYMPHONY_ID) {
      return (
        <SymphonyRenderer
          data={null}
          widgetDef={widgetDef}
          theme={theme}
          params={{
            pod: String(fetchParams[SYMPHONY_POD_URL_PARAM] ?? ""),
            id: String(fetchParams[SYMPHONY_STREAM_ID_PARAM] ?? ""),
            // Not a per-card param: Symphony issues one partner ID per licensed
            // app, so it belongs in the (not yet built) Symphony settings tab,
            // not the widget's own params. Empty until that lands.
            partnerId: "",
            mode: String(fetchParams[SYMPHONY_MODE_PARAM] ?? ""),
            theme: String(fetchParams[SYMPHONY_THEME_PARAM] ?? ""),
          }}
        />
      );
    }

    // An iframe widget loads its endpoint in the frame, so it has no fetched
    // payload and must not be gated on one.
    if (widget.type === "iframe") {
      return <IframeRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }

    if (data === null) return <div className="renderer-empty">No data loaded</div>;

    // The view the user selected wins over the widget's declared type — that
    // is the whole point of the toggle. renderContent previously dispatched on
    // type alone, so switching to "chart" changed nothing on screen.
    if (card.view === "chart") {
      return <ChartRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }
    // The raw view fetches with raw=true and shows the JSON directly. It
    // previously fell through to the type renderer, which showed it only via
    // that renderer's shape-mismatch fallback.
    //
    // A keys widget's rows carry credential values at tier 3; the raw view
    // would dump them verbatim into the DOM. The server already declares
    // raw: false for this widget, but a card whose view was persisted as
    // "raw" before this widget existed (or hand-edited in storage) would
    // still reach this branch ahead of the type dispatch below, so the
    // server flag alone is not enough — the client needs its own guard.
    if (card.view === "raw" && widget.type !== "keys") {
      return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
    }
    if (card.view === "default" && widget.type === "chart") {
      return <ChartRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }
    if (widget.type === "html") {
      return <HtmlRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }
    if (widget.type === "markdown") {
      return <MarkdownRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }
    if (widget.type === "keys") {
      return <KeysRenderer data={data} widgetDef={widgetDef} theme={theme} backend={backend} />;
    }
    if (widget.type === "table") {
      return <TableRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }
    if (widget.type === "live_grid") {
      // The GET fetch above seeded `data`; the renderer opens the widget's
      // wsEndpoint itself and streams row updates into the grid.
      return (
        <LiveGridRenderer
          data={data}
          widgetDef={widgetDef}
          backend={backend}
          params={fetchParams}
          theme={theme}
        />
      );
    }
    if (widget.type === "metric") {
      return <MetricRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }
    if (widget.type === "pdf" || widget.type === "multi_file_viewer") {
      return <UnsupportedRenderer data={data} widgetDef={widgetDef} theme={theme} />;
    }
    return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
  };

  const viewLabel = (view: CardView) => {
    if (view === "default") return "Default";
    if (view === "raw") return "Raw";
    if (view === "chart") return "Chart";
    return "Default";
  };

  // Hidden params are sent but not user-editable, per the widgets.json protocol.
  const editableParams = (widget?.params ?? []).filter((p) => p.show);

  // Whether the rows in hand yield a figure. Built in a memo rather than
  // inline: this walks every row looking for a date column, and it ran on each
  // render — including renders that only opened the params panel or moved the
  // hover controls.
  const dataYieldsFigure = useMemo(
    () =>
      Array.isArray(data) &&
      buildFigureFromRecords(data as Record<string, unknown>[]) !== null,
    [data]
  );

  const availableViews: CardView[] = ["default"];
  // Never offer the raw view for a keys widget, even if the server flags it
  // raw-capable: the point of the guard above is defeated if the UI still
  // lets the user select the view it silently downgrades.
  if (widget?.raw && widget.type !== "keys") availableViews.push("raw");
  // Spec: a widget with a date/time column can toggle table <-> chart. Many
  // widgets.json entries omit columnsDefs, so also offer it when the rows in
  // hand actually yield a figure.
  const chartable =
    widget?.type === "chart" || (widget ? canToggleChart(widget) : false) || dataYieldsFigure;
  if (chartable) availableViews.push("chart");

  return (
    <div
      className="widget-card"
    >
      <div className="card-header">
        <span className="card-title">
          {widget?.name ?? card.widgetId}
        </span>
        <span className="card-actions">
          {/* A select offering one choice is noise, and a built-in has no
              alternate view to offer. */}
          {availableViews.length > 1 && (
            <select
              value={card.view}
              onChange={(e) => handleViewToggle(e.target.value as CardView)}
              title="View mode"
            >
              {availableViews.map((v) => (
                <option key={v} value={v}>
                  {viewLabel(v)}
                </option>
              ))}
            </select>
          )}
          {editableParams.length > 0 && (
            <button
              title="Parameters"
              aria-label="Edit parameters"
              aria-expanded={paramsOpen}
              onClick={() => setParamsOpen((v) => !v)}
            >
              ⚙
            </button>
          )}
          {!builtin && (
            <button
              title="Refresh"
              aria-label="Refresh widget"
              onClick={handleRefresh}
            >
              ↻
            </button>
          )}
          <button
            title="Remove widget"
            aria-label="Remove widget"
            onClick={() =>
              // .catch, not try/catch: the store action is async, so a sync
              // try around it could never observe the rejection.
              removeCard(card.uuid).catch((e) =>
                logError(`removeCard failed: ${String(e)}`)
              )
            }
          >
            <span aria-hidden="true">✕</span>
          </button>
        </span>
      </div>
      {paramsOpen && editableParams.length > 0 && (
        <div className="card-params">
          <ParamControls
            params={editableParams}
            values={draftParams}
            onChange={setDraftParams}
            sharedParams={sharedParams}
            widget={widget}
            backend={backend}
          />
          <div className="card-params-actions">
            <button
              onClick={() => {
                setDraftParams(fetchParams);
                setParamsOpen(false);
              }}
            >
              Cancel
            </button>
            <button onClick={applyParams}>Apply</button>
          </div>
        </div>
      )}
      <div className="card-body">
        {/* Contain a throwing renderer to this card. Without it one bad
            payload unmounts the entire app, including the rail and chat. */}
        <ErrorBoundary
          label={`Widget ${widget?.name ?? card.widgetId}`}
          resetKey={data}
          fallback={(err) => (
            <div className="renderer-error">
              <p>This widget failed to render.</p>
              <pre className="renderer-error-detail">{err.message}</pre>
              {/* A keys widget's fetched envelope carries tier-3 credential
                  values, and isKeysEnvelope only checks that `rows` is an
                  array, not the shape of each row -- a malformed row (e.g.
                  a null element) makes KeysRenderer throw while reading it,
                  landing here with the same unfiltered envelope the raw-view
                  guard above exists to keep out of the DOM. Falling through
                  to RawJsonView in that case would dump it verbatim, so this
                  is a second, independent guard rather than a rely-on-the-
                  renderer-not-throwing assumption. */}
              {data !== null && widget?.type !== "keys" && (
                <RawJsonView data={data} widgetDef={widget as WidgetDef} theme="dark" />
              )}
            </div>
          )}
        >
          {renderContent()}
        </ErrorBoundary>
      </div>
    </div>
  );
}
