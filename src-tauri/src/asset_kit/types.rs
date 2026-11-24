use serde_json::Value;
use std::collections::HashMap;

pub const NATIVE_FORMAT: &str = "xiaofeiyu-asset-v1";

/// 旧格式名：早期版本写进 `config.json` 的 `format`，导入时仍然按原生格式处理，
/// 不需要用户重导。新写出的包一律使用 [`NATIVE_FORMAT`]。
pub const LEGACY_FORMATS: &[&str] = &["pixup-pet-asset-v1"];

/// 判断某个 `format` 字符串是否属于本国原生格式（含旧名）。
pub fn is_native_format(s: &str) -> bool { s == NATIVE_FORMAT || LEGACY_FORMATS.contains(&s) }

/// 相对路径（/ 分隔）→ 字节。转换库内部统一交换单元，不经过 base64/IPC。
pub type AssetTree = HashMap<String, Vec<u8>>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SourceKind { Native, DesktopLegacy, WebDsh, Unknown }

impl SourceKind {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::DesktopLegacy => "desktop-legacy",
            Self::WebDsh => "web-dsh",
            Self::Unknown => "unknown",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Native => "xiaofeiyu-asset-v1（原生格式）",
            Self::DesktopLegacy => "dsh-pet-indesktop（桌面版旧格式）",
            Self::WebDsh => "dsh-pet（Web 原版）",
            Self::Unknown => "未识别",
        }
    }
}

pub struct SourceInfo { #[allow(dead_code)] pub kind: SourceKind, pub label: &'static str }
pub struct NativePack { #[allow(dead_code)] pub id: String, pub name: String, pub config: Value, pub tree: AssetTree }
pub struct ConvertResult { pub tree: AssetTree, pub id: String, pub name: String, pub format: String }
pub struct DshExport { pub root: String, pub tree: AssetTree }
