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
  // land on a deep config page.
  const [activeSlug, setActiveSlug] = useState<string | null>("home");

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
