//! The launcher: every app in the Start menu (desktop + Store apps), ranked by how much you
//! use them - Windows' own record (UserAssist) plus launches from Orbis. The list comes from
//! Get-StartApps and is cached, so Orbis starts with it instantly and refreshes it quietly in the
//! background; each app's icon is saved once as a PNG (icons.ps1) for the themed dock.

use crate::index::normalize;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::RwLock;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Start-menu entries that are not apps you'd launch
const JUNK: &[&str] = &["uninstall", "readme", "read me", "release notes", "documentation", "license", "website", "help", "manual", "what's new", "changelog"];
/// shown in the dock until Windows has a record of your habits
const DEFAULTS: &[&str] = &["file explorer", "microsoft edge", "google chrome", "firefox", "brave", "visual studio code", "terminal", "settings", "notepad", "calculator"];

#[derive(Serialize, Deserialize, Clone)]
pub struct App {
    pub name: String,
    pub id: String,
    #[serde(default)]
    pub uses: u32,
    /// pinned to the left list by you
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Default)]
pub struct Apps {
    list: RwLock<Vec<App>>,
    uses: RwLock<HashMap<String, u32>>,
    pins: RwLock<Vec<String>>,
}

fn dir() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into())).join("Orbis")
}
fn icon_dir() -> PathBuf {
    dir().join("icons")
}
/// one PNG per AppID, named by a hash of it (AppIDs hold path characters)
fn icon_file(id: &str) -> PathBuf {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    icon_dir().join(format!("{h:016x}.png"))
}
const ICON_SCRIPT: &str = include_str!("icons.ps1");

fn rot13(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' => (((c as u8 - b'a' + 13) % 26) + b'a') as char,
            'A'..='Z' => (((c as u8 - b'A' + 13) % 26) + b'A') as char,
            _ => c,
        })
        .collect()
}

/// How much you use each app according to Windows itself: Explorer's UserAssist record of every
/// app started from Start, the taskbar or a shortcut - launches and minutes in focus. Its names
/// are ROT13'd AppIDs, the same IDs Get-StartApps gives. Score = minutes in focus + 2 per launch.
fn windows_usage() -> HashMap<String, f64> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let mut m = HashMap::new();
    let hk = RegKey::predef(HKEY_CURRENT_USER);
    for g in ["{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}", "{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}"] {
        let Ok(k) = hk.open_subkey(format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{g}\Count")) else { continue };
        for (name, val) in k.enum_values().flatten() {
            let b = &val.bytes;
            if b.len() < 16 {
                continue;
            }
            let runs = u32::from_le_bytes([b[4], b[5], b[6], b[7]]) as f64;
            let focus_ms = u32::from_le_bytes([b[12], b[13], b[14], b[15]]) as f64;
            *m.entry(rot13(&name).to_lowercase()).or_insert(0.0) += focus_ms / 60_000.0 + runs * 2.0;
        }
    }
    m
}

impl Apps {
    pub fn load_cached(&self) {
        if let Ok(t) = std::fs::read_to_string(dir().join("apps.json")) {
            if let Ok(v) = serde_json::from_str::<Vec<App>>(&t) {
                *self.list.write().unwrap() = v;
            }
        }
        if let Ok(t) = std::fs::read_to_string(dir().join("usage.json")) {
            if let Ok(m) = serde_json::from_str::<HashMap<String, u32>>(&t) {
                *self.uses.write().unwrap() = m;
            }
        }
        if let Ok(t) = std::fs::read_to_string(dir().join("pins.json")) {
            if let Ok(v) = serde_json::from_str::<Vec<String>>(&t) {
                *self.pins.write().unwrap() = v;
            }
        }
    }

    /// Pin an app to the left list (or unpin it). Pins keep their order and outrank usage.
    pub fn pin(&self, id: &str, on: bool) {
        let mut p = self.pins.write().unwrap();
        p.retain(|x| x != id);
        if on {
            p.push(id.to_string());
        }
        let _ = std::fs::create_dir_all(dir());
        let _ = std::fs::write(dir().join("pins.json"), serde_json::to_string(&*p).unwrap_or_default());
    }

    /// Ask Windows for the Start-menu app list (takes ~1 s, so it runs off the UI thread).
    pub fn refresh(&self) {
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(out) = out else { return };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else { return };
        let items = match v {
            serde_json::Value::Array(a) => a,
            o => vec![o],
        };
        let mut list: Vec<App> = items
            .iter()
            .filter_map(|o| {
                let name = o.get("Name")?.as_str()?.trim().to_string();
                let id = o.get("AppID")?.as_str()?.to_string();
                let low = name.to_lowercase();
                if name.is_empty() || id.starts_with("http") || JUNK.iter().any(|j| low.contains(j)) {
                    return None;
                }
                Some(App { name, id, uses: 0, pinned: false })
            })
            .collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        list.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
        if list.is_empty() {
            return;
        }
        let _ = std::fs::create_dir_all(dir());
        let _ = std::fs::write(dir().join("apps.json"), serde_json::to_string(&list).unwrap_or_default());
        *self.list.write().unwrap() = list;
    }

