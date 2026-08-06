import { useState } from "react";
import { useRegistryStore } from "../stores/registryStore";
import { useProviderKeysStore } from "../stores/providerKeysStore";
import type { WidgetDef } from "../lib/types";
import type { ProviderKeyStatus } from "../lib/providerKeys";

// The badge's only visible text is the provider name; keyed/unkeyed/unknown
// is conveyed by background color alone (green/red/neutral). That reaches
// neither a screen-reader user (hears just the name) nor a color-vision-
// deficient user (green vs red read as similar lightness). This phrase is
// used as both `title` (sighted hover) and `aria-label` (screen reader) so
// both audiences get the same explanation, in plain language rather than
// the raw "keyed"/"unkeyed" token.
function providerStatusLabel(providerName: string, status: ProviderKeyStatus): string {
  switch (status) {
    case "keyed":
      return `${providerName}: API key configured, this widget should return data.`;
    case "unkeyed":
      return `${providerName}: no API key configured, this widget will fail.`;
    case "unknown":
      return `${providerName}: key status unknown.`;
  }
}

interface WidgetLibraryProps {
  onSelectWidget: (widget: WidgetDef) => void;
  onClose?: () => void;
  widgets?: WidgetDef[];
}

export function WidgetLibrary({ onSelectWidget, onClose, widgets: propsWidgets }: WidgetLibraryProps) {
  const { widgets: storeWidgets } = useRegistryStore();
  const widgets = propsWidgets || storeWidgets;
  const statusFor = useProviderKeysStore((s) => s.statusFor);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");

  const categories = ["All", ...Array.from(new Set(widgets.map((w) => w.category)))];

  const filteredWidgets = widgets.filter((widget) => {
    // Trimmed and matched against name/description/category/subCategory, not
    // just name+description — a search for a category like "Yield Curve"
    // (subCategory) or "IMF" (category) found nothing before, even though
    // both are shown right on the card.
    const q = searchTerm.trim().toLowerCase();
    const haystack = `${widget.name} ${widget.description} ${widget.category} ${
      widget.subCategory ?? ""
    }`.toLowerCase();
    const matchesSearch = q === "" || haystack.includes(q);
    const matchesCategory =
      selectedCategory === "All" || widget.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="widget-library">
      <div className="widget-library-header">
        <div className="widget-library-header-inner">
          <h2 className="widget-library-title">Widget Library</h2>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close modal"
              className="widget-library-close"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="widget-library-close-icon"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>

        <div className="widget-library-search-container">
          <input
            type="text"
            autoFocus
            aria-label="Search widgets"
            placeholder="Search widgets..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="widget-library-search"
          />
        </div>

        <div className="widget-library-categories">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`widget-library-category-btn ${selectedCategory === category ? "widget-library-category-btn-active" : ""}`}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      <div className="widget-library-list">
        {filteredWidgets.length === 0 ? (
          <div className="widget-library-empty">
            <p className="widget-library-empty-text">No widgets found</p>
          </div>
        ) : (
          <div className="widget-library-grid">
            {filteredWidgets.map((widget) => (
              // A real button, not a div with onClick: the entry was
              // unreachable by keyboard and announced as a plain group, so the
              // library could only be used with a mouse.
              <button
                // backendId:id, not just id — two backends can legitimately
                // expose a widget with the same id, and a bare `widget.id`
                // key collided them into one React node (desk hardening).
                key={`${widget.backendId}:${widget.id}`}
                type="button"
                onClick={() => onSelectWidget(widget)}
                className="widget-library-widget"
              >
                <div className="widget-library-widget-header">
                  <div>
                    <span className="widget-library-widget-title">{widget.name}</span>
                    <div className="widget-library-widget-category-row">
                      <span className="widget-library-widget-category">{widget.category}</span>
                      {widget.subCategory && (
                        <>
                          <span className="widget-library-widget-separator">/</span>
                          <span className="widget-library-widget-category">{widget.subCategory}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="widget-library-widget-badges">
                    <span className="widget-library-widget-type">{widget.type}</span>
                    {widget.source.length > 0 && (() => {
                      const provider = widget.source[0];
                      const status = statusFor(provider);
                      const label = providerStatusLabel(provider, status);
                      return (
                        <span
                          className={`widget-library-widget-provider ${status}`}
                          title={label}
                          aria-label={label}
                        >
                          {provider}
                        </span>
                      );
                    })()}
                  </div>
                </div>
                <p className="widget-library-widget-desc">{widget.description}</p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default WidgetLibrary;
