use serde::Serialize;
use tauri::menu::{Menu, MenuItem, Submenu, HELP_SUBMENU_ID};
use tauri::Manager;

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
    //
    // `get_all`, not `get`: per spec, a response can carry more than one
    // Content-Security-Policy header, and all of them apply -- the effective
    // policy is their intersection. Reading only the first (what `get` -- and
    // this function, before this fix -- does) fails OPEN: a site sending
    // `frame-ancestors *` and `frame-ancestors 'none'` as two separate
    // headers would be reported frameable if only the first is ever seen.
    let csp: Vec<String> = headers
        .get_all("content-security-policy")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase())
        .collect();

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

/// Finds the `frame-ancestors` directive in one CSP header's value, if any,
/// matched at a directive boundary rather than anywhere in the string.
///
/// `csp.find("frame-ancestors")` (the prior implementation) matched the
/// token as a plain substring, which can occur inside another directive's
/// *value* -- a `report-uri` carrying a query string that happens to contain
/// the text "frame-ancestors" is the plausible shape -- producing a false
/// refusal for a site that never declared the directive at all. Splitting on
/// `;` into directives first and comparing the first whitespace token of
/// each one is what "directive boundary" means here: `frame-ancestors` must
/// be the directive's own name, not a substring of something else's value.
fn find_frame_ancestors_directive(csp: &str) -> Option<&str> {
    csp.split(';')
        .map(|d| d.trim())
        .find(|d| d.split_whitespace().next() == Some("frame-ancestors"))
}

