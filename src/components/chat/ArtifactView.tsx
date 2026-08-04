import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";
import ReactMarkdown from "react-markdown";
import type { ClientArtifact } from "../../lib/agent/types";

interface ArtifactViewProps {
  artifacts: unknown[];
}

function isArtifact(a: unknown): a is ClientArtifact {
  return (
    typeof a === "object" &&
    a !== null &&
    typeof (a as ClientArtifact).type === "string"
  );
}

/**
 * One Plotly chart, mounted into a React-owned node.
 *
 * The previous implementation appended containers to a shared div on every
 * effect run and never removed them, so a streaming turn stacked duplicate
 * charts without bound, and cleanup purged `lastChild` N times rather than each
 * node. One component per artifact hands lifecycle back to React.
 */
function ChartArtifact({ artifact }: { artifact: ClientArtifact }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // The wire shape puts the figure in `content` with layout hints in
    // `chart_params` — not a top-level {data, layout} pair as the old code
    // assumed.
    const content = artifact.content as unknown;
    const figure = Array.isArray(content)
      ? { data: content as unknown[], layout: {} as Record<string, unknown> }
      : typeof content === "object" && content !== null && "data" in content
        ? (content as { data: unknown[]; layout?: Record<string, unknown> })
        : null;
    if (!figure) return;

    Plotly.newPlot(
      node,
      figure.data as never,
      {
        ...(figure.layout ?? {}),
        ...(artifact.chart_params ?? {}),
        plot_bgcolor: "#1e1e1e",
        paper_bgcolor: "#1e1e1e",
        font: { color: "#e0e0e0" },
        margin: { l: 40, r: 16, t: 24, b: 32 },
      } as never,
      { responsive: true, displayModeBar: false }
    );

    return () => {
      Plotly.purge(node);
    };
  }, [artifact]);

  return <div ref={ref} className="artifact-chart" />;
}

/** Artifacts are unbounded; a large one would otherwise choke the pane. */
const MAX_ARTIFACT_ROWS = 50;

function TableArtifact({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return <div className="renderer-empty">Empty table</div>;
  const columns = Object.keys(rows[0]);
  const shown = rows.slice(0, MAX_ARTIFACT_ROWS);
  return (
    <div className="artifact-table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>
                  {typeof row[c] === "number"
                    ? (row[c] as number).toLocaleString("en-US")
                    : String(row[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <div className="artifact-row-note">
          Showing {shown.length} of {rows.length} rows
        </div>
      )}
    </div>
  );
}

export default function ArtifactView({ artifacts }: ArtifactViewProps) {
  const valid = artifacts.filter(isArtifact);
  if (valid.length === 0) return null;

  return (
    <div className="artifact-view">
      {valid.map((artifact, i) => (
        <div key={artifact.uuid || `${artifact.name}-${i}`} className="artifact">
          {artifact.name && <div className="artifact-title">{artifact.name}</div>}
          {artifact.description && (
            <div className="artifact-desc">{artifact.description}</div>
          )}

          {artifact.type === "chart" ? (
            <ChartArtifact artifact={artifact} />
          ) : artifact.type === "table" && Array.isArray(artifact.content) ? (
            <TableArtifact rows={artifact.content as Record<string, unknown>[]} />
          ) : artifact.type === "html" && typeof artifact.content === "string" ? (
            <iframe
              srcDoc={artifact.content}
              // Unlike the widget HTML renderer (server-generated HTML from
              // the user's OWN backend, where JS is deliberately kept on for
              // interactivity), this content is model-generated: display
              // content, not an app the user installed. No spec sanctioned an
              // LLM response executing arbitrary JS with no CSP, so
              // `allow-scripts` is intentionally withheld here (desk
              // ArtifactView, README-documented rationale). No
              // `allow-same-origin` either -- that would hand the frame the
              // parent app's origin.
              sandbox="allow-forms allow-popups"
              title={artifact.name || `artifact-${i}`}
              className="artifact-iframe"
            />
          ) : typeof artifact.content === "string" ? (
            <div className="artifact-text">
              <ReactMarkdown>{artifact.content}</ReactMarkdown>
            </div>
          ) : (
            // Never a blank artifact: show what arrived.
            <pre className="artifact-raw">{JSON.stringify(artifact.content, null, 2)}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
