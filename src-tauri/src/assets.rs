// pet:// 自定义协议：本地视频/JSON 直读，完整支持 HTTP Range（WebM 拖拽与解码必需）。
use crate::AppState;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};
use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Manager, UriSchemeResponder,
};

pub fn handle(app: &AppHandle, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = app.clone();
    let raw = req.uri().path().to_string();
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    std::thread::spawn(move || {
        let resp = serve(&app, &raw, range.as_deref()).unwrap_or_else(|e| {
            Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(e.into_bytes())
                .unwrap()
        });
        responder.respond(resp);
    });
}

fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "webm" => "video/webm",
        "mp4" | "m4v" | "mov" => "video/mp4",
        "gif" => "image/gif",
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "json" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn resource_root(app: &AppHandle) -> PathBuf {
    let r = app.path().resource_dir().unwrap_or_default();
    if r.join("sounds").is_dir() || r.join("characters").is_dir() {
        r
    } else if r.join("resources/sounds").is_dir() || r.join("resources/characters").is_dir() {
        r.join("resources")
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
    }
}

fn resolve(app: &AppHandle, token: &str, rest: &[&str]) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let base: PathBuf = match token {
        "b" => state.roots.builtin.clone(),
        "u" => state.roots.user.clone(),
        "d" => state.roots.data.clone(),
        "r" => resource_root(app),
        t if t.starts_with("e-") => {
            let id = &t[2..];
            let list = state.external.read().map_err(|_| "external lock".to_string())?;
            let e = list.iter().find(|x| x.id == id).ok_or_else(|| format!("未知外部素材包 {id}"))?;
            let p = PathBuf::from(&e.path);
            p.parent().unwrap_or(&p).to_path_buf()
        }
        _ => return Err(format!("未知资源根 {token}")),
    };
    if rest.iter().any(|s| *s == ".." || *s == "." || s.contains('\\')) {
        return Err("非法路径".into());
    }
    let mut out = base.clone();
    for s in rest {
        if Path::new(s).components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
            return Err("非法路径".into());
        }
        out.push(s);
    }
    let canon = out.canonicalize().map_err(|e| format!("{}: {e}", out.display()))?;
    let root = base.canonicalize().unwrap_or(base);
    if !canon.starts_with(&root) { return Err("越权访问".into()); }
    if !canon.is_file() { return Err("不是文件".into()); }
    Ok(canon)
}

fn read_range(path: &Path, range: Option<&str>) -> Result<Response<Vec<u8>>, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let ctype = mime(path);
    if len == 0 {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, ctype)
            .header(header::CONTENT_LENGTH, "0")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .map_err(|e| e.to_string());
    }
    let (start, end, partial) = match range {
        Some(r) => {
            let spec = r.strip_prefix("bytes=").unwrap_or(r);
            let mut it = spec.splitn(2, '-');
            let a = it.next().unwrap_or("").trim();
            let b = it.next().unwrap_or("").trim();
            if a.is_empty() {
                let n = b.parse::<u64>().unwrap_or(0).min(len);
                (len - n, len - 1, true)
            } else {
                let s = a.parse::<u64>().unwrap_or(0).min(len - 1);
                let e = if b.is_empty() { len - 1 } else { b.parse::<u64>().unwrap_or(len - 1).min(len - 1) };
                (s, e.max(s), true)
            }
        }
        None => (0, len - 1, false),
    };
    let count = end - start + 1;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; count as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;

    let mut b = Response::builder()
        .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, ctype)
        .header(header::CONTENT_LENGTH, count.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=3600");
    if partial {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    b.body(buf).map_err(|e| e.to_string())
}

fn serve(app: &AppHandle, raw: &str, range: Option<&str>) -> Result<Response<Vec<u8>>, String> {
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .to_string();
    let mut parts = decoded.split('/').filter(|s| !s.is_empty());
    let token = parts.next().ok_or("空资源路径")?;
    let rest: Vec<&str> = parts.collect();
    if rest.is_empty() { return Err("空资源路径".into()); }
    let file = resolve(app, token, &rest)?;
    read_range(&file, range)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn range_response_is_206_with_correct_bytes() {
        let p = std::env::temp_dir().join("pixup-pet-protocol-test.bin");
        fs::write(&p, b"0123456789").unwrap();
        let r = read_range(&p, Some("bytes=2-5")).unwrap();
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "4");
        assert_eq!(r.body(), b"2345");

        let full = read_range(&p, None).unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body().len(), 10);
        assert_eq!(full.headers()[header::CONTENT_TYPE], "application/octet-stream");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn webm_mime_is_video() {
        assert_eq!(mime(Path::new("a/b/待机.webm")), "video/webm");
    }
}
