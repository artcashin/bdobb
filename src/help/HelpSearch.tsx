import { useMemo, useState } from "react";
import { loadSearchIndex } from "./loadContent";

interface HelpSearchProps {
  onSelect: (slug: string) => void;
}

export default function HelpSearch({ onSelect }: HelpSearchProps) {
  const index = useMemo(() => loadSearchIndex(), []);
  const [query, setQuery] = useState("");

  const results = query.trim() ? index.search(query) : [];

  return (
    <div className="help-search">
      <input
        role="searchbox"
        type="search"
        placeholder="Search help…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="help-search-results">
          {results.map((r) => (
            <li key={r.id}>
              <button onClick={() => onSelect(r.slug)}>{r.title}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
