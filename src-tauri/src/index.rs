//! The file index: every folder and file on the indexed drives, flattened into columns.
//!
//! Node 0 is the PC itself, its children are the drives, everything else hangs below.
//! Nodes are stored in depth-first (pre)order, so a parent's id is always lower than its
//! children's - sizes roll up in one backward pass and the radial layout runs in one
//! forward pass. Names live in two big string buffers (display + normalized for search)
//! instead of millions of small allocations.
//!
//! Memory diet: tooling folders (node_modules, .git, caches...) are kept as ONE node with
//! their total size and item count - their contents are counted, not stored. Layout and
//! child tables are only needed while building, so they are dropped afterwards.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as Cmp;
use std::f32::consts::PI;
use std::fs;
use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const NONE: u32 = u32::MAX;
pub const K_FILE: u8 = 0;
pub const K_DIR: u8 = 1;
pub const K_LINK: u8 = 2;
pub const K_DRIVE: u8 = 3;
pub const K_ROOT: u8 = 4;
/// a tooling folder whose contents were counted but not stored
pub const K_COLLAPSED: u8 = 5;
const VERSION: u32 = 2;
const MAX_TOKENS: usize = 8;

/// Folders whose contents are tooling noise: stored as a single node.
const COLLAPSE: &[&str] = &[
    "node_modules", ".git", ".pnpm-store", "__pycache__", "site-packages", ".venv", "venv",
    ".next", ".nuxt", ".gradle", ".dart_tool", ".cache", ".svn", ".idea", ".angular", ".turbo",
];

#[derive(Serialize, Deserialize, Default)]
pub struct Index {
    pub version: u32,
    pub built_at: i64,
    names: String,
    name_end: Vec<u32>,
    norm: String,
    norm_end: Vec<u32>,
    pub parent: Vec<u32>,
    pub kind: Vec<u8>,
    /// file size; for folders the total size of everything inside
    pub size: Vec<u64>,
    /// last change, seconds since 1970
    pub mtime: Vec<u32>,
    /// number of items inside (all levels), 0 for files
    pub count: Vec<u32>,
    pub depth: Vec<u8>,
    /// the map angle of each node (radians)
    ang: Vec<f32>,
    /// per node: inside a folder of copies or build output (worked out on first search, not saved)
    #[serde(skip)]
    noise: std::sync::OnceLock<Vec<bool>>,
}

/// Folders whose contents are copies or machine output: AI-agent worktrees (whole copies of a repo),
/// build output, test fixtures, the organiser's duplicates. Matches inside rank far lower.
const NOISE: &[&str] = &[
    ".claude", "worktrees", "bin", "obj", "publish", "dist", "build", "target", ".vs", "packages",
    "testdata", "fuzz", "coverage", "__pycache__", "_duplicates", "$recycle.bin",
];

/// Search filters from the search box: type:pdf  changed:week  in:Projects  big:500mb
#[derive(Default, Deserialize)]
pub struct Filters {
    /// file extensions (lowercase, no dot); empty = any
    #[serde(default)]
    pub exts: Vec<String>,
    #[serde(default)]
    pub folders_only: bool,
    /// changed at or after this time (seconds since 1970); 0 = any
    #[serde(default)]
    pub since: u32,
    /// some folder above it has this in its name; empty = anywhere
    #[serde(default)]
    pub within: String,
    /// at least this many bytes; 0 = any
    #[serde(default)]
    pub min_size: u64,
    /// the file types chosen in "What Orbis searches" (None: every type). Set by Orbis, not the box;
    /// folders always pass, and an explicit type: filter overrides it.
    #[serde(skip)]
    pub allowed: Option<std::collections::HashSet<String>>,
}
impl Filters {
    fn any(&self) -> bool {
        !self.exts.is_empty() || self.folders_only || self.since > 0 || !self.within.is_empty() || self.min_size > 0
    }
}

/// One node as the map sees it.
#[derive(Serialize, Clone)]
pub struct GNode {
    pub id: u32,
    pub parent: u32,
    pub name: String,
    pub kind: u8,
    pub depth: u8,
    pub ang: f32,
    pub count: u32,
    pub size: u64,
    /// newest file change anywhere inside (map "activity glow"); 0 when not computed
    pub recent: u32,
}

struct Raw {
    name: String,
    kind: u8,
    size: u64,
    mtime: u32,
    /// for collapsed folders: how many items were inside
    inside: u32,
    kids: Vec<Raw>,
}

