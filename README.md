<div align="center">
  <img src="https://xiaofeiyu.2096450462.workers.dev/cover.jpg" alt="小肥鱼宠物" width="168" />
</div>

<h1 align="center">小肥鱼宠物 · xiaofeiyu</h1>

<p align="center">
Windows 桌面宠物：透明置顶浮层渲染 640×360 透明 WebM，逐像素命中，<br />
素材全本地，支持导入/导出 <a href="https://github.com/PC2005-cloud/dsh-pet">dsh-pet</a> 素材。
</p>

<div align="center">
  <img src="https://xiaofeiyu.2096450462.workers.dev/banner.jpg" alt="小肥鱼宠物" width="100%" />
</div>

<p align="center">
  <a href="https://github.com/ding-jc/xiaofeiyu/actions/workflows/build-windows.yml">
    <img src="https://github.com/ding-jc/xiaofeiyu/actions/workflows/build-windows.yml/badge.svg" alt="build-windows" />
  </a>
</p>

---

## 这是什么

一个用 **Tauri 2 + WebView2 + Vue 3** 写的 Windows 桌面宠物。它把角色的待机动画当视频播在
一层透明置顶窗上，只有角色本体的像素会挡住鼠标，其余区域完全穿透——可以正常框选桌面、
拖动快捷方式、右键点桌面。

不需要账号，不上传任何数据，默认不联网。

## 特性

- **透明浮层 + 逐像素命中**：点穿透明区，只有身体挡鼠标；遮挡感与真窗口一致。
- **多角色 / 分身 / 换装**：同一角色可开多个分身，位置各自记忆。
- **一条源文件格式**：[`xiaofeiyu-asset-v1`](素材资产格式规范.md)——目录即分类，清单只声明用哪些文件。
- **与 dsh-pet 双向兼容**：`config.jsonc`（Web 原版）与 `character.json`+`videos/`（桌面版）
  都能直接导入；也能一键导出成 dsh 插件（ZIP 或直接写入 `~/.dsh/dsh-pet/pet/`）。
- **右键菜单 / 托盘菜单**：与主界面同一套图标与圆角面板，无窗口阴影。
- **灵动岛指标、待办提醒、开机自启**：都是本地实现，无云依赖。
- **小**：无 Electron，安装包以十 MB 计。

## 下载与分支

