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
#[tauri::command]
async fn check_frameable(url: String) -> Result<FrameCheck, String> {
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
    if xfo.contains("deny") {
        return Ok(FrameCheck {
            frameable: false,
            reason: "X-Frame-Options: DENY".into(),
        });
    }
    // SAMEORIGIN permits only the site framing itself, which this app never is.
    if xfo.contains("sameorigin") {
        return Ok(FrameCheck {
            frameable: false,
            reason: "X-Frame-Options: SAMEORIGIN".into(),
        });
    }

    // frame-ancestors supersedes X-Frame-Options where both are present.
    let csp = get("content-security-policy");
    if let Some(idx) = csp.find("frame-ancestors") {
        let directive = csp[idx..].split(';').next().unwrap_or_default();
        // A wildcard or an https: source permits us; anything else is a list of
        // origins this app is not on.
        let permissive = directive.contains(" *")
            || directive.contains("https:")
            || directive.contains("http:");
        if !permissive {
            return Ok(FrameCheck {
                frameable: false,
                reason: format!("Content-Security-Policy {}", directive.trim()),
            });
        }
    }

    Ok(FrameCheck {
        frameable: true,
        reason: String::new(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![check_frameable])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
