import { useState } from "react";
import HelpNav from "./HelpNav";
import HelpContent from "./HelpContent";
import HelpSearch from "./HelpSearch";
import { loadNav } from "./loadContent";

function firstSlug(nav: ReturnType<typeof loadNav>): string | null {
  const firstCategory = Object.values(nav)[0];
  return firstCategory?.[0]?.slug ?? null;
}

export default function HelpApp() {
  const nav = loadNav();
  const [activeSlug, setActiveSlug] = useState<string | null>(firstSlug(nav));

  return (
    <div className="help-app">
      <aside className="help-sidebar">
        <HelpSearch onSelect={setActiveSlug} />
        <HelpNav nav={nav} activeSlug={activeSlug} onSelect={setActiveSlug} />
      </aside>
      <main className="help-main">
        {activeSlug ? (
          <HelpContent slug={activeSlug} onNavigate={setActiveSlug} />
        ) : (
          <p>No help content available for this version.</p>
        )}
      </main>
    </div>
  );
}
