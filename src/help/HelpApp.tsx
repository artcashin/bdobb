import { useState } from "react";
import HelpNav from "./HelpNav";
import HelpContent from "./HelpContent";
import HelpSearch from "./HelpSearch";
import { loadNav } from "./loadContent";

export default function HelpApp() {
  const nav = loadNav();
  // "home" is the actual intro page (pinned as its own nav entry by
  // convert.mjs), and is always the right default landing page -- unlike
  // the previous "first category's first page" default, which happened to
  // land on a deep config page. convert.mjs only pins Home when home.md
  // exists in the source snapshot, so fall back to the first available page
  // for a version folder that has none, rather than defaulting to a slug
  // that would throw in loadPage and blank the whole window.
  const [activeSlug, setActiveSlug] = useState<string | null>(
    nav.Home?.[0]?.slug ?? Object.values(nav)[0]?.[0]?.slug ?? null,
  );

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
