use serde_json::{json, Value};
use std::collections::HashSet;

use super::types::{DshExport, NativePack};
use super::util::{ext, list_videos, stem, write_text};

/// dsh 种类名：直接取宠物中文名。dsh 的 isValidPetId 仅禁 \ / : 与控制字符、长度 ≤64，
/// 中文合法；这里只清理非法字符并截断，保留可读名称（不做 ASCII 哈希）。
pub fn dsh_root(name: &str) -> String {
    let mut out: String = name.chars()
        .map(|c| if matches!(c, '\\' | '/' | ':') || c.is_control() { '_' } else { c })
        .take(64)
        .collect();
    if out.trim().is_empty() { out = "pet".into(); }
    out
}

fn names_of(list: Option<&Vec<Value>>) -> Vec<String> {
    list.map(|v| v.iter().map(|x| stem(x.as_str().unwrap_or(""))).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

/// 原生包 → dsh-pet 插件目录树（根即插件内容：`<root>-config.json` + `<root>-animation/`，
/// 直接写入 `$DSH_HOME/dsh-pet/pet/`；ZIP 导出时由命令层包一层顶层目录）。
/// dsh 硬性约束：`<root>-animation/` 一旦存在只查该目录、动画名须与文件名逐字一致，
/// 故视频额外扁平到兼容层；同时全量保留源包所有文件（不丢视频/音效/配方/辅助清单）。
pub fn export_to_dsh(pack: &NativePack, opt_root: Option<&str>) -> DshExport {
    let root = dsh_root(opt_root.unwrap_or(&pack.name));
    let mut out = pack.tree.clone(); // 1) 全量保留源包结构
    let actions = pack.config.get("actions").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut export_names: std::collections::HashMap<String, Vec<String>> = Default::default();

    // 2) dsh 兼容层：<root>-animation/<动画名>.<ext>
    for (cat, list) in &actions {
        let arr = match list { Value::Array(a) => a.clone(), _ => vec![] };
        let mut names = Vec::new();
        for raw in &arr {
            let p = raw.as_str().unwrap_or("").trim_start_matches('/');
            let name = stem(p);
            if name.is_empty() { continue; }
            // 路径对不上时按文件名兜底：HashMap 迭代无序，先排序再取，保证导出可复现
            let Some(data) = pack.tree.get(p).or_else(|| {
                let suffix = format!("/{name}.{}", ext(p));
                let mut keys: Vec<&String> = pack.tree.keys().filter(|k| k.ends_with(&suffix)).collect();
                keys.sort();
                keys.first().and_then(|k| pack.tree.get(*k))
            }) else { continue; };
            let key = format!("{cat}/{name}");
            if !seen.insert(key) { names.push(name.clone()); continue; }
            out.insert(format!("{root}-animation/{name}.{}", ext(p)), data.clone());
            names.push(name);
        }
        export_names.insert(cat.clone(), names);
    }

    // 3) actions 未登记、但包里存在的视频也补进兼容层，杜绝遗漏
    let mut videos = list_videos(&pack.tree);
    videos.sort();
    for p in videos {
        let name = stem(&p);
        if name.is_empty() || !seen.insert(format!("all/{name}")) { continue; }
        if let Some(data) = pack.tree.get(&p) {
            out.insert(format!("{root}-animation/{name}.{}", ext(&p)), data.clone());
        }
    }

    let get = |cat: &str| -> Vec<String> {
        export_names.get(cat).cloned().unwrap_or_else(|| {
            actions.get(cat).and_then(|v| v.as_array()).map(|a| names_of(Some(a))).unwrap_or_default()
        })
    };
    let (idle, turn, click, drag, move_, random) =
        (get("idle"), get("turn"), get("click"), get("drag"), get("move"), get("random"));
    let events_pool = get("events");

    // dsh 的 animationsValid 要求 events 每个池（尤其 balance）都是非空数组，
    // 否则整段 animations 被判非法 → 全部动画落回默认（桌宠能显示但没有自己的动作）。
    // 因此每个事件池都填一个真实存在的动画名；优先用对应分类，缺失时按 idle→click→random→任意视频兜底。
    let any_video = list_videos(&pack.tree).first().map(|p| stem(p)).unwrap_or_default();
    let fallback = idle.first().or_else(|| click.first()).or_else(|| random.first())
        .cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| any_video.clone());
    let pick = |prefer: &[String]| -> String {
        prefer.first().cloned().filter(|s| !s.is_empty()).unwrap_or_else(|| fallback.clone())
    };
    // 事件槽位：单动画名即可（dsh EventSlot = string | string[]，非空即合法）。
    let ev_balance = pick(&events_pool);
    let ev_whisper = events_pool.iter().find(|n| n.contains("碎碎念")).cloned()
        .or_else(|| events_pool.iter().find(|n| n.contains("观望")).cloned())
        .unwrap_or_else(|| pick(&random));
    let ev_work = pick(&random);

    let canvas = pack.config.get("canvas").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let canvas0 = canvas.first().and_then(|v| v.as_f64()).unwrap_or(640.0);
    let scale = pack.config.get("scale").and_then(|v| v.as_f64()).filter(|x| *x != 0.0).unwrap_or(1.0);
    let has_click = pack.tree.keys().any(|p| p.to_lowercase().ends_with(".wav"));

    let mut pet = json!({
        "id": root,
        "name": pack.name,
        "size": (canvas0 * scale).round() as i64,
        "balanceEnabled": false, "whisperEnabled": false, "workStatusEnabled": false, "fixedEnabled": false,
        "display": "both",
        "position": { "corner": "bottom-left", "marginX": 24, "marginY": 100 },
    });
    if let Some(sp) = pack.config.get("persona").and_then(|p| p.get("systemPrompt")).and_then(|v| v.as_str()) {
        pet["whisperPrompt"] = Value::String(sp.to_string());
    }

    // idle/turn/drag/clicks 空也合法，但补成 fallback 能让桌宠至少会动，不至于静默。
    let fill = |v: Vec<String>| -> Vec<String> { if v.is_empty() && !fallback.is_empty() { vec![fallback.clone()] } else { v } };
    let cfg = json!({
        "pets": [pet],
        "animations": {
            "idle": fill(idle), "turn": fill(turn), "drag": fill(drag), "clicks": fill(click),
            "moves": {
                "default": { "minDist": 60, "maxDist": 240, "margin": 20, "leadSec": 2, "tailSec": 2 },
                "actions": move_.iter().map(|n| json!({ "name": n })).collect::<Vec<_>>(),
            },
            "categories": [{ "id": "随机动作", "weight": 80, "actions": random }],
            // 三个事件池必须非空且槽位为真实动画名，否则 animations 整段被 dsh 判非法。
            "events": {
                "balance": [ev_balance],
                "whisper": [ev_whisper],
                "workStatus": [ev_work],
            },
        },
        "animationWeights": { "idle": 10, "turn": 5, "move": 5 },
        "clickSoundEnabled": has_click,
    });
    write_text(&mut out, &format!("{root}-config.json"), &serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string()).unwrap_or_default());
    DshExport { root, tree: out }
}

