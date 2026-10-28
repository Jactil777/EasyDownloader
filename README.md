# EasyDownloader

EasyDownloader 是一个 Windows 本机媒体下载客户端。桌面程序在后台启动本地服务并显示应用窗口，不会弹出 DOS 窗口；下载和 Cookie 均留在用户自己的电脑上。

## 普通用户安装

运行 `release/EasyDownloader-Setup-<版本>.exe`，按安装程序提示完成安装。安装后可从桌面快捷方式或开始菜单启动。用户不需要另装 Node.js 或手动运行脚本。

关闭 EasyDownloader 窗口会停止本地服务。用户设置保存在 Windows 用户数据目录中，卸载或升级时与程序文件分开。最近 200 条下载记录也会保留；清空记录不会删除已下载文件。

## 开发与打包

开发运行仍可用 `start.cmd`，或执行 `npm run desktop` 启动桌面壳。

在 Windows 开发机上，先安装 Node.js 20 或更新版本，然后运行：

```powershell
npm install
npm run build:installer
```

`build-installer.ps1` 会自动准备 Windows Node.js 运行时；若下载工具缺失则安装 yt-dlp、gallery-dl、FFmpeg 和可选的视频号组件，然后检查源码并生成安装程序到 `release`。项目文件有更新时重新运行同一命令即可快速打包；需要同步上游最新解析器时运行 `npm run build:installer -- -UpdateTools`。

## 客户端更新

安装版启动时会检查公开 GitHub Releases。发现新版本后，界面会显示“下载更新”按钮；下载完成后点击“重启并完成更新”，客户端会自动退出、安装并重新启动，不需要手动卸载。

已安装的 `0.1.0` 客户端本身没有更新模块，需要先运行一次 `0.1.1` 安装包覆盖升级（不必先卸载）；之后的版本就能从界面更新。

发布新版本时先递增 `package.json` 与 `package-lock.json` 中的版本号并推送代码，再推送匹配的版本标签（当前首个更新标签应为 `v0.1.1`）。GitHub Actions 会自动构建 Windows 安装包并发布更新文件。已安装客户端只会检查**已发布的 Release**，普通代码推送不会直接让用户升级。工作流需要仓库允许 `GITHUB_TOKEN` 写入 Releases（`contents: write` 权限已配置）。

## 功能

- 每次粘贴最多 10 个链接；
- 自动识别视频、图片及其他素材链接；
- 需要登录的网站可导入浏览器扩展导出的 Netscape 格式 `cookies.txt`；
- 微信视频号链接可直接粘贴; 首次使用会打开独立的腾讯元宝登录窗口, 成功后自动下载到当前保存目录；
- 实时任务进度、失败信息和取消；
- 文件直接保存到本机目录；
- 不使用自建服务器、数据库或云端存储。

## 注意事项

- 解析能力取决于 yt-dlp 和 gallery-dl，网站更新后可能需要更新工具版本。
- `npm run build:installer` 需要网络来下载打包依赖、Node.js 运行时以及尚未安装的解析工具；日常只改项目代码时无需重新下载解析工具。
- `cookies.txt` 是网站登录凭证, 请勿分享或上传到不可信位置。
- 微信视频号解析会将分享链接发送给腾讯元宝, 元宝登录凭据保存在当前 Windows 用户的本地应用数据目录, 不读取 Chrome 日常登录 Cookie。元宝接口为非公开接口, 变更后可能暂时不可用。
- 微信视频号解析组件由 `install-tools.ps1` 安装到项目 `tools` 目录; 安装需要网络, 首次登录时需在弹出的元宝窗口完成验证。
- 请只下载你有权保存的公开内容，不支持 DRM 或付费内容的绕过。
