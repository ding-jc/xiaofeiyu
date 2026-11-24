fn main() {
    // 图标变化时强制重跑 build script，否则 exe 会一直链接旧的 resource.lib。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
