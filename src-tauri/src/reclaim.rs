//! Reclaim space: copies of the same folder or file in several places, big files nobody touched for a
//! year, old installers in Downloads. Found from the index (no disk scan); duplicate files are
//! confirmed by comparing their first and last 64 KB. Nothing is removed here except on request,
//! and then only to the Recycle Bin.

use crate::index::{Index, K_DIR, K_FILE, NONE};
use serde::Serialize;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use rayon::prelude::*;
use std::io::{Read, Seek, SeekFrom};

#[derive(Serialize, Clone)]
pub struct Place {
    pub id: u32,
    pub path: String,
    pub size: u64,
    pub mtime: u32,
}
#[derive(Serialize)]
pub struct Group {
    pub name: String,
    pub size: u64,
    /// the copies, newest first; freeing all but one saves `wasted`
    pub items: Vec<Place>,
    pub wasted: u64,
}
#[derive(Serialize)]
pub struct Report {
    pub dup_folders: Vec<Group>,
    pub dup_files: Vec<Group>,
    pub big_old: Vec<Place>,
    pub installers: Vec<Place>,
    /// copies and old installers (big old files are for you to review, so not counted)
    pub total: u64,
}

const MB: u64 = 1_000_000;

fn place(ix: &Index, i: u32) -> Place {
    Place { id: i, path: ix.path(i), size: ix.size[i as usize], mtime: ix.mtime[i as usize] }
}
/// a quick fingerprint: size + first and last 64 KB
fn fingerprint(path: &str, size: u64) -> Option<u64> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    size.hash(&mut h);
    let mut buf = vec![0u8; 65536];
    let n = f.read(&mut buf).ok()?;
    buf[..n].hash(&mut h);
    if size > 131_072 {
        f.seek(SeekFrom::End(-65536)).ok()?;
        let n = f.read(&mut buf).ok()?;
        buf[..n].hash(&mut h);
    }
    Some(h.finish())
}