    pub fn count(&self) -> usize {
        self.list.read().unwrap().len()
    }

    /// Every word must match the start of a word in the app's name (or appear inside it).
    pub fn search(&self, q: &str, limit: usize) -> Vec<App> {
        let qn = normalize(q);
        let toks: Vec<&str> = qn.split_whitespace().collect();
        if toks.is_empty() {
            return Vec::new();
        }
        let uses = self.uses.read().unwrap();
        let pins = self.pins.read().unwrap();
        let list = self.list.read().unwrap();
        let mut scored: Vec<(f32, &App)> = list
            .iter()
            .filter_map(|a| {
                let nm = normalize(&a.name);
                let words: Vec<&str> = nm.split_whitespace().collect();
                let mut s = 0.0f32;
                for t in &toks {
                    if nm.starts_with(t) {
                        s += 6.0;
                    } else if words.iter().any(|w| w.starts_with(t)) {
                        s += 4.0;
                    } else if nm.contains(t) {
                        s += 2.0;
                    } else {
                        return None;
                    }
                }
                s += (1.0 + *uses.get(&a.id).unwrap_or(&0) as f32).ln() * 2.0;
                Some((s, a))
            })
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(limit)
            .map(|(_, a)| App { uses: *uses.get(&a.id).unwrap_or(&0), pinned: pins.contains(&a.id), ..a.clone() })
            .collect()
    }

    /// The left list: your pinned apps, then the n you use most (Windows' record + launches from
    /// Orbis), topped up with sensible defaults. Orbis itself is left out.
    pub fn top(&self, n: usize) -> Vec<App> {
        let list = self.list.read().unwrap();
        let uses = self.uses.read().unwrap();
        let pins = self.pins.read().unwrap();
        let mut out: Vec<App> = pins.iter().filter_map(|id| list.iter().find(|a| &a.id == id)).map(|a| App { pinned: true, uses: *uses.get(&a.id).unwrap_or(&0), ..a.clone() }).collect();
        let n = n + out.len();
        let win = windows_usage();
        let mut scored: Vec<(f64, &App)> = list
            .iter()
            .filter(|a| !a.name.eq_ignore_ascii_case("orbis") && !pins.contains(&a.id))
            .map(|a| (*uses.get(&a.id).unwrap_or(&0) as f64 * 10.0 + win.get(&a.id.to_lowercase()).copied().unwrap_or(0.0), a))
            .filter(|(s, _)| *s > 0.0)
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let room = n - out.len();
        out.extend(scored.into_iter().take(room).map(|(_, a)| App { uses: *uses.get(&a.id).unwrap_or(&0), ..a.clone() }));
        for d in DEFAULTS {
            if out.len() >= n {
                break;
            }
            if let Some(a) = list.iter().find(|a| a.name.to_lowercase() == *d || a.name.to_lowercase().starts_with(&format!("{d} "))) {
                if !out.iter().any(|o| o.id == a.id) {
                    out.push(App { uses: 0, pinned: false, ..a.clone() });
                }
            }
        }
        out
    }

    /// Save an icon for every app that has none yet - one hidden PowerShell run for the batch.
    /// Apps without an icon get an empty file, so they are not asked again.
    pub fn fetch_icons(&self) {
        let missing: Vec<serde_json::Value> = self
            .list
            .read()
            .unwrap()
            .iter()
            .filter(|a| !icon_file(&a.id).exists())
            .map(|a| serde_json::json!({ "id": a.id, "file": icon_file(&a.id) }))
            .collect();
        if missing.is_empty() || std::fs::create_dir_all(icon_dir()).is_err() {
            return;
        }
        let (script, job) = (dir().join("icons.ps1"), dir().join("icons-job.json"));
        if std::fs::write(&script, ICON_SCRIPT).is_err() || std::fs::write(&job, serde_json::to_string(&missing).unwrap_or_default()).is_err() {
            return;
        }
        let _ = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .arg("-Job")
            .arg(&job)
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    /// Icons as data URLs for the given AppIDs (only those that have one).
    pub fn icons(&self, ids: &[String]) -> HashMap<String, String> {
        use base64::Engine;
        ids.iter()
            .filter_map(|id| {
                let b = std::fs::read(icon_file(id)).ok().filter(|b| !b.is_empty())?;
                Some((id.clone(), format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))))
            })
            .collect()
    }

    /// Launch through the shell's app folder - works for desktop and Store apps alike.
    pub fn launch(&self, id: &str) -> Result<(), String> {
        Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{id}"))
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut u = self.uses.write().unwrap();
        *u.entry(id.to_string()).or_insert(0) += 1;
        let _ = std::fs::create_dir_all(dir());
        let _ = std::fs::write(dir().join("usage.json"), serde_json::to_string(&*u).unwrap_or_default());
        Ok(())
    }
}
