#!/usr/bin/env python3
# 构建期：离线安装「小肥鱼宠物 v1.1.0」的 9 位角色（其它 8 位 + 已有 shenshen）。
# 运行时不联网。用法：python scripts/install-xiaoxiao.py
# 依赖：.research/dl/xiaoxiao-tree.json（GitHub 仓库树）、xiaoxiao2-update.zip（v1.1.0 更新包）；
#       缺树时自动拉 API；缺更新包时自动下载。素材先下到 .research/dl/xiaoxiao-src 缓存，
#       再用 ffmpeg 规范化为 640x360 / CRF28 / 保留 alpha，最后写入 src-tauri/resources/characters。
import concurrent.futures as cf
import json
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
DL = ROOT / '.research' / 'dl'
CACHE = DL / 'xiaoxiao-src'
OUT = ROOT / 'src-tauri' / 'resources' / 'characters'
TREE = DL / 'xiaoxiao-tree.json'
UPDATE = DL / 'xiaoxiao2-update.zip'
REPO = 'yshuang722-spec/xiaoxiao-zhuochong'
BRANCH = 'main'
RAW = f'https://raw.githubusercontent.com/{REPO}/{BRANCH}/'
UPDATE_URL = f'https://github.com/{REPO}/releases/download/xiaoxiao2-v1.1.0/xiaoxiao2-update-v1.1.0.zip'

# 顺序与官方 README「九个角色」一致；shenshen 已内置，跳过。
GIT = [
    ('ojousama', '橙毛大小姐', '#e8974a', 320),
    ('character3', '黄毛该溜子', '#c7a06a', 280),
    ('character4', '白毛小龙娘', '#b49bd4', 320),
    ('character5', '黑毛小狐狸', '#5b5b68', 300),
    ('character6', '奶茶千金', '#7fa8d8', 300),
]
NEW = [
    ('character11', '北美大豆包', '#8b7ad0', 600),
    ('character12', '豆小妹', '#c76a5a', 590),
    ('character13', '中二少女', '#9a8fd0', 590),
]
BOXES = {
    'main': (.3042, .163, .6833, .9185), 'ojousama': (.3292, .1704, .6667, .9185),
    'character3': (.2583, .1259, .7375, .8815), 'character4': (.3, .1333, .7333, .8815),
    'character5': (.3125, .1185, .6958, .8815), 'character6': (.2875, .2722, .7042, .8944),
    'character11': (.325, .2722, .6667, .8944), 'character12': (.2708, .2667, .7208, .9),
    'character13': (.2792, .2556, .7125, .9),
}


def sh(*args, quiet=True):
    return subprocess.run(args, check=True,
                          stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL if quiet else None)


def curl(url, dst):
    if dst.is_file() and dst.stat().st_size > 0:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + '.part')
    sh('curl', '-fsSL', '--ssl-no-revoke', '--retry', '2', '--connect-timeout', '20',
       '--max-time', '300', '-o', str(tmp), url)
    tmp.replace(dst)


def fetch_tree():
    if not TREE.is_file():
        curl(f'https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1', TREE)
    return json.loads(TREE.read_text('utf-8'))['tree']


def get_ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return 'ffmpeg'


def fix_name(n):
    try:
        return n.encode('cp437').decode('gbk')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return n


def source_config(cid, src):
    for p in [src / 'config.json', src / 'config.jsonc']:
        if not p.is_file():
            continue
        try:
            return json.loads(p.read_text('utf-8-sig').replace('\r', ''))
        except Exception:
            pass
    return None


def actions_of(cid, names, cfg):
    """按官方 config.json 的动作池，把同名动画分配到引擎的 7 个分类。"""
    n = lambda xs: [f'videos/random/{x}.webm' for x in xs if x in names]
    if not cfg:
        idle = ['待机观望'] if '待机观望' in names else names[:1]
        clicks = [x for x in names if x not in idle][:5]
        return {'idle': n(idle), 'turn': n(idle), 'drag': n(idle),
                'click': n(clicks), 'move': [], 'random': n(names), 'events': []}
    a = cfg.get('animations', {})
    move = [x.get('name') for x in a.get('moves', {}).get('actions', []) if isinstance(x, dict)]
    random = []
    for c in a.get('categories', []):
        random += c.get('actions', [])
    events = []
    for v in a.get('events', {}).values():
        events += v if isinstance(v, list) else []
    return {
        'idle': n(a.get('idle', [])), 'turn': n(a.get('turn', [])),
        'drag': n(a.get('drag', [])), 'click': n(a.get('clicks', [])),
        'move': n(move), 'random': n(list(dict.fromkeys(names))),
        'events': n(list(dict.fromkeys(events))),
        '_noMirror': [x for c in a.get('categories', []) if c.get('noMirror') for x in c.get('actions', [])],
    }


