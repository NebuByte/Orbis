//! The news ticker (off by default): headlines from the RSS or Atom feeds you choose, fetched only
//! while the ticker is on (every 15 minutes, from the UI). A click on a headline opens it in your
//! browser. Nothing else goes online.

use serde::Serialize;
use std::time::Duration;

#[derive(Serialize)]
pub struct Headline {
    pub title: String,
    pub link: String,
    pub source: String,
}

fn agent() -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).user_agent("Orbis news ticker").try_proxy_from_env(true);
    if let Ok(tls) = native_tls::TlsConnector::new() {
        b = b.tls_connector(std::sync::Arc::new(tls)); // Windows' own TLS and certificate store
    }
    b.build()
}

/// the text inside the first <name ...>...</name> of a block (or the tag itself when self-closing)
fn inner<'a>(block: &'a str, name: &str) -> Option<&'a str> {
    let (open, close) = (format!("<{name}"), format!("</{name}>"));
    let mut from = 0;
    loop {
        let i = block[from..].find(&open)? + from;
        let next = block[i + open.len()..].chars().next()?;
        if next == '>' || next == '/' || next.is_whitespace() {
            let gt = block[i..].find('>')? + i;
            if block[..gt].ends_with('/') {
                return Some(&block[i..=gt]);
            }
            let end = block[gt + 1..].find(&close)? + gt + 1;
            return Some(&block[gt + 1..end]);
        }
        from = i + 1;
    }
}
fn attr(tag: &str, name: &str) -> Option<String> {
    let k = tag.find(&format!("{name}="))? + name.len() + 1;
    let q = tag[k..].chars().next()?;
    let rest = &tag[k + 1..];
    Some(rest[..rest.find(q)?].to_string())
}
/// plain text: no CDATA wrapper, no tags, entities decoded, spaces tidied
fn clean(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("<![CDATA[").and_then(|t| t.strip_suffix("]]>")).unwrap_or(s);
    let mut text = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        rest = &rest[p..];
        let ent = rest[1..].find(';').filter(|&e| e <= 8).map(|e| &rest[1..=e]);
        let ch = ent.and_then(|e| match e {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            _ if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        });
        match (ch, ent) {
            (Some(c), Some(e)) => {
                out.push(c);
                rest = &rest[e.len() + 2..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// one feed: its name and its newest headlines (RSS <item> or Atom <entry>)
fn read_feed(url: &str) -> Option<(String, Vec<(String, String)>)> {
    let xml = agent().get(url).call().ok()?.into_string().ok()?;
    let mark = if xml.contains("<item") { "<item" } else { "<entry" };
    let head = &xml[..xml.find(mark).unwrap_or(xml.len())];
    let host = url.split("://").nth(1).and_then(|r| r.split('/').next()).unwrap_or(url).trim_start_matches("www.").to_string();
    let source = inner(head, "title").map(clean).filter(|t| !t.is_empty() && t.len() <= 40).unwrap_or(host);
    let mut items = Vec::new();
    let mut at = 0;
    while let Some(i) = xml[at..].find(mark).map(|i| i + at) {
        let end = xml[i..].find(if mark == "<item" { "</item>" } else { "</entry>" }).map(|e| i + e).unwrap_or(xml.len());
        let block = &xml[i..end];
        let title = inner(block, "title").map(clean).unwrap_or_default();
        let link = match inner(block, "link") {
            Some(l) if l.starts_with("<link") => attr(l, "href"), // Atom: <link href="..."/>
            Some(l) => Some(clean(l)),
            None => None,
        }
        .unwrap_or_default();
        if !title.is_empty() && link.starts_with("http") {
            items.push((title, link));
        }
        if items.len() >= 15 {
            break;
        }
        at = end.max(i + 1);
    }
    Some((source, items))
}

/// The newest headlines from your feeds, taking turns between feeds.
#[tauri::command]
pub async fn news(feeds: Vec<String>) -> Result<Vec<Headline>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let read: Vec<(String, Vec<(String, String)>)> = feeds.iter().take(8).filter(|f| f.starts_with("http")).filter_map(|f| read_feed(f)).collect();
        if read.is_empty() {
            return Err("No news feed answered.".to_string());
        }
        let mut out = Vec::new();
        for k in 0..15 {
            for (source, items) in &read {
                if let Some((title, link)) = items.get(k) {
                    out.push(Headline { title: title.clone(), link: link.clone(), source: source.clone() });
                }
            }
        }
        out.truncate(40);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Is this a feed Orbis can read? Returns its name.
#[tauri::command]
pub async fn check_feed(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = url.trim().to_string();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("A feed address starts with https://".to_string());
        }
        match read_feed(&url) {
            Some((name, items)) if !items.is_empty() => Ok(name),
            _ => Err("No headlines found at that address. Is it an RSS or Atom feed?".to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(hwnd: isize, op: *const u16, file: *const u16, params: *const u16, dir: *const u16, show: i32) -> isize;
}
/// Open a headline in the default browser (web addresses only).
#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(|c| c.is_control()) {
        return Err("Only web addresses can be opened.".into());
    }
    let w = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let r = unsafe { ShellExecuteW(0, w("open").as_ptr(), w(&url).as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
    if r > 32 {
        Ok(())
    } else {
        Err("Windows could not open the browser.".into())
    }
}
