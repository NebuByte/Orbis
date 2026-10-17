//! Live numbers for the HUD, straight from kernel32 (no extra packages, microseconds per call):
//! CPU load, memory, drive space, battery, uptime.

use serde::Serialize;
use std::sync::Mutex;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct FileTime {
    lo: u32,
    hi: u32,
}
impl FileTime {
    fn v(self) -> u64 {
        ((self.hi as u64) << 32) | self.lo as u64
    }
}

#[repr(C)]
#[allow(non_snake_case)]
struct MemoryStatusEx {
    dwLength: u32,
    dwMemoryLoad: u32,
    ullTotalPhys: u64,
    ullAvailPhys: u64,
    ullTotalPageFile: u64,
    ullAvailPageFile: u64,
    ullTotalVirtual: u64,
    ullAvailVirtual: u64,
    ullAvailExtendedVirtual: u64,
}

#[repr(C)]
#[derive(Default)]
#[allow(non_snake_case)]
struct PowerStatus {
    ACLineStatus: u8,
    BatteryFlag: u8,
    BatteryLifePercent: u8,
    SystemStatusFlag: u8,
    BatteryLifeTime: u32,
    BatteryFullLifeTime: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    fn GlobalMemoryStatusEx(m: *mut MemoryStatusEx) -> i32;
    fn GetSystemPowerStatus(s: *mut PowerStatus) -> i32;
    fn GetTickCount64() -> u64;
}

#[derive(Serialize)]
pub struct Drive {
    pub name: String,
    pub free: u64,
    pub total: u64,
}

#[derive(Serialize)]
pub struct Stats {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub drives: Vec<Drive>,
    pub battery: Option<u8>,
    pub charging: bool,
    pub uptime: u64,
}

#[derive(Default)]
pub struct Sys {
    last: Mutex<(u64, u64)>, // (idle, kernel+user) at the previous sample
}

impl Sys {
    pub fn sample(&self) -> Stats {
        // CPU: share of non-idle time since the previous call
        let (mut i, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default());
        let mut cpu = 0.0;
        if unsafe { GetSystemTimes(&mut i, &mut k, &mut u) } != 0 {
            let (idle, total) = (i.v(), k.v() + u.v()); // kernel time includes idle time
            let mut last = self.last.lock().unwrap();
            let (di, dt) = (idle.saturating_sub(last.0), total.saturating_sub(last.1));
            if last.1 != 0 && dt > 0 {
                cpu = (1.0 - di as f32 / dt as f32).clamp(0.0, 1.0) * 100.0;
            }
            *last = (idle, total);
        }
        let mut m = MemoryStatusEx {
            dwLength: std::mem::size_of::<MemoryStatusEx>() as u32,
            dwMemoryLoad: 0,
            ullTotalPhys: 0,
            ullAvailPhys: 0,
            ullTotalPageFile: 0,
            ullAvailPageFile: 0,
            ullTotalVirtual: 0,
            ullAvailVirtual: 0,
            ullAvailExtendedVirtual: 0,
        };
        unsafe { GlobalMemoryStatusEx(&mut m) };
        let drives = crate::env::fixed_drives()
            .into_iter()
            .filter_map(|d| crate::env::drive_space(&d).map(|(free, total)| Drive { name: d, free, total }))
            .collect();
        let mut p = PowerStatus::default();
        let ok = unsafe { GetSystemPowerStatus(&mut p) } != 0;
        let battery = (ok && p.BatteryLifePercent <= 100 && p.BatteryFlag != 128).then_some(p.BatteryLifePercent);
        Stats {
            cpu,
            mem_used: m.ullTotalPhys - m.ullAvailPhys,
            mem_total: m.ullTotalPhys,
            drives,
            battery,
            charging: ok && p.ACLineStatus == 1,
            uptime: unsafe { GetTickCount64() } / 1000,
        }
    }
}
