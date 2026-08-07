use serde::Serialize;

#[derive(Serialize)]
pub struct FrameCheck {
    /// False only when the site actively forbids being framed.
    frameable: bool,
    /// The header that forbade it, for the message shown on the card.
    reason: String,
}

/// Asks a site whether it permits being embedded in a frame.
///
/// This exists because the answer is undetectable from the webview. A frame
/// refused by X-Frame-Options fires `load` exactly like a successful
/// cross-origin frame, its document is null in both cases, and reading its
/// location throws SecurityError in both — verified against a blocked and an
/// allowed site, sandboxed and not. Without a preflight the card can only sit
/// blank and let the user guess.
///
/// Deliberately NOT routed through plugin-http, whose capability allowlist
/// covers configured backends and would refuse every arbitrary address the
/// Website widget exists to load. That is not a widening of what the app can
/// reach: the iframe is about to request this exact URL anyway under
/// `frame-src`, so the preflight touches nothing new.
async fn frame_check(url: String) -> Result<FrameCheck, String> {
    // Only the schemes the widget itself accepts. Anything else is refused
    // rather than handed to the HTTP client.
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme: {}", parsed.scheme()));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        // A site's framing policy can differ per redirect hop; the one that
        // matters is wherever the frame finally lands.
        .redirect(reqwest::redirect::Policy::limited(5))
        // Some sites serve a different policy to unknown agents, or refuse
        // outright. Present as a browser, since a browser is what will frame it.
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
             (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        )
        .build()
        .map_err(|e| e.to_string())?;

    // HEAD first: cheap, and enough for headers. Not every server implements it,
    // so a non-success falls back to GET rather than being read as a refusal.
    let mut res = client.head(parsed.clone()).send().await;
    if res.as_ref().map(|r| !r.status().is_success()).unwrap_or(true) {
        res = client.get(parsed).send().await;
    }
    let res = res.map_err(|e| e.to_string())?;
    let headers = res.headers();

    let get = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase()
    };

    let xfo = get("x-frame-options");
    // frame-ancestors supersedes X-Frame-Options where both are present, but
    // `framing_refusal` below checks X-Frame-Options first regardless --
    // behavior unchanged from before the extraction, just moved into a pure
    // function so it can be unit-tested without a network layer.
    let csp = get("content-security-policy");

    if let Some(reason) = framing_refusal(&xfo, &csp) {
        return Ok(FrameCheck {
            frameable: false,
            reason,
        });
    }

    Ok(FrameCheck {
        frameable: true,
        reason: String::new(),
    })
}

/// Pure verdict: does a site refuse to be framed, given its (already
/// lowercased) `X-Frame-Options` and `Content-Security-Policy` header
/// values? `Some(reason)` is a refusal, `None` is permitted. Empty strings
/// mean the header was absent.
///
/// Extracted out of `frame_check` (final review, Blocking 3) so the
/// string→verdict logic -- the part this branch actually changed, by
/// tokenizing `frame-ancestors` instead of substring-matching it -- has
/// automated coverage. Before this, `src-tauri/` had no `#[cfg(test)]`
/// anywhere and `cargo check` only proved the parser compiled, not that it
/// classified a single case correctly.
fn framing_refusal(xfo: &str, csp: &str) -> Option<String> {
    if xfo.contains("deny") {
        return Some("X-Frame-Options: DENY".into());
    }
    // SAMEORIGIN permits only the site framing itself, which this app never is.
    if xfo.contains("sameorigin") {
        return Some("X-Frame-Options: SAMEORIGIN".into());
    }

    if let Some(idx) = csp.find("frame-ancestors") {
        let directive = csp[idx..].split(';').next().unwrap_or_default();
        // Only the CSP wildcard and bare-scheme source forms are actually
        // permissive. A substring test misreads a host allow-list like
        // `frame-ancestors 'self' https://*.symphony.com` as permissive because
        // it *contains* "https:" — tokenize on whitespace instead and require
        // an exact token match, so `'none'`, `'self'`, and host lists are
        // correctly read as refusals.
        let permissive = directive
            .split_whitespace()
            .any(|tok| tok == "*" || tok == "https:" || tok == "http:");
        if !permissive {
            return Some(format!("Content-Security-Policy {}", directive.trim()));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::framing_refusal;

    #[test]
    fn host_allow_list_is_a_refusal_not_a_substring_match() {
        // The exact case the fix turned around: a naive substring test on
        // "https:" would misread this as permissive.
        let reason = framing_refusal("", "frame-ancestors 'self' https://*.symphony.com");
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors 'self' https://*.symphony.com".into())
        );
    }

    #[test]
    fn wildcard_source_is_permitted() {
        assert_eq!(framing_refusal("", "frame-ancestors *"), None);
    }

    #[test]
    fn bare_https_scheme_source_is_permitted() {
        assert_eq!(framing_refusal("", "frame-ancestors https:"), None);
    }

    #[test]
    fn none_source_is_a_refusal() {
        let reason = framing_refusal("", "frame-ancestors 'none'");
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors 'none'".into())
        );
    }

    #[test]
    fn empty_source_list_is_a_refusal() {
        let reason = framing_refusal("", "frame-ancestors");
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors".into())
        );
    }

    #[test]
    fn x_frame_options_deny_is_a_refusal_with_its_own_reason() {
        assert_eq!(
            framing_refusal("deny", ""),
            Some("X-Frame-Options: DENY".into())
        );
    }

    #[test]
    fn x_frame_options_sameorigin_is_a_refusal_with_its_own_reason() {
        assert_eq!(
            framing_refusal("sameorigin", ""),
            Some("X-Frame-Options: SAMEORIGIN".into())
        );
    }

    #[test]
    fn no_relevant_headers_is_permitted() {
        assert_eq!(framing_refusal("", ""), None);
    }
}

/// The Website built-in's preflight. See `frame_check` above.
#[tauri::command]
async fn check_frameable(url: String) -> Result<FrameCheck, String> {
    frame_check(url).await
}

/// Symphony's preflight, ahead of framing a pod's embed URL. Same headers,
/// same undetectable-from-the-webview problem as the Website built-in (see
/// `frame_check`) — a separate command rather than reusing `check_frameable`
/// so the two call sites can evolve independently even though today they
/// share every line of logic.
#[tauri::command]
async fn check_frame_options(url: String) -> Result<FrameCheck, String> {
    frame_check(url).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![check_frameable, check_frame_options])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
