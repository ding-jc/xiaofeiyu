use crate::packs::safe_id;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

use super::detect::detect;
use super::jsonc::parse_jsonc;
use super::types::{AssetTree, ConvertResult, SourceKind, NATIVE_FORMAT};
use super::util::{ext, has, list_videos, read_text, stem, write_text, CATS};

/// dsh-pet Web 原版 animations 池 → 动画名到分类的映射。
pub fn web_category_map(cfg: &Value) -> HashMap<String, String> {
    let mut m: HashMap<String, String> = HashMap::new();
    let add = |m: &mut HashMap<String, String>, cat: &str, v: Option<&Value>| {
        match v {
            Some(Value::Array(arr)) => {
                for x in arr {
                    // 兼容两种池：字符串数组 ["待机"]，与对象数组 [{name:"待机"}]
                    let name = x.as_str().map(str::to_string)
                        .or_else(|| x.get("name").and_then(|n| n.as_str()).map(str::to_string));
                    if let Some(name) = name { m.entry(name).or_insert_with(|| cat.to_string()); }
                }
            }
            Some(Value::Object(o)) => {
                if let Some(Value::Array(acts)) = o.get("actions") {
                    for z in acts {
                        if let Some(name) = z.get("name").and_then(|n| n.as_str()) {
                            m.entry(name.to_string()).or_insert_with(|| cat.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    };
    let Some(anim) = cfg.get("animations") else { return m; };
    add(&mut m, "idle", anim.get("idle"));
    add(&mut m, "turn", anim.get("turn"));
    add(&mut m, "drag", anim.get("drag"));
    add(&mut m, "click", anim.get("clicks"));
    add(&mut m, "move", anim.get("moves"));
    if let Some(Value::Array(cats)) = anim.get("categories") {
        for c in cats { add(&mut m, "random", c.get("actions")); }
    }
    if let Some(Value::Object(evts)) = anim.get("events") {
        for v in evts.values() { add(&mut m, "events", Some(v)); }
    }
    add(&mut m, "events", anim.get("sleep"));
    add(&mut m, "random", anim.get("baifan"));
    m
}

fn merge_meta(target: &mut Map<String, Value>, src: Option<Value>) {
    if let Some(Value::Object(o)) = src {
        for (k, v) in o { target.entry(k).or_insert(v); }
    }
}

fn val_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(x) => x.to_string(),
        None => String::new(),
    }
}

/// 从 videos/<cat>/... 路径提取一级分类；嵌套子目录（events/balance/）归属一级分类。
fn category_from_path(f: &str) -> String {
    let parts: Vec<&str> = f.split('/').collect();
    for (i, p) in parts.iter().enumerate() {
        if *p == "videos" {
            if let Some(cat) = parts.get(i + 1) {
                if CATS.contains(cat) { return cat.to_string(); }
            }
        }
    }
    String::new()
}

/// 目标缺失时，把源里第一份 wav 复制为 sounds/click.wav。
fn ensure_click_sound(dst: &mut AssetTree, src: &AssetTree) {
    if has(dst, "sounds/click.wav") { return; }
    // 源里有多份 wav 时必须按路径排序取第一份：HashMap 迭代顺序随机，否则同一包转两次结果不同
    let mut wavs: Vec<&String> = src.keys().filter(|p| p.to_lowercase().ends_with(".wav")).collect();
    wavs.sort();
    if let Some(p) = wavs.first() {
        if let Some(data) = src.get(*p) { dst.insert("sounds/click.wav".into(), data.clone()); }
    }
}

fn push(actions: &mut Map<String, Value>, cat: &str, path: &str) {
    let arr = actions.entry(cat.to_string()).or_insert_with(|| Value::Array(vec![]));
    if let Value::Array(a) = arr {
        if !a.iter().any(|v| v.as_str() == Some(path)) {
            a.push(Value::String(path.to_string()));
        }
    }
}

/// 任意源格式 → pixup-pet-asset-v1 字节树。
/// 核心：以源树为基础全量保留（文件夹结构、视频、音效、配方、辅助清单一律不丢），
/// 只做路径规范化（扁平 webm → videos/<cat>/）与 config.json 重写。
pub fn import_to_native(src: AssetTree, opt_id: Option<&str>) -> Result<ConvertResult, String> {
    let kind = detect(&src);
    if kind == SourceKind::Unknown { return Err("未识别的素材格式".into()); }

    let mut dst = src.clone(); // 全量保留源树
    let mut meta = Map::new();
    let mut cat_map: HashMap<String, String> = HashMap::new();

    if kind == SourceKind::WebDsh {
        let cfg_path = if has(&src, "config.jsonc") { "config.jsonc" } else { "assets/config.jsonc" };
        let cfg = read_text(&src, cfg_path).and_then(|s| parse_jsonc(&s))
            .ok_or("无法解析 dsh-pet config.jsonc")?;
        cat_map = web_category_map(&cfg);
        for k in ["name", "prompt", "whisperPrompt", "physics", "font"] {
            if let Some(v) = cfg.get(k) { meta.insert(k.to_string(), v.clone()); }
        }
        if let Some(Value::Array(pets)) = cfg.get("pets") {
            if let Some(first) = pets.first() {
                if let Some(v) = first.get("name") { meta.insert("name".into(), v.clone()); }
                if let Some(sp) = first.get("whisperPrompt").and_then(|v| v.as_str()) {
                    meta.insert("prompt".into(), Value::String(sp.to_string()));
                    meta.insert("persona".into(), json!({ "systemPrompt": sp, "selfTalk": [], "tags": [] }));
                }
            }
        }
    } else {
        for name in ["character.json", "manifest.json", "config.json"] {
            merge_meta(&mut meta, read_text(&src, name).and_then(|s| parse_jsonc(&s)));
        }
        let base = if has(&src, "videos/") { "videos/" } else { "" };
        for name in ["manifest.json", "move_strides.json", "strides.json", "text_clips.json"] {
            merge_meta(&mut meta, read_text(&src, &format!("{base}{name}")).and_then(|s| parse_jsonc(&s)));
        }
    }

    let mut files = list_videos(&src);
    if files.is_empty() { return Err("源目录没有可用视频素材".into()); }
    files.sort(); // 稳定顺序，保证可复现

    let mut actions: Map<String, Value> = match meta.get("actions").and_then(|v| v.as_object()) {
        Some(o) => o.clone(),
        None => Map::new(),
    };

    for f in &files {
        let name = stem(f);
        let e = ext(f);
        let in_videos = f.split('/').enumerate()
            .any(|(i, p)| p == "videos" && f.split('/').nth(i + 2).is_some());
        if kind == SourceKind::WebDsh && !in_videos {
            let mut cat = cat_map.get(&name).cloned().unwrap_or_default();
            if cat.is_empty() {
                for (c, list) in &actions {
                    if let Value::Array(arr) = list {
                        if arr.iter().any(|s| s.as_str().map(|x| x.contains(&name)).unwrap_or(false)) {
                            cat = c.clone();
                            break;
                        }
                    }
                }
            }
            if cat.is_empty() { cat = "random".into(); }
            let rel = format!("videos/{cat}/{name}.{e}");
            if let Some(data) = src.get(f) { dst.insert(rel.clone(), data.clone()); }
            push(&mut actions, &cat, &rel);
            continue;
        }
        let cat = {
            let c = category_from_path(f);
            if c.is_empty() { cat_map.get(&name).cloned().unwrap_or_else(|| "random".into()) } else { c }
        };
        push(&mut actions, &cat, f);
        if cat == "idle_turn" {
            let i = format!("videos/idle/{name}.{e}");
            let t = format!("videos/turn/{name}.{e}");
            if let Some(data) = src.get(f) {
                dst.insert(i.clone(), data.clone());
                dst.insert(t.clone(), data.clone());
            }
            push(&mut actions, "idle", &i);
            push(&mut actions, "turn", &t);
        }
    }

    ensure_click_sound(&mut dst, &src);

    let id_src = opt_id.map(str::to_string).unwrap_or_else(|| {
        for k in ["id", "name"] { if let Some(v) = meta.get(k) { let s = val_string(Some(v)); if !s.is_empty() { return s; } } }
        "pet".into()
    });
    let id = safe_id(&id_src);
    let name = val_string(meta.get("name"));

    let mut cfg = meta;
    cfg.insert("format".into(), Value::String(NATIVE_FORMAT.into()));
    cfg.insert("id".into(), Value::String(id.clone()));
    cfg.insert("name".into(), Value::String(if name.is_empty() { id.clone() } else { name.clone() }));
    cfg.insert("actions".into(), Value::Object(actions));
    if !cfg.contains_key("persona") {
        cfg.insert("persona".into(), json!({
            "systemPrompt": val_string(cfg.get("prompt")), "selfTalk": [], "tags": []
        }));
    }
    if !cfg.contains_key("audio") {
        cfg.insert("audio".into(), json!({ "click": "sounds/click.wav", "clickVolume": 0.7, "throttleMs": 100 }));
    }
    if !cfg.contains_key("media") {
        cfg.insert("media".into(), json!({ "formats": ["webm", "mov"], "safariDir": "videos-mov" }));
    }
    if !cfg.contains_key("recipe") { cfg.insert("recipe".into(), Value::String("recipe.md".into())); }
    write_text(&mut dst, "config.json", &serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?);

    let final_name = val_string(cfg.get("name"));
    Ok(ConvertResult { tree: dst, id, name: final_name, format: NATIVE_FORMAT.into() })
}
