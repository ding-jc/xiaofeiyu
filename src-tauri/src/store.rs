// 每宠独立档案 + 本地数据文件（待办 / 菜单布局 / 快捷启动 / 自言自语文案）。
use crate::config;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn safe(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .take(80)
        .collect()
}

pub fn data_file(root: &PathBuf, name: &str) -> PathBuf {
    root.join(format!("{}.json", safe(name)))
}

pub fn slot_file(root: &PathBuf, id: &str) -> PathBuf {
    root.join(format!("config-slot-{}.json", safe(id)))
}

/// 列出所有已存在的每宠档案（原项目 config-slot-N.json 布局）。
pub fn list_slots(root: &PathBuf) -> Value {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(root) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if let Some(rest) = n.strip_prefix("config-slot-").and_then(|x| x.strip_suffix(".json")) {
                out.push(json!({ "id": rest, "profile": config::read_json(&e.path()) }));
            }
        }
    }
    out.sort_by(|a, b| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")));
    Value::Array(out)
}

pub fn remove_slot(root: &PathBuf, id: &str) {
    let p = slot_file(root, id);
    if p.starts_with(root) { let _ = fs::remove_file(p); }
}

/// 内置本地文案：自言自语、点击台词、节日、抽签、快捷启动示例。
pub fn builtin(name: &str) -> Value {
    match name {
        "self_talk_texts" => json!([
            "今天也要好好吃饭呀～", "摸鱼一时爽，一直摸鱼一直爽。",
            "要不要起来动一动？", "我在壁纸里看着你哦。",
            "伸个懒腰吧，坐久了对腰不好。", "窗外的天色变了吗？",
            "主人今天也很努力呢。", "记得喝水哦～",
            "要不要听我讲个冷笑话？", "别熬夜，鲸鱼会担心的。",
            "这个 bug 一定能修好的。", "休息一下也没关系。"
        ]),
        "click_phrases" => json!([
            "哎呀！", "别戳我～", "痒痒的！", "干嘛呀？", "嘿嘿～",
            "再来一次！", "我在这儿呢。", "咕噜咕噜～"
        ]),
        "divination" => json!({
            "levels": ["大吉", "中吉", "小吉", "吉", "末吉", "凶", "大凶"],
            "lines": [
                "今日宜摸鱼，万事顺遂。", "有一桩小惊喜正在路上。",
                "适合把拖了很久的事做完。", "记得给重要的人发条消息。",
                "宜早睡，忌硬撑。", "转角会遇到好消息。",
                "慢一点，反而更快。", "今天是适合开始新计划的日子。",
                "别急着下结论。", "会有贵人相助。"
            ]
        }),
        "festival" => json!({
            "01-01": "新年快乐！今年也请多多关照～",
            "02-14": "今天记得对自己好一点哦。",
            "05-01": "劳动节快乐，辛苦啦！",
            "06-01": "儿童节快乐，今天可以理直气壮地玩！",
            "10-01": "国庆快乐，出去走走吧～",
            "12-25": "圣诞快乐！要不要来块蛋糕？"
        }),
        _ => Value::Null,
    }
}