pub fn report(ix: &Index, now: u32) -> Report {
    let n = ix.len();
    // ---- duplicate folders: same name, size and item count (the biggest ones; nested copies count once)
    let mut by: HashMap<(String, u64, u32), Vec<u32>> = HashMap::new();
    for i in 1..n {
        if ix.kind[i] == K_DIR && ix.size[i] >= 50 * MB && ix.count[i] > 0 {
            by.entry((ix.name(i).to_lowercase(), ix.size[i], ix.count[i])).or_default().push(i as u32);
        }
    }
    let mut groups: Vec<Vec<u32>> = by.into_values().filter(|v| v.len() > 1).collect();
    groups.sort_by_key(|v| std::cmp::Reverse(ix.size[v[0] as usize] * (v.len() as u64 - 1)));
    let mut covered = vec![false; n];
    let mut dup_folders = Vec::new();
    for v in groups {
        let mark = |covered: &mut Vec<bool>, root: u32| covered[root as usize] = true;
        // skip a group whose copies sit inside copies already listed
        let inside = |i: u32| {
            let mut p = ix.parent[i as usize];
            while p != NONE {
                if covered[p as usize] {
                    return true;
                }
                p = ix.parent[p as usize];
            }
            false
        };
        if v.iter().any(|&i| inside(i)) {
            continue;
        }
        for &i in &v {
            mark(&mut covered, i);
        }
        let mut items: Vec<Place> = v.iter().map(|&i| place(ix, i)).collect();
        items.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        let size = items[0].size;
        dup_folders.push(Group { name: ix.name(v[0] as usize).to_string(), size, wasted: size * (items.len() as u64 - 1), items });
        if dup_folders.len() >= 40 {
            break;
        }
    }
    // everything inside a listed folder copy is already counted
    for i in 1..n {
        let p = ix.parent[i];
        if p != NONE && covered[p as usize] {
            covered[i] = true;
        }
    }
    // ---- duplicate files: same name and size, then the same first and last 64 KB
    let mut byf: HashMap<(String, u64), Vec<u32>> = HashMap::new();
    for i in 1..n {
        if ix.kind[i] == K_FILE && ix.size[i] >= 5 * MB && !covered[i] {
            byf.entry((ix.name(i).to_lowercase(), ix.size[i])).or_default().push(i as u32);
        }
    }
    let mut fgroups: Vec<Vec<u32>> = byf.into_values().filter(|v| v.len() > 1).collect();
    fgroups.sort_by_key(|v| std::cmp::Reverse(ix.size[v[0] as usize] * (v.len() as u64 - 1)));
    // compared in parallel: opening a file can wait on the virus scanner
    fgroups.truncate(150);
    let mut dup_files: Vec<Group> = fgroups
        .par_iter()
        .flat_map_iter(|v| {
            let size = ix.size[v[0] as usize];
            let mut same: HashMap<u64, Vec<u32>> = HashMap::new();
            for &i in v {
                if let Some(fp) = fingerprint(&ix.path(i), size) {
                    same.entry(fp).or_default().push(i);
                }
            }
            same.into_values().filter(|ids| ids.len() > 1).map(move |ids| {
                let mut items: Vec<Place> = ids.iter().map(|&i| place(ix, i)).collect();
                items.sort_by(|a, b| b.mtime.cmp(&a.mtime));
                Group { name: ix.name(ids[0] as usize).to_string(), size, wasted: size * (items.len() as u64 - 1), items }
            })
        })
        .collect();
    dup_files.sort_by_key(|g| std::cmp::Reverse(g.wasted));
    dup_files.truncate(80);
    // ---- big files nobody has changed for a year
    let year = now.saturating_sub(365 * 86_400);
    let mut big: Vec<u32> = (1..n).filter(|&i| ix.kind[i] == K_FILE && ix.size[i] >= 500 * MB && ix.mtime[i] < year && !covered[i]).map(|i| i as u32).collect();
    big.sort_by_key(|&i| std::cmp::Reverse(ix.size[i as usize]));
    let big_old: Vec<Place> = big.into_iter().take(60).map(|i| place(ix, i)).collect();
    // ---- installers and disk images left in Downloads for over a month
    let month = now.saturating_sub(30 * 86_400);
    let in_downloads = |i: usize| {
        let mut p = ix.parent[i];
        while p != NONE {
            if ix.name(p as usize).eq_ignore_ascii_case("downloads") {
                return true;
            }
            p = ix.parent[p as usize];
        }
        false
    };
    let mut inst: Vec<u32> = (1..n)
        .filter(|&i| {
            ix.kind[i] == K_FILE && ix.size[i] >= 20 * MB && ix.mtime[i] < month && !covered[i] && {
                let e = ix.name(i).rsplit('.').next().unwrap_or("").to_lowercase();
                matches!(e.as_str(), "exe" | "msi" | "iso" | "img" | "zip" | "7z" | "rar" | "apk" | "dmg") && in_downloads(i)
            }
        })
        .map(|i| i as u32)
        .collect();
    inst.sort_by_key(|&i| std::cmp::Reverse(ix.size[i as usize]));
    let installers: Vec<Place> = inst.into_iter().take(100).map(|i| place(ix, i)).collect();
    let total = dup_folders.iter().map(|g| g.wasted).sum::<u64>()
        + dup_files.iter().map(|g| g.wasted).sum::<u64>()
        + installers.iter().map(|p| p.size).sum::<u64>();
    Report { dup_folders, dup_files, big_old, installers, total }
}

#[repr(C)]
#[allow(non_snake_case)]
struct FileOp {
    hwnd: isize,
    wFunc: u32,
    pFrom: *const u16,
    pTo: *const u16,
    fFlags: u16,
    fAnyOperationsAborted: i32,
    hNameMappings: *mut std::ffi::c_void,
    lpszProgressTitle: *const u16,
}
#[link(name = "shell32")]
extern "system" {
    fn SHFileOperationW(op: *mut FileOp) -> i32;
}
/// Move to the Recycle Bin (never a permanent delete without Windows asking first).
pub fn recycle(path: &str) -> bool {
    const FO_DELETE: u32 = 3;
    const FOF_SILENT: u16 = 0x4;
    const FOF_NOCONFIRMATION: u16 = 0x10;
    const FOF_ALLOWUNDO: u16 = 0x40;
    const FOF_NOERRORUI: u16 = 0x400;
    const FOF_WANTNUKEWARNING: u16 = 0x4000;
    let from: Vec<u16> = path.encode_utf16().chain([0, 0]).collect();
    let mut op = FileOp {
        hwnd: 0,
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    unsafe { SHFileOperationW(&mut op) == 0 && op.fAnyOperationsAborted == 0 }
}
