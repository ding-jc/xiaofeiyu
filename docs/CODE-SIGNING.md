# SignPath Foundation 免费代码签名 · 申请与接入

给 Windows 安装包做 Authenticode 签名，去掉下载时的「未知发布者 / Windows 已保护你的电脑」。
SignPath Foundation 为符合条件的开源项目免费提供证书与云签名服务 —— 私钥存在他们的 HSM 里，
CI 只负责「送件 → 等批准 → 取件」，开发机永远拿不到私钥。

> 证书签发给 **SignPath Foundation**，所以安装包属性里的发布者显示为 SignPath Foundation 而不是个人。
> 这正是它的价值：用 SignPath 的名誉担保「这个二进制确实由该公开仓库的 CI 构建」。

---

## 0. 仓库侧前置条件（已完成）

| 条件 | 现状 |
|---|---|
| 仓库公开 | ✅ `github.com/ding-jc/xiaofeiyu` |
| OSI 认可的开源许可 | ✅ MIT（`LICENSE`） |
| README 有 `Code signing policy` 段落 | ✅ 含角色分工、构建来源、隐私说明 |
| 有公开下载页 | ✅ GitHub Releases |
| 构建全程在 GitHub 托管 runner 上 | ✅ `windows-latest`，见 `.github/workflows/build-windows.yml` |
| 签名请求走 GitHub Actions artifact | ✅ `sign` 任务已就绪（未配变量时自动跳过） |
| 每个签名请求人工批准 | ✅ 由你在 SignPath 后台点批准 |

**还需你手动做一件事：给 GitHub 账号和 SignPath 账号都开启双重验证（2FA）**，这是硬性要求。

---

## 1. 提交申请

入口：<https://signpath.org/> → **Apply for SignPath Foundation**（表单页 <https://signpath.org/apply.html>）。
用 GitHub 账号登录，按下表填写。英文原文可直接复制。

| 字段 | 填什么 |
|---|---|
| Project name | `Xiaofeiyu Pet` |
| Repository URL | `https://github.com/ding-jc/xiaofeiyu` |
| Homepage | `https://github.com/ding-jc/xiaofeiyu` |
| Download page | `https://github.com/ding-jc/xiaofeiyu/releases` |
| Privacy policy | `https://github.com/ding-jc/xiaofeiyu#code-signing-policy`（同页有 Privacy 小节） |
| License | `MIT` |
| Maintainer type | `Individual` |
| Build system | `GitHub Actions` |
| Company / Wikipedia | 留空 |
| Email | 用能正常收信的邮箱，**不要**用 `@users.noreply.github.com` |

**One-line description**

```
A Windows desktop pet that renders transparent WebM character animations in a click-through, always-on-top overlay.
```

**Project description**

```
Xiaofeiyu is a Windows desktop pet (shimeji-style) written in Rust and TypeScript with Tauri 2 and Vue 3.
It renders multiple characters as transparent WebM videos in a single click-through overlay window, with
pixel-accurate hit testing, drag, random idle actions, a tray icon, right-click menus rendered in a separate
transparent webview, todo reminders and autostart.

The application is fully offline: no accounts, no telemetry, no analytics. Users can import their own asset
packs (a folder plus a JSON manifest) from a zip file or a directory; the format is documented in the repository
and is interoperable with the dsh-pet ecosystem.

All release binaries are built from the public repository by GitHub Actions on GitHub-hosted windows-latest
runners. The only release artifact is an NSIS installer produced by Tauri's bundler and attached to GitHub
Releases. There are no proprietary components in the signed payload; the bundled character animations are
third-party assets listed in THIRD_PARTY_NOTICES.md.
```

审核没有公布固定时长，一般几个工作日；通过与否都会发邮件。

---

## 2. 审批通过后的后台配置

登录 <https://app.signpath.io>，按顺序做：

1. **Organization**：拿到一个 Organization ID（形如 `xxxxxxxx-xxxx-...`），后面要填进仓库变量。
2. **Trusted Build System**：Settings → Trusted Build Systems → 添加预置的 *GitHub.com*，并链接到你的 Project。
3. **GitHub App**：安装 SignPath GitHub App 到 `xiaofeiyu` 仓库（只给只读权限），用于审计日志校验。
4. **Project**：Slug 建议 `xiaofeiyu`。
5. **Signing Policy**：Slug 建议 `release-signing`，勾选要求人工批准（Manual approval）。
6. **Artifact Configuration**：Slug 建议 `nsis-installer`。推荐在 UI 里上传一个现有的 `*-setup.exe` 让向导自动生成；
   也可以直接粘贴下面这份：

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="*-setup.exe">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

> CI 上传 artifact 时用的是 `actions/upload-artifact`（默认打成一个 zip），所以根元素必须是 `<zip-file>`。
> 如果 UI 报元素不合法，直接用向导生成，别手改。

---

## 3. 仓库侧配置

`Settings → Secrets and variables → Actions`：

**Secret**

| 名称 | 值 |
|---|---|
| `SIGNPATH_API_TOKEN` | SignPath 后台 → 用户设置 → API tokens，权限选「提交签名请求」 |

**Variables**（注意是 Variables，不是 Secrets）

| 名称 | 值 |
|---|---|
| `SIGNPATH_ORGANIZATION_ID` | 第 2 步拿到的 Organization ID |
| `SIGNPATH_PROJECT_SLUG` | `xiaofeiyu` |
| `SIGNPATH_SIGNING_POLICY_SLUG` | `release-signing` |
| `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | `nsis-installer` |

`SIGNPATH_PROJECT_SLUG` 就是总开关：它为空时 `sign` 任务整体跳过，流水线行为与现在完全一致。

---

## 4. 验证

推一个测试 tag：

```bash
git tag v1.0.1-test && git push origin v1.0.1-test
```

流程会停在 `sign` 任务等批准 —— 去 SignPath 后台点通过，然后：

1. 下载 Release 里的安装包，右键 → **属性** → **数字签名**，签名者应为 `SignPath Foundation`；
2. 命令行核验（任意装了 Windows SDK 的机器）：

```powershell
& "C:\Program Files (x86)\Windows Kits\10\bin\x64\signtool.exe" verify /pa /v .\xiaofeiyu_1.0.1-test_x64-setup.exe
```

3. 删掉测试 tag，别留在仓库里：

```bash
git push origin :refs/tags/v1.0.1-test && git tag -d v1.0.1-test
```

---

## 5. 常见问题

**签名通过后还会弹警告吗？**
OV 级别的证书（SignPath Foundation 属于这一类）签完可能仍有短暂提示期，因为 SmartScreen 还要积累该证书的
下载信誉；通常几百到几千次下载后彻底消失。EV 证书才是签完立即零警告，但价格高、要求企业主体。

**证书会过期吗？**
会（一般一年），但签名带 RFC3161 时间戳，**已发布的旧安装包永久有效**。续期后新构建继续用新证书签。

**为什么只签安装包，不签里面的 exe？**
SmartScreen 只拦「下载下来的、带网络标记」的文件，也就是 `*-setup.exe`。安装后落盘的 exe 没有这个标记，
不签也不会弹。签安装包就够了，还能省签名配额。

**如果哪天 SignPath 不给了？**
`sign` 任务会因为变量被删而自动跳过，流水线退回「未签名」状态；也可以改用自备 PFX 证书 ——
`src-tauri/sign.ps1` 那条路一直保留着。
