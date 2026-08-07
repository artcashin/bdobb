import type { NavTree } from "./loadContent";

interface HelpNavProps {
  nav: NavTree;
  activeSlug: string | null;
  onSelect: (slug: string) => void;
}

export default function HelpNav({ nav, activeSlug, onSelect }: HelpNavProps) {
  return (
    <nav className="help-nav">
      {Object.entries(nav).map(([category, pages]) => (
        <div key={category} className="help-nav-category">
          <h3>{category}</h3>
          <ul>
            {pages.map((page) => (
              <li key={page.slug}>
                <button
                  className={page.slug === activeSlug ? "active" : ""}
                  onClick={() => onSelect(page.slug)}
                >
                  {page.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
