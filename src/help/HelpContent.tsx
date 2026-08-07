import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { loadPage, loadAssetUrl } from "./loadContent";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// react-markdown v10 sanitizes link URLs by default (`defaultUrlTransform`),
// stripping any protocol it doesn't recognize -- including our internal
// `help://` scheme -- down to an empty href. Bundled help markdown is
// trusted, first-party content, so let `help://` links through unchanged
// while still sanitizing everything else the normal way.
const urlTransform: UrlTransform = (url) =>
  url.startsWith("help://") ? url : defaultUrlTransform(url);

interface HelpContentProps {
  slug: string;
  onNavigate: (slug: string) => void;
}

export default function HelpContent({ slug, onNavigate }: HelpContentProps) {
  const markdown = loadPage(slug);

  const HelpLink: Components["a"] = ({ href, children, ...rest }) => {
    if (href?.startsWith("help://")) {
      const targetSlug = href.slice("help://".length);
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(targetSlug);
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }
    const handleExternalClick = (): void => {
      if (!href || !isTauri()) return;
      import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(href))
        .catch(() => {});
    };
    return (
      <a
        href={href}
        onClick={(e) => {
          if (href && isTauri()) e.preventDefault();
          handleExternalClick();
        }}
        {...rest}
      >
        {children}
      </a>
    );
  };

  const HelpImage: Components["img"] = ({ src, alt, ...rest }) => {
    const filename = src?.split("/").pop();
    const resolvedSrc = filename ? loadAssetUrl(filename) : src;
    return <img src={resolvedSrc} alt={alt} {...rest} />;
  };

  return (
    <div className="help-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={{ a: HelpLink, img: HelpImage }}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