/// Exact folder paths (lowercase) the walker never enters.
pub struct Skip(Vec<String>);
impl Skip {
    pub fn new(paths: &[String]) -> Self {
        Skip(paths.iter().map(|p| p.trim_end_matches('\\').to_lowercase()).collect())
    }
    fn hit(&self, p: &Path) -> bool {
        let s = p.to_string_lossy().to_lowercase();
        self.0.iter().any(|x| *x == s)
    }
}

/// Lowercase + Arabic-aware folding so "مؤسسة" finds "موسسه", "Daw_Alfada" finds "daw alfada".
pub fn normalize(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for ch in s.chars() {
        let c = match ch {
            'أ' | 'إ' | 'آ' => 'ا',
            'ة' => 'ه',
            'ى' => 'ي',
            'ؤ' => 'و',
            'ئ' => 'ي',
            '_' | '-' => ' ',
            c => c,
        };
        if ('\u{064B}'..='\u{0652}').contains(&c) || c == '\u{0640}' {
            continue; // diacritics and tatweel
        }
        for l in c.to_lowercase() {
            o.push(l);
        }
    }
    o
}

fn unix(t: SystemTime) -> u32 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as u32).unwrap_or(0)
}

/// Size and item count of a folder, without keeping anything (used for tooling folders).
fn tally(path: &Path, prog: &AtomicU64) -> (u64, u32) {
    let rd = match fs::read_dir(path) {
        Ok(r) => r,
        Err(_) => return (0, 0),
    };
    let mut size = 0u64;
    let mut count = 0u32;
    let mut dirs = Vec::new();
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        count += 1;
        if ft.is_dir() && !ft.is_symlink() {
            dirs.push(e.path());
        } else if !ft.is_symlink() {
            size += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    prog.fetch_add(count as u64, Ordering::Relaxed);
    let (s2, c2) = dirs
        .par_iter()
        .map(|d| tally(d, prog))
        .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
    (size + s2, count + c2)
}

/// Read one folder, then its sub-folders in parallel. On Windows the size and date come
/// with the directory listing itself, so there is no extra call per file.
fn walk(path: &Path, prog: &AtomicU64, skip: &Skip) -> Vec<Raw> {
    let rd = match fs::read_dir(path) {
        Ok(r) => r,
        Err(_) => return Vec::new(), // no access: leave it empty
    };
    let mut out = Vec::new();
    let mut dirs = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        let md = e.metadata().ok();
        let mtime = md.as_ref().and_then(|m| m.modified().ok()).map(unix).unwrap_or(0);
        if ft.is_symlink() {
            // symlinks and junctions: recorded, never followed (no loops, no double counting)
            out.push(Raw { name, kind: K_LINK, size: 0, mtime, inside: 0, kids: Vec::new() });
        } else if ft.is_dir() {
            let lower = name.to_lowercase();
            if lower == "$recycle.bin" || lower == "system volume information" {
                continue;
            }
            let p = e.path();
            if skip.hit(&p) {
                continue;
            }
            dirs.push((name, lower, p, mtime));
        } else {
            let size = md.map(|m| m.len()).unwrap_or(0);
            out.push(Raw { name, kind: K_FILE, size, mtime, inside: 0, kids: Vec::new() });
        }
    }
    prog.fetch_add((out.len() + dirs.len()) as u64, Ordering::Relaxed);
    let sub: Vec<Raw> = dirs
        .into_par_iter()
        .map(|(name, lower, p, mtime)| {
            if COLLAPSE.contains(&lower.as_str()) {
                let (size, inside) = tally(&p, prog);
                Raw { name, kind: K_COLLAPSED, size, mtime, inside, kids: Vec::new() }
            } else {
                let kids = walk(&p, prog, skip);
                Raw { name, kind: K_DIR, size: 0, mtime, inside: 0, kids }
            }
        })
        .collect();
    out.extend(sub);
    out
}

