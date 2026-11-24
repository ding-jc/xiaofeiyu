// 统一素材格式（xiaofeiyu-asset-v1）转换库：探测 / 导入 / 导出，纯内存字节树运算。
// 运行时转换全程在本进程字节树完成，不经过 Web Worker 与 base64 跨 IPC。
mod detect;
mod export;
mod import;
mod jsonc;
mod native;
mod types;
mod util;

pub use detect::detect_source;
pub use export::{dsh_root, export_to_dsh, plugin_files};
pub use import::import_to_native;
pub use native::read_native_pack;
pub use types::AssetTree;
#[allow(unused_imports)]
pub use types::{ConvertResult, DshExport, NativePack, SourceInfo, SourceKind, NATIVE_FORMAT};
#[cfg(test)]
pub use detect::detect;

#[cfg(test)]
mod tests {
    use super::*;
    use super::util::write_text;
    use serde_json::json;

    fn tree_with(paths: &[(&str, &str)]) -> AssetTree {
        let mut t = AssetTree::new();
        for (p, d) in paths { write_text(&mut t, p, d); }
        t
    }

    #[test]
    fn legacy_format_name_still_detected_as_native() {
        let t = tree_with(&[("config.json", r#"{"format":"pixup-pet-asset-v1"}"#)]);
        assert_eq!(detect(&t), SourceKind::Native);
    }

    #[test]
    fn detect_distinguishes_formats() {
        assert_eq!(detect(&tree_with(&[("config.json", r#"{"format":"xiaofeiyu-asset-v1"}"#)])), SourceKind::Native);
        assert_eq!(detect(&tree_with(&[("config.jsonc", "// c\n{}")])), SourceKind::WebDsh);
        assert_eq!(detect(&tree_with(&[("character.json", "{}")])), SourceKind::DesktopLegacy);
        assert_eq!(detect(&tree_with(&[("videos/idle/a.webm", "x")])), SourceKind::DesktopLegacy);
        assert_eq!(detect(&tree_with(&[("readme.txt", "x")])), SourceKind::Unknown);
    }

    #[test]
    fn import_preserves_nested_dirs_sound_and_recipe() {
        let src = tree_with(&[
            ("character.json", r#"{"name":"猫","actions":{"idle":["videos/idle/a.webm"]}}"#),
            ("videos/idle/a.webm", "A"),
            ("videos/events/balance/b.webm", "B"),
            ("videos/events/balance/deep/c.webm", "C"),
            ("sounds/custom.wav", "W"),
            ("recipe.md", "R"),
            ("manifest.json", "{}"),
            ("move_strides.json", "{}"),
        ]);
        let src_n = src.len();
        let r = import_to_native(src.clone(), None).unwrap();
        // 源树全量保留
        for (p, d) in &src { assert_eq!(r.tree.get(p), Some(d), "丢失 {p}"); }
        // 新增 config.json + sounds/click.wav（从 custom.wav 补）
        assert_eq!(r.tree.len(), src_n + 2, "只应新增 config 与 click.wav");
        // 填补点击音效
        assert_eq!(r.tree.get("sounds/click.wav").unwrap(), &b"W".to_vec());
        // 嵌套子目录视频也登记到 events 分类
        let cfg: serde_json::Value = serde_json::from_slice(r.tree.get("config.json").unwrap()).unwrap();
        let events = cfg["actions"]["events"].as_array().unwrap();
        assert!(events.iter().any(|v| v.as_str() == Some("videos/events/balance/b.webm")));
        assert!(events.iter().any(|v| v.as_str() == Some("videos/events/balance/deep/c.webm")));
        assert_eq!(cfg["format"], NATIVE_FORMAT);
    }

    #[test]
    fn import_web_dsh_classifies_flat_webm_and_keeps_resources() {
        let cfg = json!({
            "pets": [{ "name": "狗", "whisperPrompt": "汪" }],
            "animations": {
                "idle": ["待机"],
                "clicks": [{ "name": "点击" }],
                "sleep": ["睡觉"]
            }
        });
        let src = tree_with(&[
            ("config.jsonc", &serde_json::to_string(&cfg).unwrap()),
            ("webm/待机.webm", "A"),
            ("webm/点击.webm", "B"),
            ("webm/未登记.webm", "C"),
            ("sound/click.wav", "W"),
        ]);
        let r = import_to_native(src.clone(), None).unwrap();
        for (p, d) in &src { assert_eq!(r.tree.get(p), Some(d), "源资源丢失 {p}"); }
        assert_eq!(r.tree.get("videos/idle/待机.webm").unwrap(), &b"A".to_vec());
        assert_eq!(r.tree.get("videos/click/点击.webm").unwrap(), &b"B".to_vec());
        assert!(r.tree.contains_key("videos/random/未登记.webm"));
        let out: serde_json::Value = serde_json::from_slice(r.tree.get("config.json").unwrap()).unwrap();
        assert_eq!(out["name"], "狗");
        assert_eq!(out["persona"]["systemPrompt"], "汪");
    }

    #[test]
    fn import_idle_turn_creates_both_dirs() {
        let src = tree_with(&[("config.json", "{}"), ("videos/idle_turn/转身.webm", "X")]);
        let r = import_to_native(src, None).unwrap();
        assert_eq!(r.tree.get("videos/idle/转身.webm").unwrap(), &b"X".to_vec());
        assert_eq!(r.tree.get("videos/turn/转身.webm").unwrap(), &b"X".to_vec());
    }

    #[test]
    fn web_category_map_reads_all_pools() {
        let cfg = json!({
            "animations": {
                "idle": ["i"], "turn": ["t"], "drag": ["d"],
                "clicks": [{ "name": "c" }], "moves": { "actions": [{ "name": "m" }] },
                "categories": [{ "actions": [{ "name": "r" }] }],
                "events": { "balance": ["e"] }, "sleep": ["s"], "baifan": ["b"]
            }
        });
        let m = import::web_category_map(&cfg);
        assert_eq!(m.get("i").map(String::as_str), Some("idle"));
        assert_eq!(m.get("c").map(String::as_str), Some("click"));
        assert_eq!(m.get("m").map(String::as_str), Some("move"));
        assert_eq!(m.get("e").map(String::as_str), Some("events"));
        assert_eq!(m.get("s").map(String::as_str), Some("events"));
        assert_eq!(m.get("b").map(String::as_str), Some("random"));
    }
}