/// Pure verdict: does a site refuse to be framed, given its (already
/// lowercased) `X-Frame-Options` value and every `Content-Security-Policy`
/// header value it sent? `Some(reason)` is a refusal, `None` is permitted.
/// An empty `xfo` means that header was absent; an empty `csp` slice means
/// no CSP header was sent at all.
///
/// Per spec, more than one CSP header can be present and all of them apply --
/// the effective policy is their intersection -- so a refusal in ANY one of
/// them is a refusal overall; a caller with only the first header's value
/// (failing open on a second, stricter one) is the bug this signature guards
/// against structurally rather than by convention.
///
/// Extracted out of `frame_check` (final review, Blocking 3) so the
/// string→verdict logic -- the part this branch actually changed, by
/// tokenizing `frame-ancestors` instead of substring-matching it -- has
/// automated coverage. Before this, `src-tauri/` had no `#[cfg(test)]`
/// anywhere and `cargo check` only proved the parser compiled, not that it
/// classified a single case correctly.
fn framing_refusal(xfo: &str, csp: &[String]) -> Option<String> {
    if xfo.contains("deny") {
        return Some("X-Frame-Options: DENY".into());
    }
    // SAMEORIGIN permits only the site framing itself, which this app never is.
    if xfo.contains("sameorigin") {
        return Some("X-Frame-Options: SAMEORIGIN".into());
    }

    for header in csp {
        if let Some(directive) = find_frame_ancestors_directive(header) {
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
                return Some(format!("Content-Security-Policy {}", directive));
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::framing_refusal;

    /// One-header-value convenience, for tests that don't care about the
    /// multiple-CSP-headers case.
    fn csp(s: &str) -> Vec<String> {
        vec![s.to_string()]
    }

    #[test]
    fn host_allow_list_is_a_refusal_not_a_substring_match() {
        // The exact case the fix turned around: a naive substring test on
        // "https:" would misread this as permissive.
        let reason = framing_refusal("", &csp("frame-ancestors 'self' https://*.symphony.com"));
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors 'self' https://*.symphony.com".into())
        );
    }

    #[test]
    fn wildcard_source_is_permitted() {
        assert_eq!(framing_refusal("", &csp("frame-ancestors *")), None);
    }

    #[test]
    fn bare_https_scheme_source_is_permitted() {
        assert_eq!(framing_refusal("", &csp("frame-ancestors https:")), None);
    }

    #[test]
    fn none_source_is_a_refusal() {
        let reason = framing_refusal("", &csp("frame-ancestors 'none'"));
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors 'none'".into())
        );
    }

    #[test]
    fn empty_source_list_is_a_refusal() {
        let reason = framing_refusal("", &csp("frame-ancestors"));
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors".into())
        );
    }

    #[test]
    fn x_frame_options_deny_is_a_refusal_with_its_own_reason() {
        assert_eq!(
            framing_refusal("deny", &[]),
            Some("X-Frame-Options: DENY".into())
        );
    }

    #[test]
    fn x_frame_options_sameorigin_is_a_refusal_with_its_own_reason() {
        assert_eq!(
            framing_refusal("sameorigin", &[]),
            Some("X-Frame-Options: SAMEORIGIN".into())
        );
    }

    #[test]
    fn no_relevant_headers_is_permitted() {
        assert_eq!(framing_refusal("", &[]), None);
    }

    // ---- Finding 13: multiple Content-Security-Policy headers must be
    // intersected, not just the first one read. ----

    #[test]
    fn a_refusal_in_a_second_csp_header_is_not_missed() {
        // Per spec, every CSP header sent applies. A naive `headers.get()`
        // (single value) reads only the first of these and would report this
        // site frameable -- failing open on the second, stricter header.
        let headers = vec!["frame-ancestors *".to_string(), "frame-ancestors 'none'".to_string()];
        let reason = framing_refusal("", &headers);
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors 'none'".into())
        );
    }

    #[test]
    fn a_refusal_in_the_first_csp_header_is_not_missed_either() {
        let headers = vec!["frame-ancestors 'none'".to_string(), "frame-ancestors *".to_string()];
        let reason = framing_refusal("", &headers);
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors 'none'".into())
        );
    }

    #[test]
    fn permissive_in_every_csp_header_is_permitted() {
        let headers = vec!["frame-ancestors *".to_string(), "frame-ancestors https:".to_string()];
        assert_eq!(framing_refusal("", &headers), None);
    }

    // ---- Finding 14: `frame-ancestors` must be matched as a directive name
    // at a directive boundary, not anywhere in the string. ----

    #[test]
    fn frame_ancestors_appearing_inside_another_directives_value_is_not_a_false_refusal() {
        // The plausible real-world shape: a report-uri carrying the literal
        // text "frame-ancestors" in its query string. An unanchored
        // `csp.find("frame-ancestors")` would match here and misread the
        // slice from that point onward as the frame-ancestors directive
        // itself.
        let reason = framing_refusal(
            "",
            &csp("report-uri /csp-report?ref=frame-ancestors-docs; default-src 'self'"),
        );
        assert_eq!(reason, None);
    }

    #[test]
    fn frame_ancestors_is_still_found_when_it_is_not_the_first_directive() {
        let reason = framing_refusal("", &csp("default-src 'self'; frame-ancestors 'none'"));
        assert_eq!(
            reason,
            Some("Content-Security-Policy frame-ancestors 'none'".into())
        );
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
        .setup(|app| {
            let help_item = MenuItem::with_id(app, "help_open", "BDOBB Help", true, None::<&str>)?;

            // Build on top of Tauri's auto-installed default menu (Quit, Edit,
            // Window, View/Fullscreen, Help, etc.) instead of replacing it —
            // `app.set_menu` with a from-scratch `Menu` would otherwise wipe
            // out all of those out of the box. `Menu::default()` already
            // includes a "Help" submenu (empty on macOS, identified by
            // `HELP_SUBMENU_ID`), so append our item into it rather than
            // creating a second, duplicate top-level "Help" menu.
            let menu = Menu::default(app.handle())?;
            if let Some(help_submenu) = menu
                .get(HELP_SUBMENU_ID)
                .and_then(|item| item.as_submenu().cloned())
            {
                help_submenu.append(&help_item)?;
            } else {
                let help_menu = Submenu::with_items(app, "Help", true, &[&help_item])?;
                menu.append(&help_menu)?;
            }
            app.set_menu(menu)?;

            // The "help" window is created on demand rather than declared
            // statically in tauri.conf.json. An earlier version kept a
            // hidden, permanently-alive "help" window (intercepting its
            // close event with `prevent_close` + `hide`) so a menu click
            // after the user closed it wouldn't just silently no-op. That
            // traded one bug for a worse one: Tauri only exits when its
            // window map becomes empty on `Destroyed`, so with a hidden
            // window that never dies, closing the main window no longer
            // quit the app at all. Building fresh whenever the window is
            // absent -- first click ever, or any click after the user
            // closed it -- fixes the original problem without that
            // regression, and lets the help window close/destroy normally.
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id() == "help_open" {
                    if let Some(window) = handle.get_webview_window("help") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        return;
                    }
                    match tauri::WebviewWindowBuilder::new(
                        &handle,
                        "help",
                        tauri::WebviewUrl::App("help.html".into()),
                    )
                    .title("BDOBB Help")
                    .inner_size(1000.0, 720.0)
                    .min_inner_size(640.0, 480.0)
                    .build()
                    {
                        Ok(window) => {
                            let _ = window.set_focus();
                        }
                        Err(err) => {
                            eprintln!("failed to create help window: {err}");
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