def main():
    tree = fetch_tree()
    if not UPDATE.is_file():
        print('下载 v1.1.0 更新包…')
        curl(UPDATE_URL, UPDATE)

    ffmpeg = get_ffmpeg()
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    # 1) 下载 git 中的 5 位角色 + 解出更新包里的 3 位角色
    jobs = []
    for cid, *_ in GIT:
        for item in tree:
            p = item['path']
            if not p.startswith(f'characters/{cid}/') or not p.endswith('.webm'):
                continue
            name = Path(p).name
            jobs.append((RAW + quote(p, safe='/'), CACHE / cid / 'animations' / name))
    for cid, *_ in GIT:
        for f in ('config.json', 'config.jsonc'):
            if any(x['path'] == f'characters/{cid}/{f}' for x in tree):
                jobs.append((RAW + f'characters/{cid}/{f}', CACHE / cid / f))
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda j: curl(*j), jobs))
    print(f'下载完成：{len(jobs)} 个文件')

    if UPDATE.is_file():
        ids = {c[0] for c in NEW}
        with zipfile.ZipFile(UPDATE) as z:
            for i in z.infolist():
                n = fix_name(i.filename)
                parts = n.split('/')
                cid = next((x for x in parts if x in ids), None)
                if not cid or not n.endswith(('.webm', '.json', '.jsonc')):
                    continue
                if n.endswith('.webm') and 'animations' not in parts:
                    continue
                dst = (CACHE / cid / 'animations' / parts[-1]) if n.endswith('.webm') else (CACHE / cid / parts[-1])
                if dst.is_file() and dst.stat().st_size == i.file_size:
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(z.read(i))

    # 2) 规范化 + 生成 character.json
    total = 0
    for cid, name, theme, size in GIT + NEW:
        src = CACHE / cid
        anims = sorted((src / 'animations').glob('*.webm'))
        if not anims:
            print(f'! 跳过 {cid}：没有素材')
            continue
        names = [p.stem for p in anims]
        cfg = source_config(cid, src)
        acts = actions_of(cid, names, cfg)
        no_mirror = acts.pop('_noMirror', None) or names
        dst = OUT / cid / 'videos' / 'random'
        dst.mkdir(parents=True, exist_ok=True)

        def transcode(p):
            out = dst / p.name
            if out.is_file() and out.stat().st_size > 0:
                return
            tmp = out.with_name(out.stem + '.tmp.webm')  # 保留 .webm 扩展名，ffmpeg 才能推断容器
            vf = ('scale=640:360:force_original_aspect_ratio=decrease:flags=lanczos,'
                  'pad=640:360:(ow-iw)/2:(oh-ih)/2:color=#00000000,format=yuva420p')
            sh(ffmpeg, '-hide_banner', '-nostdin', '-y', '-v', 'error', '-c:v', 'libvpx-vp9',
               '-i', str(p), '-vf', vf, '-c:v', 'libvpx-vp9', '-auto-alt-ref', '0',
               '-pix_fmt', 'yuva420p', '-row-mt', '1', '-b:v', '0', '-crf', '28',
               '-alpha_mode', '1', '-metadata:s:v:0', 'alpha_mode=1', '-an', str(tmp))
            tmp.replace(out)
        with cf.ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(transcode, anims))

        b = BOXES.get(cid, (.3, .15, .7, .9))
        box = [round(b[0] * 640), round(b[1] * 360), round(b[2] * 640), round(b[3] * 360)]
        head = [box[0], box[1], box[2], box[1] + round((box[3] - box[1]) * .45)]
        meta = {
            'id': cid, 'name': name, 'theme': theme, 'canvas': [640, 360],
            'feetY': box[3], 'fps': 24, 'scale': round(size / 640, 3),
            'bodyBox': box, 'headBox': head, 'noMirror': list(dict.fromkeys(no_mirror)),
            'actions': acts,
        }
        (OUT / cid / 'character.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2), 'utf-8')
        total += len(anims)
        print(f'{cid:12s} {name:6s} {len(anims):3d} 段  {sum((dst / f"{x}.webm").stat().st_size for x in names) / 1048576:.1f} MiB')
    main_meta = OUT / 'shenshen' / 'character.json'
    if (OUT / 'shenshen').is_dir() and not main_meta.is_file():
        main_meta.write_text(json.dumps({'id': 'shenshen', 'name': '蓝毛小女仆', 'theme': '#6f8fd0'},
                                      ensure_ascii=False, indent=2), 'utf-8')

    print(f'\n完成：新增 8 位角色 / {total} 段动画；已有 shenshen 106 段保留，合计 9 位。')
    print('重新执行 npm run build:nsis / build:portable 即可打进安装包。')


if __name__ == '__main__':
    sys.exit(main())