/// 只保留 dsh 真正需要的插件文件：`<root>-config.json` 与 `<root>-animation/*`。
/// 写入本地 dsh 的 pet/ 时用，避免把源包原始结构（config.json/videos/…）带进去污染目录、
/// 且多角色写入时这些同名残留会互相覆盖。导出 ZIP 不调用此函数（那边要保留完整结构）。
pub fn plugin_files(dsh: &DshExport) -> super::types::AssetTree {
    let prefix = format!("{}-animation/", dsh.root);
    let cfg = format!("{}-config.json", dsh.root);
    dsh.tree.iter()
        .filter(|(p, _)| **p == cfg || p.starts_with(&prefix))
        .map(|(p, v)| (p.clone(), v.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_kit::types::AssetTree;
    use crate::asset_kit::util::write_text;

    fn sample_pack() -> NativePack {
        let mut tree: AssetTree = Default::default();
        write_text(&mut tree, "videos/idle/待机.webm", "a");
        write_text(&mut tree, "videos/move/走路.webm", "b");
        write_text(&mut tree, "videos/events/balance/平衡.webm", "c");
        write_text(&mut tree, "sounds/click.wav", "w");
        write_text(&mut tree, "recipe.md", "r");
        let config = json!({
            "format": "pixup-pet-asset-v1", "id": "cat", "name": "猫咪",
            "actions": { "idle": ["videos/idle/待机.webm"], "move": ["videos/move/走路.webm"] },
            "persona": { "systemPrompt": "你是猫" }, "canvas": [640, 360], "scale": 1.5,
        });
        NativePack { id: "cat".into(), name: "cat".into(), config, tree }
    }

    #[test]
    fn plugin_files_drops_source_structure() {
        let r = export_to_dsh(&sample_pack(), None);
        let files = plugin_files(&r);
        // 只留 config + animation
        assert!(files.contains_key("cat-config.json"));
        assert!(files.keys().all(|p| p == "cat-config.json" || p.starts_with("cat-animation/")));
        // 源包结构与音效/配方都被排除
        assert!(!files.contains_key("config.json"));
        assert!(!files.contains_key("sounds/click.wav"));
        assert!(!files.contains_key("recipe.md"));
        assert!(files.keys().all(|p| !p.starts_with("videos/")));
    }

    #[test]
    fn export_keeps_all_files_and_builds_dsh_layer() {
        let src = sample_pack();
        let src_n = src.tree.len();
        let r = export_to_dsh(&src, None);
        assert_eq!(r.root, "cat");
        // 全量保留：原有文件一个不少
        for (p, d) in &src.tree { assert_eq!(r.tree.get(p), Some(d), "丢失 {p}"); }
        assert!(r.tree.len() >= src_n);
        // dsh 兼容层：所有视频都在 <root>-animation/
        let anim: Vec<&String> = r.tree.keys().filter(|p| p.contains("-animation/")).collect();
        assert_eq!(anim.len(), 3, "兼容层视频数: {:?}", anim);
        // config 落树根（写入 dsh pet/ 后即 pet/<root>-config.json）
        assert!(r.tree.contains_key("cat-config.json"));
        // size = 640*1.5 = 960
        let cfg = r.tree.get("cat-config.json").unwrap();
        let s = String::from_utf8_lossy(cfg);
        assert!(s.contains("\"size\": 960"));
        assert!(s.contains("\"clickSoundEnabled\": true"));
        assert!(s.contains("你是猫"));

        // dsh animationsValid：events 每池必须非空数组、槽位为非空字符串，否则整段被判非法
        let doc: serde_json::Value = serde_json::from_slice(cfg).unwrap();
        let anims = &doc["animations"];
        for key in ["idle", "turn", "drag", "clicks"] {
            assert!(anims[key].is_array(), "{key} 应为数组");
        }
        let events = &anims["events"];
        for key in ["balance", "whisper", "workStatus"] {
            let pool = &events[key];
            assert!(pool.is_array() && !pool.as_array().unwrap().is_empty(), "events.{key} 必须非空");
            for slot in pool.as_array().unwrap() {
                assert!(slot.as_str().map(|s| !s.is_empty()).unwrap_or(false), "events.{key} 槽位须非空字符串");
            }
        }
        // 填充的事件名必须是包里真实存在的动画
        let names: Vec<String> = export_names_flat(&r);
        for key in ["balance", "whisper", "workStatus"] {
            let n = events[key][0].as_str().unwrap();
            assert!(names.iter().any(|x| x == n), "events.{key} 引用了不存在的动画: {n}");
        }
    }

    #[test]
    fn dsh_root_keeps_chinese_name_and_sanitizes() {
        assert_eq!(dsh_root("豆小妹"), "豆小妹");
        assert_eq!(dsh_root("橙毛大小姐"), "橙毛大小姐");
        // 路径分隔符/冒号/控制字符被替换为下划线
        assert_eq!(dsh_root("a/b:c"), "a_b_c");
        // 长度截断到 64
        assert_eq!(dsh_root(&"宠".repeat(100)).chars().count(), 64);
        // 导出种类名即宠物中文名，config 与动画目录都用该名
        let mut p = sample_pack();
        p.name = "豆小妹".into();
        let r = export_to_dsh(&p, None);
        assert_eq!(r.root, "豆小妹");
        assert!(r.tree.contains_key("豆小妹-config.json"));
        assert!(r.tree.keys().any(|k| k.starts_with("豆小妹-animation/")));
        let doc: serde_json::Value = serde_json::from_slice(r.tree.get("豆小妹-config.json").unwrap()).unwrap();
        assert_eq!(doc["pets"][0]["id"], "豆小妹");
        assert_eq!(doc["pets"][0]["name"], "豆小妹");
    }

    fn export_names_flat(r: &DshExport) -> Vec<String> {
        r.tree.keys()
            .filter(|p| p.starts_with("cat-animation/"))
            .map(|p| {
                let f = p.rsplit('/').next().unwrap();
                f.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| f.to_string())
            })
            .collect()
    }
}
