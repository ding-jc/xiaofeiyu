// 全局配置：少量强类型键用于 Rust 侧判定，其余原版键透传（extra）。
// 每宠独立档案存 config-slot-N.json，由 store.rs 管理。
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{fs, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PetConfig {
    pub id: String,
    pub character: String,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub facing: String,
    pub visible: bool,
    /// 每宠档案（原项目 config-slot-N.json 的等价内容），前端定义结构。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<Value>,
    /// 该槽位在哪些层显示：{ "wallpaper": bool, "overlay": bool }
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layers: Option<Value>,
    /// 浮层坐标（壁纸层仍用 x/y；两层各自记位置）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ox: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oy: Option<f64>,
}

impl Default for PetConfig {
    fn default() -> Self {
        Self {
            id: "0".into(), character: "shenshen".into(), x: -1.0, y: -1.0,
            scale: 0.72, facing: "left".into(), visible: true, profile: None,
            layers: Some(json!({ "wallpaper": false, "overlay": true })), ox: None, oy: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub version: u32,
    pub pets: Vec<PetConfig>,
    pub wallpaper_mode: bool,
    pub interactive: bool,
    pub mouse_through: bool,
    pub cover_all_monitors: bool,
    pub auto_hide_fullscreen: bool,
    pub quiet_until: f64,
    /// 层级显示开关（主界面「显示/隐藏」按层区分）
    pub wallpaper_visible: bool,
    pub overlay_visible: bool,
    /// 浮层鼠标穿透：整层不接收鼠标（逐像素穿透另由 WM_NCHITTEST 处理）
    pub overlay_mouse_through: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 2,
            pets: vec![PetConfig::default()],
            wallpaper_mode: false,
            interactive: true,
            mouse_through: false,
            cover_all_monitors: false,
            auto_hide_fullscreen: true,
            quiet_until: 0.0,
            wallpaper_visible: true,
            overlay_visible: true,
            overlay_mouse_through: false,
            extra: Map::new(),
        }
    }
}

impl Config {
    /// 缺省层级：壁纸功能关闭时老配置落到浮层，避免桌宠消失。
    pub fn in_overlay(&self, p: &PetConfig) -> bool {
        p.layers.as_ref().and_then(|l| l.get("overlay")).and_then(Value::as_bool)
            .unwrap_or(!self.wallpaper_mode)
    }
    pub fn get(&self, key: &str) -> Option<&Value> { self.extra.get(key) }
    pub fn flag(&self, key: &str, default: bool) -> bool {
        self.extra.get(key).and_then(Value::as_bool).unwrap_or(default)
    }
    pub fn number(&self, key: &str, default: f64) -> f64 {
        self.extra.get(key).and_then(Value::as_f64).unwrap_or(default)
    }
    pub fn text(&self, key: &str, default: &str) -> String {
        self.extra.get(key).and_then(Value::as_str).unwrap_or(default).to_string()
    }
}

pub fn file(root: &Path) -> std::path::PathBuf { root.join("config.json") }

pub fn load(root: &Path) -> Config {
    fs::read_to_string(file(root))
        .ok()
        .and_then(|s| serde_json::from_str::<Config>(&s).ok())
        .unwrap_or_default()
}

/// 写偏好配置。坐标已独立到 positions.json，这里落盘前剥离每宠的 x/y/ox/oy，
/// 杜绝三份 cfg 整份写回互相踩踏坐标（旧版位置反复丢失的根因）。内存 cfg 不动。
pub fn save(root: &Path, cfg: &Config) -> Result<(), String> {
    let p = file(root);
    let tmp = p.with_extension("json.tmp");
    let mut value = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
    if let Some(pets) = value.get_mut("pets").and_then(Value::as_array_mut) {
        for pet in pets.iter_mut() {
            if let Some(obj) = pet.as_object_mut() {
                obj.remove("x"); obj.remove("y"); obj.remove("ox"); obj.remove("oy");
            }
        }
    }
    let body = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// 原子写任意数据文件（待办、菜单布局、每宠档案等）。
pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn read_json(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null)
}
