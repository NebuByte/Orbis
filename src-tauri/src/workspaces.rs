//! Workspaces: the things you open together, opened together. Orbis keeps a small log of what you open
//! from it (files, folders, folders in VS Code, apps) and suggests groups that keep coming back; you
//! can also build your own. Kept in %LOCALAPPDATA%\Orbis (opens.jsonl, workspaces.json).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct Item {
    /// "file" | "folder" | "vscode" (a folder opened in VS Code) | "app"
    pub kind: String,
    /// a full path, or the app's id
    pub target: String,
    pub name: String,
}
#[derive(Serialize, Deserialize, Clone)]
pub struct Workspace {
    pub name: String,
    pub items: Vec<Item>,
}
#[derive(Deserialize)]
struct Opened {
    t: i64,
    #[serde(flatten)]
    item: Item,
}

fn log_file() -> PathBuf {
    crate::data_dir().join("opens.jsonl")
}
fn ws_file() -> PathBuf {
    crate::data_dir().join("workspaces.json")
}
fn key(i: &Item) -> String {
    format!("{}|{}", i.kind, i.target.to_lowercase())
}

/// note that something was opened from Orbis (the log keeps the newest ~4,000 lines)
pub fn log(kind: &str, target: &str, name: &str) {
    let line = serde_json::json!({ "t": crate::now(), "kind": kind, "target": target, "name": name }).to_string();
    let path = log_file();
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&path) {
            let keep: Vec<&str> = t.lines().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
            let _ = std::fs::write(&path, keep.join("\n") + "\n");
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

pub fn load() -> Vec<Workspace> {
    std::fs::read_to_string(ws_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
fn save(all: &[Workspace]) -> Result<(), String> {
    let _ = std::fs::create_dir_all(crate::data_dir());
    std::fs::write(ws_file(), serde_json::to_string_pretty(all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Groups that keep coming back: opens less than 20 minutes apart make a session, and items that were
/// opened together in at least two sessions are joined into a suggestion (2 to 6 items).
fn suggest(saved: &[Workspace]) -> Vec<Workspace> {
    let Ok(text) = std::fs::read_to_string(log_file()) else { return Vec::new() };
    let opens: Vec<Opened> = text.lines().rev().take(3000).filter_map(|l| serde_json::from_str(l).ok()).collect::<Vec<_>>().into_iter().rev().collect();
    let mut sessions: Vec<Vec<Item>> = Vec::new();
    let mut last = i64::MIN;
    for o in opens {
        if o.t - last > 20 * 60 || sessions.is_empty() {
            sessions.push(Vec::new());
        }
        last = o.t;
        let s = sessions.last_mut().unwrap();
        if !s.iter().any(|i| key(i) == key(&o.item)) {
            s.push(o.item);
        }
    }
    let mut pair: HashMap<(String, String), u32> = HashMap::new();
    let mut items: HashMap<String, Item> = HashMap::new();
    for s in sessions.iter().filter(|s| s.len() >= 2) {
        let keys: Vec<String> = s.iter().take(8).map(key).collect();
        for (a, i) in s.iter().take(8).enumerate() {
            items.insert(keys[a].clone(), i.clone());
            for b in a + 1..keys.len() {
                let (x, y) = if keys[a] < keys[b] { (keys[a].clone(), keys[b].clone()) } else { (keys[b].clone(), keys[a].clone()) };
                *pair.entry((x, y)).or_insert(0) += 1;
            }
        }
    }
    // join items that came back together at least twice
    let mut group: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Vec<String>> = Vec::new();
    let mut strong: Vec<((String, String), u32)> = pair.into_iter().filter(|(_, n)| *n >= 2).collect();
    strong.sort_by(|a, b| b.1.cmp(&a.1));
    for ((a, b), _) in strong {
        match (group.get(&a).copied(), group.get(&b).copied()) {
            (None, None) => {
                group.insert(a.clone(), groups.len());
                group.insert(b.clone(), groups.len());
                groups.push(vec![a, b]);
            }
            (Some(g), None) if groups[g].len() < 6 => {
                group.insert(b.clone(), g);
                groups[g].push(b);
            }
            (None, Some(g)) if groups[g].len() < 6 => {
                group.insert(a.clone(), g);
                groups[g].push(a);
            }
            _ => {}
        }
    }
    let known: Vec<HashSet<String>> = saved.iter().map(|w| w.items.iter().map(key).collect()).collect();
    groups
        .into_iter()
        .filter(|g| !known.iter().any(|k| g.iter().all(|x| k.contains(x))))
        .take(5)
        .map(|g| {
            let its: Vec<Item> = g.iter().filter_map(|k| items.get(k).cloned()).collect();
            // named after the folder they share, or the first one
            let name = its.iter().find(|i| i.kind == "folder" || i.kind == "vscode").or(its.first()).map(|i| i.name.clone()).unwrap_or_else(|| "Workspace".into());
            Workspace { name, items: its }
        })
        .collect()
}

#[derive(Serialize)]
pub struct Overview {
    pub saved: Vec<Workspace>,
    pub suggested: Vec<Workspace>,
}
#[tauri::command]
pub fn workspaces() -> Overview {
    let saved = load();
    let suggested = suggest(&saved);
    Overview { saved, suggested }
}
/// add or replace a workspace (by name, any case)
#[tauri::command]
pub fn save_workspace(ws: Workspace) -> Result<(), String> {
    let name = ws.name.trim().to_string();
    if name.is_empty() || name.len() > 40 {
        return Err("Give the workspace a short name.".into());
    }
    let mut all = load();
    all.retain(|w| !w.name.eq_ignore_ascii_case(&name));
    all.push(Workspace { name, items: ws.items });
    all.sort_by_key(|w| w.name.to_lowercase());
    save(&all)
}
#[tauri::command]
pub fn delete_workspace(name: String) -> Result<(), String> {
    let mut all = load();
    all.retain(|w| !w.name.eq_ignore_ascii_case(&name));
    save(&all)
}
/// open everything in a workspace; returns how many opened
#[tauri::command]
pub fn open_workspace(name: String, app: tauri::AppHandle) -> Result<usize, String> {
    use tauri::Manager;
    let ws = load().into_iter().find(|w| w.name.eq_ignore_ascii_case(&name)).ok_or("No workspace by that name.")?;
    let mut n = 0;
    for i in &ws.items {
        let ok = match i.kind.as_str() {
            "app" => app.state::<crate::apps::Apps>().launch(&i.target).is_ok(),
            "vscode" => crate::open_in_vscode(&i.target).is_ok(),
            _ => std::path::Path::new(&i.target).exists() && std::process::Command::new("explorer.exe").arg(&i.target).spawn().is_ok(),
        };
        if ok {
            n += 1;
        }
    }
    Ok(n)
}
