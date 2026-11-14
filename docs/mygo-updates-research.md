# MyGo 应用更新能力调研

调研日期：2026-11-14。核对了用户指定的[官方中文更新文档](https://mygo.run/zh/docs/updates)及其 [Markdown 版本](https://mygo.run/zh/docs/updates.md)，并以项目固定的 `github.com/egoist/mygo v0.9.0` 的官方文档和源码确认 API。项目 Go 模块、CLI 与 `mygo-runtime` 均固定在 0.9.0；以下能力在该版本中已存在，不需要为接入更新先升级框架。[项目 go.mod](../go.mod)；[项目 package.json](../package.json)；[v0.9.0 更新文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md)

## 结论

**MyGo 可以把 Pic Piper 的发布方式扩展为“应用内发现新版本、阅读说明、下载已签名更新、重启生效”，并支持增量下载。** 它更新的是整个应用包，可一起交付 Go 图像处理逻辑、编解码依赖和 React 页面。最适合当前项目的第一步，是接入现成 updater 插件，并继续使用 GitHub Releases 分发；不必先做自己的更新服务器或 React 更新对话框。这是基于已有 API 和项目发布方式的接入建议。[v0.9.0 更新文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md)；[updater 插件](https://github.com/egoist/mygo/blob/v0.9.0/docs/plugins/updater.md)；[项目发布流程](../.github/workflows/release.yml)

当前项目**尚未启用这些能力**：`mygo.json` 没有 `updates`，应用没有注册 updater 插件，发布流程仅构建 macOS arm64 并向 Release 上传 DMG。因此现有 DMG 发布不会自动变成可供应用内更新的版本；目前没有更新源的已安装客户端，需要先手动安装一次启用更新的新版本。这一判断来自项目配置与源码，后半部分是据 MyGo 构建时嵌入更新配置的机制推导。[项目配置](../mygo.json)；[应用入口](../main.go)；[项目发布流程](../.github/workflows/release.yml)；[v0.9.0 `Enabled`/`Check` 源码](https://github.com/egoist/mygo/blob/v0.9.0/updater.go)

## 用户可得到的功能

| 能力 | MyGo 已提供的行为 | Pic Piper 需要做的事 |
| --- | --- | --- |
| 自动发现新版本 | 插件启动后约 10 秒在后台检查，运行期间默认每天检查；可配置间隔或关闭自动检查。 | 注册插件，决定默认检查策略。 |
| 完整更新窗口 | 显示 Markdown 发布说明，提供安装、稍后提醒、跳过当前版本、下载进度和安装后重启。手动检查还会显示已最新或失败原因，并允许再次查看跳过的版本。 | 添加“检查更新”菜单或设置按钮；可直接使用现成窗口。 |
| 可选自动下载与安装 | 用户可选择今后后台下载并安装；新版本在下次启动时生效，后台安装本身不会强制立即重启。 | 暴露或接受插件的选择，并结合项目任务状态处理用户主动重启。 |
| 设置页状态 | 插件保存自动检查、自动下载、跳过版本等偏好；提供 `LastCheck`、`AvailableVersion`、`OnChange`。 | 把这些状态映射到 React 设置行、版本提示或角标。 |
| 增量更新 | 优先下载当前版本对应的 delta，校验签名并逐文件验证结果；失败时回退完整包。构建默认为最近 3 个已发布版本生成 delta。 | 保留旧产物与清单，实际测量项目更新包大小，不能预先承诺压缩比例。 |
| 多语言窗口 | 内置简体、繁体中文等语言，默认跟随 `App.Locale`，可指定 `Language` 或自定义文案。 | 若要与 Pic Piper 手动语言选择一致，需要把前端偏好同步给插件/应用语言。 |
| beta 通道 | GitHub 默认跳过预发布；`SetPrereleases(true)` 可加入，版本按语义化版本比较，退出 beta 不会降级。 | 自行保存 beta 选择，启动时恢复；首版可暂不开放。 |

表内行为来源：[updater 插件设置、选项和偏好](https://github.com/egoist/mygo/blob/v0.9.0/docs/plugins/updater.md)；[增量、预发布与安装语义](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md)。前端当前把语言偏好存在 `localStorage`，尚未同步 `App.SetLocale`；因此默认跟随系统的插件可能与应用手动选择的语言不同。[项目语言实现](../src/i18n/index.ts)；[插件语言规则](https://github.com/egoist/mygo/blob/v0.9.0/docs/plugins/updater.md#languages)

插件是 Go 包，无须另装 npm 包。`updater.Plugin` 的更新窗口使用 WebView，适合已有 React/WebView 的 Pic Piper；`plugins/updater/native` 也提供同一套功能的原生 UI 窗口，应用只选择其中一种插件。[插件文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/plugins/updater.md)

## 分发平台和安装位置

MyGo 为 `darwin-arm64`、`darwin-universal`、`windows-amd64` 等目标分别生成更新清单，客户端只读自己的目标清单。框架支持三平台并不表示 Pic Piper 已经发布三平台更新；当前流水线只产出 macOS arm64 DMG。[更新文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#build-and-publish)；[项目发布流程](../.github/workflows/release.yml)

| 平台 | 可以自我更新的典型安装 | 限制 |
| --- | --- | --- |
| macOS | 用户可写的 `.app`，如具备相应权限的 `/Applications` 或 `~/Applications`。 | 需要安装位置旁可写；新 bundle 在旧进程退出后替换。直接从只读 DMG 运行不能作为可更新安装。 |
| Windows | 当前用户安装目录 `%LOCALAPPDATA%\Programs`。 | 需要写入权限；安装会先替换磁盘上的应用文件，新版本在重启后运行。 |
| Linux | 用户目录，如 `install.sh` 使用的 `~/.local/my-app.app`，或可写的解压目录。 | `/opt` 等包管理器安装通常交由包管理器更新；AppImage 在该版本源码中明确禁止自我更新。 |

来源：[安装位置与替换时机](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#where-apps-can-update)；[可写检测、`installTarget` 与 AppImage 限制源码](https://github.com/egoist/mygo/blob/v0.9.0/updater.go)。`Enabled` 的实际判断是有构建时更新配置、非开发构建，以及能在安装位置旁创建临时目录；不要把它理解成已验证所有运行环境的更新一定成功。开发模式检查返回 `ErrUpdatesDisabled`，因此真正的更新流程需要用打包后的应用验收。[同一源码](https://github.com/egoist/mygo/blob/v0.9.0/updater.go)

## 发布侧必须补齐的内容

1. **更新密钥与配置。** 用 `mygo keygen` 创建长期密钥；公钥进入 `mygo.json` 的 `updates.publicKey`，配置公开的 `updates.github` 仓库，私钥只交给 CI 的 `MYGO_UPDATER_PRIVATE_KEY`。MyGo 的更新签名使用 Ed25519；安装仅接受对应公钥验证通过的包或 delta。丢失私钥会阻断原有客户端继续接收同一密钥链的更新，泄露私钥则允许攻击者签署代码。[设置文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#set-up)；[签名实现](https://github.com/egoist/mygo/blob/v0.9.0/cmd/mygo/updates.go)
2. **更新产物。** 除 DMG 外，构建并发布 `pic-piper-<version>-darwin-arm64.tar.gz`、可选 `.delta`、`update-darwin-arm64.json`。清单含版本、说明、日期、大小、URL 和签名。没有更新密钥时，macOS 构建会跳过更新文件；`-upload` 则会在缺密钥时提前失败。[构建文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#build-and-publish)
3. **版本和发布说明。** 配置版本必须与发布 tag 一致；项目 `package.json` 和 `mygo.json` 当前均为 `1.0.0`，工作流没有发布 tag 与配置版本的一致性校验，应补上。更新窗口使用 `CHANGELOG.md` 的当前版本章节，GitHub `--generate-notes` 的 Release 页面说明不会自动代替这份清单说明。官方支持 `updates.changelog` 指定其他文件。[Actions 版本和说明规则](https://github.com/egoist/mygo/blob/v0.9.0/docs/github-actions.md)；[项目版本](../package.json)；[项目配置](../mygo.json)；[项目发布流程](../.github/workflows/release.yml)
4. **完整发布。** 可改用 `mygo build -upload` 上传到草稿 Release，检查所有预期平台附件齐全后发布；也可保留现有上传方式，但必须带上更新产物并正确形成清单 URL。默认 GitHub 更新源读取 latest Release 的目标平台清单；后续若多平台发布，不应让缺某个平台清单的 Release 成为客户端检查入口。[更新发布文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#build-and-publish)；[Actions 发布示例](https://github.com/egoist/mygo/blob/v0.9.0/docs/github-actions.md)
5. **系统发行签名。** 更新密钥不能代替 macOS Developer ID 签名和公证。项目当前 `macos.signingIdentity` 为 `-`（ad hoc）；对外正常发行仍需独立配置证书与公证，Windows 发行也有自己的代码签名流程。[项目配置](../mygo.json)；[官方签名与公证说明](https://github.com/egoist/mygo/blob/v0.9.0/docs/github-actions.md#signing-and-notarizing-macos-apps)

GitHub 方案要求公开仓库。若需要自己的 CDN，可用 HTTPS `updates.url`；S3/R2 发布则另加 `updates.s3`，CLI 使用 CI 中的 AWS 环境凭据上传，清单最后上传，固定名称的清单和脚本采用 `Cache-Control: no-cache`。这属于开发者的应用分发基础设施，**不应复用终端用户在 Pic Piper 中配置的图片存储桶或凭据**；后半句是项目边界建议。[S3 发布文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#publishing-to-s3)

更复杂的鉴权源、企业分发或运行时通道可以实现 `UpdateSource`，通过 `SetSource` 提供清单和下载内容，MyGo 继续验证签名；服务接口、认证和通道策略由应用自行实现。`SetPrereleases` 对普通 HTTPS 目录源不会自动筛选版本，该源始终提供服务器当前清单。[自定义源与预发布文档](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#your-own-update-service)

## 适合 Pic Piper 的接入顺序

以下是实现建议，不是已经完成的功能：

1. 第一版使用 `updater.Plugin`，增加菜单及设置页“检查更新”，默认自动检查，自动下载由用户选择；继续使用现有 GitHub 发布位置。先交付 macOS arm64，从一版可更新安装包升级到下一版验证完整链路，再扩展其他平台。[可用插件入口](https://github.com/egoist/mygo/blob/v0.9.0/docs/plugins/updater.md)
2. 应用自行处理正在压缩、上传或 mini 模式任务时的重启策略。MyGo `App.Relaunch` 走正常退出生命周期，`OnBeforeQuit` 可取消退出；可据任务状态阻止或延后重启，并恢复现有托盘的退出标志。插件 `OnInstalled` 只是安装完成通知，不是取消安装或重启的许可钩子。[退出与 Relaunch](https://github.com/egoist/mygo/blob/v0.9.0/docs/app.md#quitting)；[插件事件](https://github.com/egoist/mygo/blob/v0.9.0/docs/plugins/updater.md#preferences)
3. Windows/Linux 安装后、重启前，磁盘上的可执行文件已经是新版；Pic Piper 使用自身可执行文件运行压缩 worker，未来支持这些平台时要验证这段期间启动 worker 的版本兼容性。`OnInstalled` 可用于调整 helper 生命周期，但具体暂停、重建与协议兼容策略属于项目代码。[官方 `OnInstalled` 约定](https://github.com/egoist/mygo/blob/v0.9.0/docs/plugins/updater.md#preferences)；[项目 worker 实现](../internal/imaging/worker.go)
4. 后续有实际需求再加入 beta 开关、自定义 React 更新横幅、S3/CDN 源；`mygo.Updater.Check`/`Install` 和进度回调足以支撑自定义 UI，但错误呈现、取消和偏好管理也需自行完成。[自定义 UI](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#your-own-update-ui)

## 边界与待验证项

- 这是整个应用的签名替换，并非 React 热更新、插件热加载或不退出即可运行新 Go 代码；新版本须重启或下次启动才运行。官方没有在这些文档/API 中承诺应用数据自动迁移、按用户百分比灰度发布或新版本启动崩溃后的自动回滚，不能把这些当成现成功能。macOS 替换脚本在移动新 bundle 失败时恢复旧 bundle，属于文件替换失败恢复，不等于启动健康检查回滚。[安装语义](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#your-own-update-ui)；[macOS 替换实现](https://github.com/egoist/mygo/blob/v0.9.0/updater.go)
- 实际 delta 大小取决于 Pic Piper 的构建结果和编解码依赖变化；官方仅描述机制，没有给本项目的下载体积或耗时保证。首个可更新版本、旧包缺失、签名不匹配或 delta 不够小时，可能没有增量包。[增量构建规则](https://github.com/egoist/mygo/blob/v0.9.0/docs/updates.md#delta-updates)
- 本次只核对文档、缓存的官方 v0.9.0 源码和项目现状，未生成真实密钥、调整 CI、发布 Release 或实际安装更新。实施时应验收：正常全量与增量、断网和取消、篡改签名、只读安装目录、跳过/稍后、语言一致、任务运行中重启、托盘关闭行为、升级后的配置及凭据完整性。
