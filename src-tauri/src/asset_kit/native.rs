use super::jsonc::parse_jsonc;
use super::types::{AssetTree, NativePack, NATIVE_FORMAT};
use super::util::read_text;

/// 读取原生包；非 pixup-pet-asset-v1 直接拒绝。
pub fn read_native_pack(tree: AssetTree) -> Result<NativePack, String> {
    let config = read_text(&tree, "config.json")
        .and_then(|s| parse_jsonc(&s))
        .ok_or("不是原生素材格式 pixup-pet-asset-v1")?;
    if config.get("format").and_then(|v| v.as_str()) != Some(NATIVE_FORMAT) {
        return Err("不是原生素材格式 pixup-pet-asset-v1".into());
    }
    let id = config.get("id").and_then(|v| v.as_str()).unwrap_or("pet").to_string();
    let name = config.get("name").and_then(|v| v.as_str()).unwrap_or(&id).to_string();
    Ok(NativePack { id, name, config, tree })
}
