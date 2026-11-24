use super::jsonc::parse_jsonc;
use super::types::{AssetTree, SourceInfo, SourceKind, NATIVE_FORMAT};
use super::util::{has, read_text};

pub fn detect(tree: &AssetTree) -> SourceKind {
    if has(tree, "config.json") {
        if let Some(cfg) = read_text(tree, "config.json").and_then(|s| parse_jsonc(&s)) {
            if cfg.get("format").and_then(|v| v.as_str()) == Some(NATIVE_FORMAT) {
                return SourceKind::Native;
            }
        }
    }
    if has(tree, "config.jsonc") || has(tree, "assets/config.jsonc") { return SourceKind::WebDsh; }
    if has(tree, "character.json") || has(tree, "manifest.json") || has(tree, "config.json")
        || tree.keys().any(|p| p.starts_with("videos/")) {
        return SourceKind::DesktopLegacy;
    }
    SourceKind::Unknown
}

pub fn detect_source(tree: &AssetTree) -> SourceInfo {
    let kind = detect(tree);
    SourceInfo { label: kind.label(), kind }
}
