# 第三方素材与组件声明

本仓库的**代码与文档**以 MIT 许可发布（见 [LICENSE](LICENSE)）。
随应用分发的**素材**（动画、音效、字体、图标）不属于 MIT 许可范围，各自遵循下列条款。

---

## 1. 随包分发的素材

### 动画素材

`src-tauri/resources/characters/` 下 9 个角色、共 196 段 640×360 透明 WebM（约 113 MB）：

| 目录 | 段数 | 目录 | 段数 |
|---|---|---|---|
| `shenshen` | 106 | `ojousama` | 19 |
| `character3` | 12 | `character4` | 12 |
| `character13` | 11 | `character5` | 8 |
| `character6` | 10 | `character11` | 10 |
| `character12` | 8 | | |

来源：[MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop)（MIT License），
素材源头为 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。

- 素材内容**未作修改**，仅按原目录约定组织并随应用打包。
- 上游另有 `core + extra1..6` 完整分件包（约 1.3 GB），**不随本仓库分发**；
  用户可自行下载后用 `scripts/install-packs.mjs` 离线合并进本地构建，权利归属同上。
- 素材版权归原作者所有；本项目仅用于本地预览与学习交流，**请勿用于商业用途**。

### 音效

`src-tauri/resources/sounds/click.wav`、`click-duck.wav` 为点击音效，随本仓库分发；
若与上游素材重复，权利归属同上。应用默认使用内置 duck 音效，用户可在数据目录
`sounds/` 放置自定义 `click.wav` 覆盖。

### 字体

`src/assets/fonts/KNMaiyuan-Regular.ttf` —— **荆南麦圆体**（荆南字坊）。
许可：SIL Open Font License 1.1（可商用、可嵌入）。为免各机器字体不一致，随应用内置。

### 图标

- `src/data/icons.ts` 由 [`lucide-static`](https://github.com/lucide-icons/lucide)（**ISC License**）
  经 `scripts/gen-icons.mjs` 生成，运行时零依赖、无网络请求。
- `src-tauri/icons/`、`src/assets/logo.jpg`：本项目应用图标与封面，图像内容由本项目提供。

---

## 2. 参考项目（行为参照，未复制源码）

角色交互逻辑、几何参数、气泡配色、默认菜单树与动作注册表、设置能力域与主界面视觉风格，
参照下列项目的**行为与视觉契约**重新实现，**未复制其源码文件**：

- [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) —— Web 原版，素材源头
- [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) —— Python + PySide6 桌面移植

逐文件的字段溯源笔记见 [参考项目桌宠规范.md](参考项目桌宠规范.md)。

---

## 3. 代码依赖

### Rust（`src-tauri/Cargo.toml`）

| 依赖 | 用途 | 许可 |
|---|---|---|
| `tauri` 2（含 `tray-icon`） | 应用框架、窗口、托盘 | MIT / Apache-2.0 |
| `tauri-plugin-dialog` | 文件选择 | MIT / Apache-2.0 |
| `tauri-plugin-autostart` | 开机自启 | MIT / Apache-2.0 |
| `tauri-plugin-notification` | 系统通知 | MIT / Apache-2.0 |
| `tauri-plugin-single-instance` | 单实例 | MIT / Apache-2.0 |
| `sysinfo` | 灵动岛 CPU/内存/网络采样 | MIT |
| `serde` / `serde_json` | 配置与清单序列化 | MIT / Apache-2.0 |
| `zip` | 素材包解压（导入）与打包（导出） | MIT |
| `rayon` | 素材扫描并行 | MIT / Apache-2.0 |
| `percent-encoding` | 自定义协议 URL 编解码 | MIT / Apache-2.0 |
| `open` | 打开外部链接/文件 | MIT |
| `windows` | Win32（浮层命中、菜单、输入） | MIT / Apache-2.0 |

### 前端（`package.json`）

| 依赖 | 用途 | 许可 |
|---|---|---|
| `vue` 3 | 主界面与设置窗 | MIT |
| `@floating-ui/vue` | 气泡/浮层定位 | MIT |
| `vue3-smooth-dnd` | 动作列表拖拽排序 | MIT |
| `@tauri-apps/api`、各 `@tauri-apps/plugin-*` | 前端 IPC | MIT / Apache-2.0 |
| `vite`、`@vitejs/plugin-vue`、`typescript` | 构建 | MIT / Apache-2.0 |
| `lucide-static` | 图标源（构建期） | ISC |
| `archiver` | 便携版打包脚本 | MIT |

### 运行时

- **WebView2 Runtime**（Microsoft）：随 Windows 10/11 提供，**不随本仓库分发**。
- 无 Electron、无 Node 运行时依赖。

---

## 4. 运行时网络行为

- 默认**不联网**：启动、渲染、托盘、菜单均不发起请求，无遥测、无自动更新检查。
- 只有用户主动点击 `video-json-pet://import?url=…` 深链导入在线素材时，才会调用系统 `curl`
  下载该清单与其中的视频文件；下载有体量上限（清单 1 MB / 单段 64 MB / 合计 512 MB），
  且路径经过 `..` 与盘符校验，不会写入素材包目录之外。
- 构建期的 `scripts/fetch-assets.mjs` 会从 GitHub 拉取上游素材，只在开发者本地运行，
  不影响已构建的产物。

---

## 5. 许可证全文

- MIT：<https://opensource.org/licenses/MIT>
- Apache-2.0：<https://www.apache.org/licenses/LICENSE-2.0>
- ISC：<https://opensource.org/licenses/ISC>
- SIL OFL 1.1：<https://openfontlicense.org/>
- 上游项目的完整许可证见其仓库根目录 `LICENSE`。

> 若你认为本仓库的某处署名有遗漏或错误，欢迎提 issue 补充更正。