impl Index {
    pub fn build(roots: &[(String, PathBuf)], skip: &Skip, prog: &AtomicU64) -> Index {
        let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "This PC".into());
        let trees: Vec<(String, Vec<Raw>)> =
            roots.par_iter().map(|(n, p)| (n.clone(), walk(p, prog, skip))).collect();
        let mut ix = Index { version: VERSION, name_end: vec![0], norm_end: vec![0], ..Default::default() };
        let mut inside = vec![0u32];
        ix.push(&host, NONE, K_ROOT, 0, 0, 0);
        for (name, kids) in trees {
            let id = ix.push(&name, 0, K_DRIVE, 0, 0, 1);
            inside.push(0);
            for k in kids {
                ix.flatten(k, id, 2, &mut inside);
            }
        }
        ix.built_at = unix(SystemTime::now()) as i64;
        ix.finish(&inside);
        ix
    }

    fn push(&mut self, name: &str, parent: u32, kind: u8, size: u64, mtime: u32, depth: u8) -> u32 {
        self.push_norm(name, &normalize(name), parent, kind, size, mtime, depth)
    }

    #[allow(clippy::too_many_arguments)]
    fn push_norm(&mut self, name: &str, norm: &str, parent: u32, kind: u8, size: u64, mtime: u32, depth: u8) -> u32 {
        let id = self.parent.len() as u32;
        self.names.push_str(name);
        self.name_end.push(self.names.len() as u32);
        self.norm.push_str(norm);
        self.norm_end.push(self.norm.len() as u32);
        self.parent.push(parent);
        self.kind.push(kind);
        self.size.push(size);
        self.mtime.push(mtime);
        self.depth.push(depth);
        id
    }

    /// The same index with some folders left out and others taken back in - no re-scan of the
    /// drives. Left-out folders (and everything inside) are dropped; folders taken back in are read
    /// from disk and grafted under their parents; sizes, counts and the map layout are worked out
    /// again. None when a folder taken back in has no parent in the index (the caller re-scans).
    pub fn reshape(&self, drop: &[String], add: &[String], skip: &Skip, prog: &AtomicU64) -> Option<Index> {
        let n = self.len();
        let mut gone = vec![false; n];
        for id in self.find_paths(drop).into_iter().flatten() {
            gone[id as usize] = true;
        }
        for i in 1..n {
            let p = self.parent[i];
            if p != NONE && gone[p as usize] {
                gone[i] = true; // children always come after their parents
            }
        }
        // folders taken back in: under which mapped folder (or drive) each one goes, then read it
        let already = self.find_paths(add);
        let mut grafts: Vec<(u32, Raw)> = Vec::new();
        for (k, path) in add.iter().enumerate() {
            if already[k].is_some() || !Path::new(path).is_dir() {
                continue;
            }
            let (parent_path, name) = path.rsplit_once('\\')?;
            let parent = if parent_path.len() <= 2 {
                (1..n).find(|&i| self.kind[i] == K_DRIVE && self.name(i).eq_ignore_ascii_case(parent_path)).map(|i| i as u32)
            } else {
                self.find_paths(&[parent_path.to_string()])[0]
            }?;
            if gone[parent as usize] {
                continue; // it sits inside a place that is left out now
            }
            let p = Path::new(path);
            let mtime = fs::metadata(p).ok().and_then(|m| m.modified().ok()).map(unix).unwrap_or(0);
            grafts.push((parent, Raw { name: name.to_string(), kind: K_DIR, size: 0, mtime, inside: 0, kids: walk(p, prog, skip) }));
        }
        let mut ix = Index { version: VERSION, built_at: self.built_at, name_end: vec![0], norm_end: vec![0], ..Default::default() };
        let mut map = vec![NONE; n];
        let mut inside: Vec<u32> = Vec::with_capacity(n);
        for i in 0..n {
            if gone[i] {
                continue;
            }
            let (k, p) = (self.kind[i], self.parent[i]);
            let own = if k == K_FILE || k == K_COLLAPSED { self.size[i] } else { 0 }; // folders roll up again
            map[i] = ix.push_norm(self.name(i), self.norm_name(i), if p == NONE { NONE } else { map[p as usize] }, k, own, self.mtime[i], self.depth[i]);
            inside.push(if k == K_COLLAPSED { self.count[i] } else { 0 });
        }
        for (parent, raw) in grafts {
            ix.flatten(raw, map[parent as usize], self.depth[parent as usize].saturating_add(1), &mut inside);
        }
        ix.finish(&inside);
        Some(ix)
    }

    fn flatten(&mut self, r: Raw, parent: u32, depth: u8, inside: &mut Vec<u32>) {
        let Raw { name, kind, size, mtime, inside: n_in, kids } = r;
        let id = self.push(&name, parent, kind, size, mtime, depth);
        inside.push(n_in);
        for k in kids {
            self.flatten(k, id, depth.saturating_add(1), inside);
        }
    }

    fn finish(&mut self, inside: &[u32]) {
        let n = self.parent.len();
        // sizes and item counts roll up from the leaves (children always have higher ids)
        self.count = inside.to_vec();
        for i in (1..n).rev() {
            let p = self.parent[i] as usize;
            self.size[p] += self.size[i];
            self.count[p] += self.count[i] + 1;
        }
        // temporary child lists (folders first, then by name) for the layout
        let mut start = Vec::with_capacity(n + 1);
        let mut deg = vec![0u32; n];
        for i in 1..n {
            deg[self.parent[i] as usize] += 1;
        }
        let mut acc = 0u32;
        for d in &deg {
            start.push(acc);
            acc += d;
        }
        start.push(acc);
        drop(deg);
        let mut child = vec![0u32; acc as usize];
        let mut fill: Vec<u32> = start[..n].to_vec();
        for i in 1..n {
            let p = self.parent[i] as usize;
            child[fill[p] as usize] = i as u32;
            fill[p] += 1;
        }
        drop(fill);
        for i in 0..n {
            let (s, e) = (start[i] as usize, start[i + 1] as usize);
            if e - s > 1 {
                child[s..e].sort_by(|&a, &b| {
                    let (da, db) = (self.kind[a as usize] != K_FILE, self.kind[b as usize] != K_FILE);
                    db.cmp(&da).then_with(|| self.norm_name(a as usize).cmp(self.norm_name(b as usize)))
                });
            }
        }
        // radial layout: each node gets a slice of its parent's angle, sized by sqrt(items inside)
        // so huge folders get room without squeezing small ones to nothing. Only the middle
        // angle is kept afterwards.
        let mut a0 = vec![0.0f32; n];
        let mut a1 = vec![0.0f32; n];
        a0[0] = -PI;
        a1[0] = PI;
        for i in 0..n {
            let (s, e) = (start[i] as usize, start[i + 1] as usize);
            if s == e {
                continue;
            }
            let tot: f32 = child[s..e].iter().map(|&c| 1.0 + (self.count[c as usize] as f32).sqrt()).sum();
            let (lo, hi) = (a0[i], a1[i]);
            let mut a = lo;
            for &c in &child[s..e] {
                let span = (hi - lo) * (1.0 + (self.count[c as usize] as f32).sqrt()) / tot;
                a0[c as usize] = a;
                a1[c as usize] = a + span;
                a += span;
            }
        }
        self.ang = a0.iter().zip(&a1).map(|(x, y)| (x + y) / 2.0).collect();
        self.names.shrink_to_fit();
        self.norm.shrink_to_fit();
    }

    pub fn len(&self) -> usize {
        self.parent.len()
    }
    pub fn name(&self, i: usize) -> &str {
        &self.names[self.name_end[i] as usize..self.name_end[i + 1] as usize]
    }
    fn norm_name(&self, i: usize) -> &str {
        &self.norm[self.norm_end[i] as usize..self.norm_end[i + 1] as usize]
    }
    /// (folders, files) directly inside - found by scanning, since the child table is not kept
    pub fn direct_children(&self, i: u32) -> (u32, u32) {
        let (d, f) = self
            .parent
            .par_iter()
            .enumerate()
            .filter(|(_, &p)| p == i)
            .map(|(c, _)| if self.kind[c] == K_FILE || self.kind[c] == K_LINK { (0u32, 1u32) } else { (1, 0) })
            .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
        (d, f)
    }
    pub fn is_tooling(&self, i: usize) -> bool {
        let mut c = i as u32;
        while c != NONE {
            if self.kind[c as usize] == K_COLLAPSED {
                return true;
            }
            c = self.parent[c as usize];
        }
        false
    }

    /// Full Windows path, e.g. D:\Work\Projects\Website
    pub fn path(&self, i: u32) -> String {
        let mut parts = Vec::new();
        let mut c = i;
        while c != NONE && self.kind[c as usize] != K_ROOT {
            parts.push(self.name(c as usize));
            if self.kind[c as usize] == K_DRIVE {
                break;
            }
            c = self.parent[c as usize];
        }
        parts.reverse();
        match parts.split_first() {
            None => String::new(),
            Some((drive, rest)) => format!("{}\\{}", drive, rest.join("\\")),
        }
    }

    pub fn gnode(&self, i: usize) -> GNode {
        GNode {
            id: i as u32,
            parent: self.parent[i],
            name: self.name(i).to_string(),
            kind: self.kind[i],
            depth: self.depth[i],
            ang: self.ang[i],
            count: self.count[i],
            size: self.size[i],
            recent: 0,
        }
    }

    /// PC -> drive -> ... -> node
    pub fn chain(&self, i: u32) -> Vec<GNode> {
        let mut v = Vec::new();
        let mut c = i;
        while c != NONE {
            v.push(self.gnode(c as usize));
            c = self.parent[c as usize];
        }
        v.reverse();
        v
    }

    fn noise(&self) -> &Vec<bool> {
        self.noise.get_or_init(|| {
            let n = self.len();
            let maxd = self.depth.iter().copied().max().unwrap_or(0) as usize;
            let mut by_depth: Vec<Vec<u32>> = vec![Vec::new(); maxd + 1];
            for i in 0..n {
                by_depth[self.depth[i] as usize].push(i as u32);
            }
            let mut v = vec![false; n];
            for level in &by_depth {
                for &i in level {
                    let (i, p) = (i as usize, self.parent[i as usize]);
                    v[i] = (p != NONE && v[p as usize]) || NOISE.iter().any(|w| self.name(i).eq_ignore_ascii_case(w));
                }
            }
            v
        })
    }
    /// inside a folder of copies or build output (see NOISE)
    pub fn is_noise(&self, i: usize) -> bool {
        self.noise()[i]
    }

    /// Index ids for full paths (from the descriptive search): one parallel pass over the
    /// names, then a full-path check on the few name matches. None = not in the index.
    pub fn find_paths(&self, paths: &[String]) -> Vec<Option<u32>> {
        let mut want: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
        for (k, p) in paths.iter().enumerate() {
            let leaf = p.rsplit('\\').next().unwrap_or(p);
            want.entry(normalize(leaf)).or_default().push(k);
        }
        let cands: Vec<u32> = (1..self.len())
            .into_par_iter()
            .filter(|&i| want.contains_key(self.norm_name(i)))
            .map(|i| i as u32)
            .collect();
        let mut out = vec![None; paths.len()];
        for i in cands {
            let full = self.path(i).to_lowercase();
            for &k in &want[self.norm_name(i as usize)] {
                if out[k].is_none() && paths[k].to_lowercase() == full {
                    out[k] = Some(i);
                }
            }
        }
        out
    }

    /// What the map draws at rest: the PC, drives, the first levels of real folders, and the
    /// fuller folders one or two levels deeper, each with the time of its newest file change.
    pub fn base_graph(&self) -> Vec<GNode> {
        let recent = self.recent_changes();
        (0..self.len())
            .filter(|&i| {
                let (k, d, c) = (self.kind[i], self.depth[i], self.count[i]);
                k == K_ROOT
                    || k == K_DRIVE
                    || (k == K_DIR && (d <= 3 || (d == 4 && c >= 500) || (d == 5 && c >= 20_000)))
            })
            .map(|i| GNode { recent: recent[i], ..self.gnode(i) })
            .collect()
    }

    /// Newest file mtime inside every node, rolled up from the deepest level. Only files count,
    /// so folder housekeeping and tooling folders (not opened) do not make a folder look busy.
    fn recent_changes(&self) -> Vec<u32> {
        let n = self.len();
        let mut rec: Vec<u32> = (0..n).map(|i| if self.kind[i] == K_FILE { self.mtime[i] } else { 0 }).collect();
        let maxd = self.depth.iter().copied().max().unwrap_or(0) as usize;
        let mut by_depth: Vec<Vec<u32>> = vec![Vec::new(); maxd + 1];
        for i in 0..n {
            by_depth[self.depth[i] as usize].push(i as u32);
        }
        for d in (1..=maxd).rev() {
            for &i in &by_depth[d] {
                let p = self.parent[i as usize];
                if p != NONE && rec[i as usize] > rec[p as usize] {
                    rec[p as usize] = rec[i as usize];
                }
            }
        }
        rec
    }

    fn passes(&self, i: usize, f: &Filters, within: &str) -> bool {
        let k = self.kind[i];
        if let Some(allowed) = &f.allowed {
            if k == K_FILE && !allowed.contains(self.norm_name(i).rsplit_once('.').map(|(_, e)| e).unwrap_or("")) {
                return false;
            }
        }
        if f.folders_only && k != K_DIR && k != K_COLLAPSED {
            return false;
        }
        if !f.exts.is_empty() {
            if k != K_FILE && k != K_LINK {
                return false;
            }
            let ext = self.norm_name(i).rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            if !f.exts.iter().any(|e| e == ext) {
                return false;
            }
        }
        if (f.since > 0 && self.mtime[i] < f.since) || (f.min_size > 0 && self.size[i] < f.min_size) {
            return false;
        }
        if !within.is_empty() {
            let mut c = self.parent[i];
            while c != NONE && !self.norm_name(c as usize).contains(within) {
                c = self.parent[c as usize];
            }
            if c == NONE {
                return false;
            }
        }
        true
    }

    /// Every word must appear in the name, or (for all but one word) in a parent folder's name;
    /// filters narrow it further. Filters alone (no words) list the newest matches first.
    /// Returns (total matches, best `limit` as (id, score)).
    pub fn search(&self, q: &str, f: &Filters, limit: usize) -> (usize, Vec<(u32, f32)>) {
        let qn = normalize(q);
        let toks: Vec<&str> = qn.split_whitespace().take(MAX_TOKENS).collect();
        if toks.is_empty() && !f.any() {
            return (0, Vec::new());
        }
        let (noise, within, filtered) = (self.noise(), normalize(&f.within), f.any() || f.allowed.is_some());
        let mut hits: Vec<(u32, f32)> = (1..self.len())
            .into_par_iter()
            .filter_map(|i| {
                let s = if toks.is_empty() { 1.0 + self.mtime[i] as f32 / 4.0e9 } else { self.score(i, &toks, &qn)? };
                if filtered && !self.passes(i, f, &within) {
                    return None;
                }
                Some((i as u32, if noise[i] { s * 0.35 } else { s }))
            })
            .collect();
        let total = hits.len();
        let cmp = |a: &(u32, f32), b: &(u32, f32)| -> Cmp {
            b.1.partial_cmp(&a.1)
                .unwrap_or(Cmp::Equal)
                .then_with(|| self.depth[a.0 as usize].cmp(&self.depth[b.0 as usize]))
                .then_with(|| self.mtime[b.0 as usize].cmp(&self.mtime[a.0 as usize]))
        };
        if hits.len() > limit {
            hits.select_nth_unstable_by(limit, cmp);
            hits.truncate(limit);
        }
        hits.sort_by(cmp);
        (total, hits)
    }

    fn score(&self, i: usize, toks: &[&str], qn: &str) -> Option<f32> {
        let nm = self.norm_name(i);
        let mut s = 0.0f32;
        let mut pending = [false; MAX_TOKENS];
        let mut any = false;
        for (k, t) in toks.iter().enumerate() {
            if nm.starts_with(t) {
                s += 5.0;
                any = true;
            } else if nm.contains(t) {
                s += 4.0;
                any = true;
            } else {
                pending[k] = true;
            }
        }
        if !any {
            return None;
        }
        // words not in the name must be in some parent folder's name
        for (k, t) in toks.iter().enumerate() {
            if !pending[k] {
                continue;
            }
            let mut c = self.parent[i];
            let mut found = false;
            while c != NONE && self.kind[c as usize] != K_ROOT {
                if self.norm_name(c as usize).contains(t) {
                    found = true;
                    break;
                }
                c = self.parent[c as usize];
            }
            if !found {
                return None;
            }
            s += 1.0;
        }
        if nm == qn {
            s += 4.0;
        }
        if self.kind[i] == K_DIR {
            s += 0.5;
        }
        if self.kind[i] == K_COLLAPSED {
            s -= 3.0; // a node_modules folder rarely is what you're after
        }
        Some(s)
    }

    pub fn save(&self, p: &Path) -> io::Result<()> {
        if let Some(d) = p.parent() {
            fs::create_dir_all(d)?;
        }
        let tmp = p.with_extension("tmp");
        {
            let mut w = BufWriter::new(fs::File::create(&tmp)?);
            bincode::serialize_into(&mut w, self).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
            w.flush()?;
        }
        fs::rename(tmp, p)
    }

    pub fn load(p: &Path) -> Option<Index> {
        let f = fs::File::open(p).ok()?;
        let ix: Index = bincode::deserialize_from(BufReader::new(f)).ok()?;
        (ix.version == VERSION).then_some(ix)
    }
}
