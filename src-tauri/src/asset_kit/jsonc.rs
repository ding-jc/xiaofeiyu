use serde_json::Value;

/// 去 JSONC 的 // 与 /* */ 注释，保留字符串内的斜杠。
pub fn strip_jsonc(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let (mut i, mut in_str, mut esc) = (0usize, false, false);
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if esc { esc = false; }
            else if c == b'\\' { esc = true; }
            else if c == b'"' { in_str = false; }
            i += 1;
            continue;
        }
        if c == b'"' { in_str = true; out.push(c); i += 1; continue; }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' { i += 1; }
            if i < b.len() { out.push(b'\n'); }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') { i += 1; }
            i = (i + 2).min(b.len());
            continue;
        }
        out.push(c);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_jsonc(s: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(&strip_jsonc(s)).ok()?;
    if v.is_object() { Some(v) } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strips_comments_but_keeps_string_slashes() {
        let raw = r##"{ "a": "http://x/y", // note
        /* block */ "b": 2 }"##;
        let v = parse_jsonc(raw).unwrap();
        assert_eq!(v["a"], "http://x/y");
        assert_eq!(v["b"], 2);
    }
}
