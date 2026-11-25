Windows 桌面版安装包，含 9 个内置角色。

安装包由 GitHub Actions 从本仓库构建，并带有 [SignPath Foundation](https://signpath.org/) 提供的免费代码签名
（发布者显示为 SignPath Foundation，说明见 [Code signing policy](https://github.com/ding-jc/xiaofeiyu#code-signing-policy)）。

安装后可在应用内「添加角色」导入自己的素材包，做法见 [docs/RECIPE.md](https://github.com/ding-jc/xiaofeiyu/blob/main/docs/RECIPE.md)。

## 新增

- 桌宠运行时：透明置顶窗口播放 WebM 待机动画，支持点击 / 拖拽 / 随机动作与多角色切换
- 右键菜单与托盘菜单改为独立透明窗口渲染：圆角、亚克力、无阴影，支持子菜单与键盘导航
- 素材格式 `xiaofeiyu-asset-v1`，可与 dsh-pet 素材包双向转换（导入自动识别，可导出 zip 或直接写入 dsh）
- Windows 自动打包：打 tag 即生成安装包并发布 Release

## 修复

- 构建环境缺少角色素材目录时打包直接失败
- 导入 ZIP 素材包时缺少条目数与解压体积上限，超大包可撑爆磁盘
- 在线清单导入未校验相对路径，恶意清单可把文件写到素材包之外
