use super::types::AssetTree;

pub const VIDEO_EXT: &[&str] = &["webm", "mp4", "m4v", "mov", "gif", "apng", "png", "webp"];
pub const CATS: &[&str] = &["idle", "turn", "idle_turn", "move", "click", "drag", "random", "events"];

pub fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_start_matches("./").trim_start_matches('/').to_string()
}
pub fn has(t: &AssetTree, p: &str) -> bool { t.contains_key(&norm(p)) }
pub fn read_text(t: &AssetTree, p: &str) -> Option<String> {
    t.get(&norm(p)).and_then(|b| String::from_utf8(b.clone()).ok())
}
pub fn write_text(t: &mut AssetTree, p: &str, s: &str) { t.insert(norm(p), s.as_bytes().to_vec()); }
pub fn ext(p: &str) -> String {
    let n = p.rsplit('/').next().unwrap_or(p);
    n.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default()
}
pub fn stem(p: &str) -> String {
    let n = p.rsplit('/').next().unwrap_or(p);
    n.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| n.to_string())
}
pub fn is_video(p: &str) -> bool { VIDEO_EXT.contains(&ext(p).as_str()) }
pub fn list_videos(t: &AssetTree) -> Vec<String> { t.keys().filter(|p| is_video(p)).cloned().collect() }