- **发布版**：[GitHub Releases](https://github.com/ding-jc/xiaofeiyu/releases)——Windows 安装包由 CI 自动构建，仅 Windows。
- **分支**：`main` = 生产（对外发布），`dev` = 开发（日常提交、PR 目标）。打 `v*` tag 触发自动打包并生成 draft release。
- 仓库**不收录角色素材**（113 MB、授权独立）：安装后用「添加角色」导入自己的包，或在本地
  `npm run assets` 拉取素材后再构建。

## 平台与限制

| 项 | 说明 |
|---|---|
| 系统 | **仅 Windows 10 / 11**（x64）。macOS / Linux 暂无版本。 |
| 运行时 | 需要 WebView2 Runtime，Windows 10/11 多数已自带，缺失时安装器会引导。 |
| 透明穿透 | 浮层透明区域不拦截鼠标；点击角色本体才交互。 |
| 多显示器混合缩放 | 不同屏用不同缩放比例时，建议只用一张全屏浮层，避免跨屏缩放错位。 |
| 异常退出 | 直接强杀进程可能残留不可见窗口；请从托盘菜单正常退出。 |
| 画面能力 | 只做「看」与「点」：**不含 AI 对话、语音、聊天**。 |

## 快速开始

### 环境

- Windows 10/11 x64
- [Node.js](https://nodejs.org/) ≥ 20
- Rust ≥ 1.93 + MSVC 工具链（Visual Studio Build Tools，勾选「使用 C++ 的桌面开发」）

### 开发

```bash
npm install
npm run dev:app        # 起 vite + tauri dev，改前端热更新、改 Rust 自动重编
```

想看右键菜单/浮层的自动化检查，先带调试口启动，再跑冒烟：

```bash
# PowerShell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"; npm run dev:app
# 另开一个终端
npm run smoke          # 36 项端到端检查（DOM + IPC 实际返回值）
```

### 构建

```bash
npm run build:nsis     # NSIS 安装包 → src-tauri/target/release/bundle/nsis/
npm run build:portable # 便携版（解压即用）
```

### 其他脚本

| 命令 | 作用 |
|---|---|
| `npm run assets` | 从上游仓库拉取角色素材到 `src-tauri/resources/characters/` |
| `npm run assets:xiaoxiao` | 安装「小小」角色包（需要 Python） |
| `npm run icons` | 由 `lucide-static` 重新生成 `src/data/icons.ts` |
| `cargo test --lib`（在 `src-tauri/`） | 格式转换、扫描、解压、深链导入的单测 |

## 目录结构

```
pet-app/
├─ src/                     前端（浮层 / 设置窗 / 菜单窗 / 待办）
│  ├─ pet/                  浮层世界：引擎、角色、行为、右键菜单模型
│  ├─ ui/                   设置界面（Vue）与原生控件
│  ├─ data/                 Lucide 图标表、动作注册表、默认配置
│  └─ assets/fonts/         内置字体（荆南麦圆体，OFL-1.1）
├─ src-tauri/
│  ├─ src/                  窗口编排、浮层命中原生窗、托盘、菜单窗、素材扫描
│  │  └─ asset_kit/         源文件格式转换（探测 / 导入 / 导出 dsh）
│  └─ resources/            随包素材：characters/ 与 sounds/
├─ docs/                    制作配方与文档配图
├─ scripts/                 素材拉取、图标生成、便携版打包、冒烟测试
├─ 素材资产格式规范.md       源文件格式的唯一权威说明
└─ THIRD_PARTY_NOTICES.md   素材与依赖的许可声明
```

## 素材格式：一条格式

所有素材统一为 `xiaofeiyu-asset-v1`：**一个目录 + 一份 `config.json`**，视频放
`videos/<分类>/`，目录名即分类。

```jsonc
{
  "format": "xiaofeiyu-asset-v1",
  "id": "mycat", "name": "我的猫", "theme": "#e8974a",
  "canvas": [640, 360], "scale": 0.72,
  "bodyBox": [200, 50, 440, 335], "headBox": [200, 50, 440, 167],
  "actions": { "idle": ["videos/idle/待机呼吸.webm"] }
}
```

分类、字段含义（含"哪些字段运行时会读、哪些只是元数据"）、编码规格、以及
与 dsh-pet 的逐项映射，全部见 **[素材资产格式规范](素材资产格式规范.md)**。

## 制作自己的桌宠

从一段提示词到可导入的素材包，完整流程（含绿幕提示词库、抠像转码参数、校验清单）见
**[桌宠制作配方](docs/RECIPE.md)**。应用内「设置 → 制作配方」也能直接看这份文档。

## 导入与导出

| 场景 | 做法 |
|---|---|
| 导入文件夹 | 主界面「添加角色」→ 选含 `config.json` 的目录 |
| 导入 zip | 把 `<角色id>/` 打成 zip，拖进主界面窗口 |
| 导入 dsh 素材 | 直接选 dsh 的目录/zip，自动识别并转成本格式，原文件全量保留 |
| 在线导入 | 点 `video-json-pet://import?url=<清单地址>` 深链 |
| 导出 dsh | 角色卡片「导出 dsh」得 zip，「写入 dsh」直接落到 `~/.dsh/dsh-pet/pet/` |

## 许可

- **代码与文档**：[MIT](LICENSE)
- **随包素材**（动画 / 音效 / 字体 / 图标）遵循各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
  素材版权归原作者所有，**请勿用于商业用途**。

## 致谢

- [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) —— Web 原版，素材源头
- [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) —— 桌面移植版，交互与几何的行为参照
- [Lucide](https://lucide.dev/) —— 图标（ISC）
- 荆南字坊 —— 荆南麦圆体（OFL-1.1）
