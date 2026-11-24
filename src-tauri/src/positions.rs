// 桌宠坐标独立存储：positions.json 是坐标唯一真相源，与偏好配置 config.json 分离。
// 运行时权威坐标在 Rust 内存 AppState.cfg，前端拖动只更新内存；防抖 / 退出 / 关窗才落盘。
use crate::config::{self, Config};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

/// 单只宠物的坐标：壁纸层 x/y、浮层 ox/oy。用 Option 区分「未落过位」。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PetPos {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub ox: Option<f64>,
    pub oy: Option<f64>,
}

/// 全量坐标表：pet id → 坐标。BTreeMap 保证落盘顺序稳定，便于 diff / 阅读。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Positions {
    pub pets: BTreeMap<String, PetPos>,
}

pub fn file(root: &Path) -> std::path::PathBuf { root.join("positions.json") }

pub fn load(root: &Path) -> Positions {
    // 磁盘结构是 { "pets": { "<id>": {...} } }，必须先取 pets 层再遍历，
    // 否则会把顶层 key "pets" 当成宠物 id 反序列化成全 None，导致所有坐标加载失败。
    config::read_json(&file(root))
        .get("pets")
        .and_then(|v| v.as_object())
        .map(|o| Positions {
            pets: o.iter()
                .filter_map(|(id, v)| serde_json::from_value::<PetPos>(v.clone()).ok().map(|p| (id.clone(), p)))
                .collect(),
        })
        .unwrap_or_default()
}

/// 原子写坐标表（先 .tmp 再 rename），与 config::save 同款防损策略。
pub fn save(root: &Path, pos: &Positions) -> Result<(), String> {
    let value = serde_json::to_value(pos).map_err(|e| e.to_string())?;
    config::write_json(&file(root), &value)
}

/// 从内存 cfg 提取坐标表。
pub fn from_cfg(cfg: &Config) -> Positions {
    Positions {
        pets: cfg.pets.iter().map(|p| {
            (p.id.clone(), PetPos { x: Some(p.x), y: Some(p.y), ox: p.ox, oy: p.oy })
        }).collect(),
    }
}

/// 把坐标表写回 cfg.pets（仅同 id），缺省坐标（-1）保留 incoming 不动。
pub fn apply(pos: &Positions, cfg: &mut Config) {
    for p in &mut cfg.pets {
        if let Some(saved) = pos.pets.get(&p.id) {
            if let Some(x) = saved.x { p.x = x; }
            if let Some(y) = saved.y { p.y = y; }
            if saved.ox.is_some() { p.ox = saved.ox; }
            if saved.oy.is_some() { p.oy = saved.oy; }
        }
    }
}

/// 启动迁移：首次运行（positions.json 不存在）时，把老 config.json 里的坐标
/// 抽出来落一份独立文件，之后 config.json 不再承载坐标。
pub fn migrate_from_config(root: &Path, cfg: &Config) {
    if file(root).exists() { return; }
    let _ = save(root, &from_cfg(cfg));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_reads_nested_pets_map() {
        // 覆盖真实落盘结构 { "pets": { id: {...} } }：必须取到嵌套 id，不能把 "pets" 当 id。
        let dir = std::env::temp_dir().join(format!("pet_pos_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let body = r#"{"pets":{"a":{"x":311.0,"y":411.0,"ox":111.0,"oy":211.0},"b":{"x":1.0}}}"#;
        let _ = std::fs::write(file(&dir), body);
        let pos = load(&dir);
        assert_eq!(pos.pets.len(), 2, "应读出两只宠物，而非顶层 pets 一个键");
        let a = &pos.pets["a"];
        assert_eq!((a.x, a.y, a.ox, a.oy), (Some(311.0), Some(411.0), Some(111.0), Some(211.0)));
        assert_eq!(pos.pets["b"].x, Some(1.0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn from_cfg_keeps_both_layers() {
        let mut cfg = Config::default();
        let mut p = cfg.pets[0].clone();
        p.id = "a".into(); p.x = 10.0; p.y = 20.0; p.ox = Some(30.0); p.oy = Some(40.0);
        cfg.pets = vec![p];
        let pos = from_cfg(&cfg);
        let saved = &pos.pets["a"];
        assert_eq!((saved.x, saved.y), (Some(10.0), Some(20.0)));
        assert_eq!((saved.ox, saved.oy), (Some(30.0), Some(40.0)));
    }

    #[test]
    fn apply_overwrites_saved_only() {
        let mut cfg = Config::default();
        let mut p = cfg.pets[0].clone();
        p.id = "a".into(); p.x = -1.0; p.y = -1.0; p.ox = None; p.oy = None;
        cfg.pets = vec![p];
        let mut pos = Positions::default();
        pos.pets.insert("a".into(), PetPos { x: Some(5.0), y: None, ox: Some(7.0), oy: None });
        apply(&pos, &mut cfg);
        assert_eq!((cfg.pets[0].x, cfg.pets[0].y), (5.0, -1.0), "只覆盖已保存的字段");
        assert_eq!((cfg.pets[0].ox, cfg.pets[0].oy), (Some(7.0), None));
    }
}
