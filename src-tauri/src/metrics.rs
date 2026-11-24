// 灵动岛本地指标采样：CPU / 内存 / 网速。纯本机读取，不联网。
use serde_json::json;
use std::{
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    thread,
    time::Duration,
};
use sysinfo::{Networks, System};
use tauri::{AppHandle, Emitter};

pub struct Metrics {
    pub running: Arc<AtomicBool>,
}

impl Metrics {
    pub fn start(app: AppHandle) -> Self {
        let running = Arc::new(AtomicBool::new(false));
        let flag = running.clone();
        thread::spawn(move || {
            let mut sys = System::new();
            let mut nets = Networks::new_with_refreshed_list();
            let mut last_rx: u64 = 0;
            let mut last_tx: u64 = 0;
            let mut first = true;
            loop {
                thread::sleep(Duration::from_secs(1));
                if !flag.load(Ordering::Relaxed) { first = true; continue; }
                sys.refresh_cpu_usage();
                sys.refresh_memory();
                nets.refresh(true);
                let rx: u64 = nets.iter().map(|(_, d)| d.total_received()).sum();
                let tx: u64 = nets.iter().map(|(_, d)| d.total_transmitted()).sum();
                let (down, up) = if first { (0, 0) } else { (rx.saturating_sub(last_rx), tx.saturating_sub(last_tx)) };
                last_rx = rx; last_tx = tx; first = false;
                let payload = json!({
                    "cpu": sys.global_cpu_usage(),
                    "mem": if sys.total_memory() > 0 {
                        sys.used_memory() as f64 / sys.total_memory() as f64 * 100.0
                    } else { 0.0 },
                    "mem_used_mb": (sys.used_memory() / 1024 / 1024) as u64,
                    "mem_total_mb": (sys.total_memory() / 1024 / 1024) as u64,
                    "down_kb": down as f64 / 1024.0,
                    "up_kb": up as f64 / 1024.0,
                });
                let _ = app.emit("sys://metrics", payload);
            }
        });
        Self { running }
    }

    pub fn set(&self, on: bool) { self.running.store(on, Ordering::Relaxed); }
}
