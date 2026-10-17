//! What this PC is: drives, user folders and hardware - read once from Windows (registry and
//! kernel32, no PowerShell), so Orbis can pick sensible defaults on any machine and the first-run
//! setup can explain them.

use serde::Serialize;
use std::path::PathBuf;
use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

#[link(name = "kernel32")]
extern "system" {
    fn GetLogicalDrives() -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
}
const DRIVE_FIXED: u32 = 3;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Every fixed (internal) drive: "C:", "D:"... USB sticks, network and optical drives are left out.
pub fn fixed_drives() -> Vec<String> {
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:", (b'A' + i) as char))
        .filter(|d| unsafe { GetDriveTypeW(wide(&format!("{d}\\")).as_ptr()) } == DRIVE_FIXED)
        .collect()
}

/// (free, total) bytes of a drive like "C:"
pub fn drive_space(d: &str) -> Option<(u64, u64)> {
    let (mut a, mut t, mut f) = (0u64, 0u64, 0u64);
    (unsafe { GetDiskFreeSpaceExW(wide(&format!("{d}\\")).as_ptr(), &mut a, &mut t, &mut f) } != 0).then_some((a, t))
}

/// The drive Windows runs from ("C:").
pub fn system_drive() -> String {
    std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into())
}

/// The user's own folders wherever they live (they may have been moved to another drive).
pub fn user_folders() -> Vec<PathBuf> {
    [dirs::desktop_dir(), dirs::document_dir(), dirs::download_dir(), dirs::picture_dir(), dirs::video_dir(), dirs::audio_dir()]
        .into_iter()
        .flatten()
        .filter(|p| p.exists())
        .collect()
}

#[derive(Serialize, Clone)]
pub struct DriveInfo {
    pub name: String,
    pub free: u64,
    pub total: u64,
    pub system: bool,
}

#[derive(Serialize, Clone)]
pub struct Profile {
    pub os: String,
    pub arch: String,
    pub cpu: String,
    pub cores: usize,
    pub ram_gb: f64,
    pub gpus: Vec<String>,
    /// AI accelerators Windows knows about (Intel AI Boost, AMD/Qualcomm NPUs)
    pub npus: Vec<String>,
    /// an NPU the descriptive search can use (OpenVINO runs on Intel NPUs)
    pub npu_usable: bool,
    /// an Intel GPU the descriptive search can use instead
    pub intel_gpu: bool,
    pub battery: bool,
    pub drives: Vec<DriveInfo>,
    pub user_folders: Vec<String>,
}

fn reg_str(k: &RegKey, name: &str) -> Option<String> {
    k.get_value::<String, _>(name).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Device names of one device class (display adapters, compute accelerators...).
fn class_devices(class_guid: &str) -> Vec<String> {
    let Ok(cls) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(format!(r"SYSTEM\CurrentControlSet\Control\Class\{class_guid}")) else { return vec![] };
    let mut out: Vec<String> = cls
        .enum_keys()
        .flatten()
        .filter(|k| k.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|k| cls.open_subkey(&k).ok().and_then(|s| reg_str(&s, "DriverDesc")))
        .filter(|n| !n.contains("Basic Display") && !n.contains("Virtual") && !n.contains("Remote Display"))
        .collect();
    out.sort();
    out.dedup();
    out
}

pub fn profile(battery: bool, ram_bytes: u64) -> Profile {
    let hk = RegKey::predef(HKEY_LOCAL_MACHINE);
    let os = hk
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .ok()
        .map(|k| {
            let build: u32 = reg_str(&k, "CurrentBuildNumber").and_then(|b| b.parse().ok()).unwrap_or(0);
            let name = if build >= 22000 { "Windows 11" } else { "Windows 10" };
            format!("{name} {} (build {build})", reg_str(&k, "DisplayVersion").unwrap_or_default())
        })
        .unwrap_or_else(|| "Windows".into());
    let cpu = hk
        .open_subkey(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
        .ok()
        .and_then(|k| reg_str(&k, "ProcessorNameString"))
        .unwrap_or_else(|| "Unknown processor".into());
    // display adapters, minus virtual ones (vendor display apps, remote/virtual monitors)
    let real = ["intel", "nvidia", "geforce", "quadro", "radeon", "amd", "arc", "adreno", "qualcomm", "snapdragon", "matrox", "moore threads"];
    let gpus: Vec<String> = class_devices("{4d36e968-e325-11ce-bfc1-08002be10318}")
        .into_iter()
        .filter(|g| real.iter().any(|v| g.to_lowercase().contains(v)))
        .collect();
    let npus = class_devices("{f01a9d53-3ff6-48d2-9f97-c8a7004be10c}");
    let sys = system_drive();
    let drives = fixed_drives()
        .into_iter()
        .filter_map(|d| drive_space(&d).map(|(free, total)| DriveInfo { system: d.eq_ignore_ascii_case(&sys), name: d, free, total }))
        .collect();
    Profile {
        os,
        arch: std::env::consts::ARCH.into(),
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        ram_gb: (ram_bytes as f64 / 1e9 * 10.0).round() / 10.0,
        npu_usable: npus.iter().any(|n| n.contains("Intel") && (n.contains("AI Boost") || n.contains("NPU"))),
        intel_gpu: gpus.iter().any(|g| g.contains("Intel") && (g.contains("Arc") || g.contains("Graphics"))),
        cpu,
        gpus,
        npus,
        battery,
        drives,
        user_folders: user_folders().iter().map(|p| p.display().to_string()).collect(),
    }
}
