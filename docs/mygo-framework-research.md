# MyGo 作为 PicPiper 桌面框架的迁移研究

研究日期：2026-11-11。

核对版本：MyGo `v0.9.0`（调查时官方 GitHub 最新 release；下文以该 tag 的文档和源码为基准）。

范围更新：用户已明确本项目可推倒重做，主要用于评估 Go + MyGo 的构建占用、成品体积和开发体验。本文的框架事实继续作为选型依据；旧版四格式能力和六平台矩阵是后续扩展参考，首轮以 macOS arm64 最小可用应用和体积实测为主，不要求逐项兼容旧实现。当前推进顺序见 [重做与框架评估计划](mygo-migration-plan.md)。

## 结论摘要

- **MyGo 框架本身不要求 Rust，也不使用 cgo。** 官方构建默认 `CGO_ENABLED=0`，因此基础桌面壳可以纯 Go 构建和交叉编译。但这不代表 PicPiper 当前的图片编解码能力能用纯 Go 同等替换：Go 标准库有 JPEG/PNG 编解码，`golang.org/x/image/webp` 文档只提供 WebP 解码；AVIF 和 WebP 编码需要另选实现。采用 C 库时要启用 cgo，并为六个目标平台准备对应 C 编译器及库；可考虑 libwebp 与 libavif 配置 libaom 或 SVT-AV1 等非 Rust 编码器。编码质量、EXIF 方向处理、元数据剥离和最终像素结果仍须用实际输入验证，纯 Go 本身不保证结果等价。
- **当前 CI 的六个 OS/架构组合都在 MyGo 发布文档矩阵内**：macOS arm64/amd64、Windows arm64/amd64、Linux arm64/amd64。MyGo 的桌面网页视图使用系统 WebView；Linux 运行时需要 GTK 3 和 WebKitGTK，Windows 需要 WebView2 Runtime。MyGo 文档要求 Go 1.27.3 或更高；这是开始 PoC 前需要确认的工具链门槛。
- **React/Vite 前端可沿用。** MyGo 文档把 Vite 作为网页前端构建流程的一部分，能执行开发和生产构建命令，并把构建产物嵌入应用。文档没有给 React 专项集成步骤，但没有要求重写网页 UI。
- **常规桌面能力有官方 API**：多文件/目录选择、保存对话框、系统剪贴板、默认浏览器/文件应用打开、窗口拖动和 OS 文件拖放。拖放 API 可给出本地文件路径。开发中应验证现有 UI 的具体交互和六平台行为。
- **Go-JS 调用是生成的类型化绑定，经 WebView 原生消息桥传递，而非本地 HTTP/WebSocket RPC listener。** Go 返回错误会变为前端 Promise rejection，绑定方法各自在 goroutine 运行；带 `context.Context` 的调用会在发起页导航或窗口关闭时取消。应用事件可类型化 Emit/Broadcast。远程页面默认不可调用 Go；只应把可信源加入允许列表，不能用 `"*"` 放开任意导航页面。
- **建议先验证 macOS arm64 最小应用**：从空壳、实际前端到 JPEG/PNG 处理，逐步测量 `.app`/下载包大小、构建耗时和磁盘占用，同时验证绑定和原生交互。WebP、S3、AVIF 和其他平台后续按增量评估。MyGo 0.9.0 是最新正式标记的发布，但项目没有公开的总体稳定性承诺；其文档明确把 native modules 标为实验功能。不要把实验模块作为 PicPiper 核心迁移依赖。

## 来源版本与成熟度

[官方 release `v0.9.0`](https://github.com/egoist/mygo/releases/tag/v0.9.0) 于 2026-11-11 发布，GitHub 标记为 Latest，未标记为 prerelease。官方仓库的 [v0.9.0 文档](https://github.com/egoist/mygo/tree/v0.9.0/docs) 将 Go 1.27.3 列为最低版本；`go.mod` 同样声明 `go 1.27.3`（[tagged go.mod](https://github.com/egoist/mygo/blob/v0.9.0/go.mod)）。建议 Go 模块和 CLI 都固定在 `v0.9.0`，不要在构建中使用浮动的 `@latest`；同时提交 `go.mod`/`go.sum` 和前端 lockfile。

这能确认该版本是正式发布，不等于框架有长期 API 稳定承诺。官方 README 和文档没有总体稳定等级声明；文档只明确称 [native modules 为 experimental](https://github.com/egoist/mygo/blob/v0.9.0/docs/native-modules.md)。本次迁移不需要 native modules，建议 PoC 使用标准 WebView 和 Go API。

## 目标平台与构建前提

官方 v0.9.0 文档列出的平台如下（发行构建示例覆盖 PicPiper 当前 CI 的六种组合）：

| OS/架构 | MyGo 文档支持 | 系统条件与交付限制 |
|---|---|---|
| macOS arm64、amd64 | 支持；可构建 `darwin/universal` | 运行基线 macOS 12+。签名、公证和 DMG 制作需 macOS runner。 |
| Windows amd64、arm64 | 支持 | Windows 10/11；网页窗口需要 WebView2 Runtime（Windows 11 自带）。生成安装器需 NSIS；签名按 Windows/非 Windows runner 使用不同工具。 |
| Linux amd64、arm64 | 支持 | 网页窗口需 GTK 3 与 WebKitGTK 4.1 或 4.0；native UI 需要 GTK 3。系统托盘另需 libayatana-appindicator3。 |

来源：[Getting started](https://github.com/egoist/mygo/blob/v0.9.0/docs/getting-started.md)、[distribution/build matrix](https://github.com/egoist/mygo/blob/v0.9.0/docs/distribution.md)。发行文档示例将 macOS 构建放在 macOS runner，将 Windows/Linux 目标放在 Ubuntu runner；MyGo 自身可无 cgo 交叉编译。若应用依赖启用 cgo，则必须另配目标平台 C 编译器，交叉编译还需要对应 cross compiler。发行包不能代替系统 WebView/GTK 运行时，因此 Linux 安装和支持说明需覆盖相应系统依赖。

MyGo 可输出 macOS app/DMG、Windows executable/NSIS installer，以及 Linux executable、安装归档、Debian、RPM、Arch 构建文件。签名、公证需要相应平台和证书；这些属于发布流水线约束，不妨碍先做未签名本地 PoC。来源：[Building and distributing](https://github.com/egoist/mygo/blob/v0.9.0/docs/distribution.md)。

## React、Vite 与应用资源

MyGo 的网页窗口可使用常规 HTML/CSS/JavaScript 工具链。配置中的 `devUrl`、`devCommand`、`buildCommand`、`frontendDist` 分别连接 Vite 开发服务器、启动命令、生产构建命令和构建产物目录；生产构建时把 `frontendDist` 嵌入应用。官方示例默认使用 TypeScript 和 Vite，但没有 React 专属配置教程；结合 PicPiper 当前 React 19/Vite 7 结构，判断是保留 React/Vite、接入生成的 MyGo 客户端，而不是重写 UI。来源：[Frontend](https://github.com/egoist/mygo/blob/v0.9.0/docs/frontend.md)、[Getting started](https://github.com/egoist/mygo/blob/v0.9.0/docs/getting-started.md)。

打包后的网页有应用自有 origin；文档给出的形式是 macOS/Linux `mygo://localhost/`、Windows `http://mygo.localhost/`。运行时本地资源可由 `mygo.FileServer(fs.FS)` 配合自定义 protocol 提供，具备 MIME 类型和 range 支持，适合把本地全分辨率图片作为图片 URL 加载，而非经 RPC 转成 base64。`LoadFile` 用于加载本地 HTML 文件，不应假定任意本地图像 `file://` URL 会在 WebView 中以一致权限和行为加载。来源：[Frontend / custom protocols](https://github.com/egoist/mygo/blob/v0.9.0/docs/frontend.md)。

**资源边界需要 PoC 确认**：前端静态构建产物有明确嵌入路径；用户选取或拖入的图片则是运行时文件。要测试自定义 protocol 对不同磁盘路径、空格/Unicode、文件删除/替换和大图 range 请求的处理，同时避免将任意文件系统开放给 WebView。

## Go-JS 调用、错误、事件与信任边界

MyGo 扫描并生成 TypeScript 客户端，Go 服务方法转为客户端函数、Go 类型映射为 TypeScript 声明；数据以 JSON 编码。调用中 Go 返回的非 nil error 会让前端 Promise reject 为 `CallError`，文档保证其错误文本和 `method`，没有保证保留自定义 `code` 字段。若沿用 PicPiper 旧调用方的 `{code, message}` 业务错误，需要显式结果封装和前端适配；重做版本可按新领域需求设计错误契约。panic 会被恢复并作为错误回报。每次绑定调用在独立 goroutine 执行，因此并发访问共享服务状态必须自行同步。来源：[Bindings](https://github.com/egoist/mygo/blob/v0.9.0/docs/bindings.md)。

Go 可声明类型化事件并向当前窗口 Emit 或向所有窗口 Broadcast；DOM ready 前发出的事件会延后送达。方法接收首参数 `context.Context` 时，该参数不会出现在 TypeScript API，页面导航或窗口关闭时 context 会取消。不能据此推断 React 单页应用切换视图会自动取消任务。适合用事件更新压缩进度；对需要窗口关闭后继续的任务，不能直接依赖绑定调用的生命周期，需 PoC 确认服务端任务所有权、持久化以及重连后的进度恢复。官方文档说明单次方法 goroutine，但没有给出独立的持久后台任务/队列 API。来源：[Bindings](https://github.com/egoist/mygo/blob/v0.9.0/docs/bindings.md)。

这不是 localhost WebSocket/HTTP 服务。官方桥接实现由 WebView 的原生消息通道接收 JSON，再交给 Go；WebKit 使用 `webkit.messageHandlers.mygo`，WebView2 使用 `chrome.webview`。桥包含每页随机 secret；官方信任机制默认只允许应用自己的页面调用 Go，外部页面需将精确 origin 加入 `PageOptions.TrustedOrigins`。文档特别警告：信任 `"*"` 等同于信任该窗口可能导航到的任何站点。源码入口：[bridge.go](https://github.com/egoist/mygo/blob/v0.9.0/bridge.go)、[bridge_js.go](https://github.com/egoist/mygo/blob/v0.9.0/bridge_js.go)、[auth.go](https://github.com/egoist/mygo/blob/v0.9.0/auth.go)、[JS bridge](https://github.com/egoist/mygo/blob/v0.9.0/internal/bridge/bridge.js)；策略见 [Bindings: trust](https://github.com/egoist/mygo/blob/v0.9.0/docs/bindings.md)。

PicPiper 后端目前提供本地文件读取/写入及使用已保存凭证的 S3 操作，故迁移时需保持应用页面和 Go 暴露方法的信任边界。PoC 应检查生产与开发 origin、外链/新窗口/重定向行为、导航中权限是否更新，并确认未信任页面不能调用文件或 S3 方法。不要把密钥或具备任意路径能力的方法暴露给远程页面。

## 文件选择、拖放、剪贴板、系统打开与窗口

官方对话框 API 支持打开文件、目录选择、保存目标、过滤器及多选；Shell API 可用默认浏览器打开 URL 或用系统默认应用打开路径。`Clipboard` 支持文本、HTML、图片和结构化文件/拖放数据。来源：[Native APIs](https://github.com/egoist/mygo/blob/v0.9.0/docs/native.md)。

OS 文件拖放 API 能把 Finder、Explorer 等拖入的本地文件提供为路径。React/WebView 应使用 `mygo-runtime` 的 `onFileDrop(({ paths, x, y }) => ...)`；Go 侧可订阅窗口级 `OnFileDrop`。`DroppedFiles()` 属于 native UI 元素 API，不能直接用在 React DOM 元素上。来源：[Frontend / dropped files](https://github.com/egoist/mygo/blob/v0.9.0/docs/frontend.md#dropped-files)、[UI input / file drops](https://github.com/egoist/mygo/blob/v0.9.0/docs/ui/input.md)、[Windows](https://github.com/egoist/mygo/blob/v0.9.0/docs/windows.md)。文件夹拖放/拖入多个目录、拒绝不支持的扩展名以及 Linux Wayland 行为应在 PoC 中核对。

窗口 API 有 frameless、启动窗口拖动和 macOS hidden title bar/traffic-light positioning 支持，可覆盖当前窗口拖动与标题栏交互的主要需求。现有浏览器 `navigator.clipboard.writeText` 对应的纯文本剪贴板用途可继续由前端承担；图片/文件等原生剪贴板能力使用 Go API。来源：[Windows](https://github.com/egoist/mygo/blob/v0.9.0/docs/windows.md)、[Native APIs](https://github.com/egoist/mygo/blob/v0.9.0/docs/native.md)。

## Rust-free 图片编解码可行性与限制

MyGo 不要求 Rust。是否能移除 PicPiper 的 Rust 依赖，主要取决于能否接受新的编解码实现和工具链，而不是 MyGo 框架。

- **JPEG / PNG**：Go 标准库 `image/jpeg` 和 `image/png` 提供解码和编码；JPEG quality 可配，PNG 有压缩等级选项。配置含义、速度、文件大小和输出像素未必与当前 `image` crate 相同。来源：[Go image/jpeg](https://pkg.go.dev/image/jpeg)、[Go image/png](https://pkg.go.dev/image/png)。
- **WebP**：Go 的 `golang.org/x/image/webp` 文档提供 Decode/DecodeConfig，没有编码 API；若需要 WebP 编码，可评估 Google 的 libwebp C 编码 API。来源：[Go WebP package](https://pkg.go.dev/golang.org/x/image/webp)、[libwebp API](https://developers.google.com/speed/webp/docs/api)。libwebp 路径意味着分发/编译 native library 与 cgo、或随包提供外部编码器；不能按“Go-only”直接假设可用。
- **AVIF**：libavif 官方列出 libaom 编解码、dav1d/libgav1 解码，以及 rav1e/SVT-AV1 编码后端；可选择 C 实现的 libaom 或 SVT-AV1，避免 rav1e 的 Rust 后端。libavif 本身是 C 库，Go 调用通常需要 cgo。来源：[libavif](https://github.com/AOMediaCodec/libavif)。当前 Rust `image` crate 0.25.10 默认格式特性包含 AVIF，AVIF encoder feature 使用 `ravif`；其行为与 libavif 后端不可视为等价。来源：[image 0.25.10 Cargo.toml](https://docs.rs/crate/image/0.25.10/source/Cargo.toml)。

MyGo CLI 默认 `CGO_ENABLED=0`；需要 cgo 的依赖必须启用 cgo，并在每个目标构建环境提供目标 C 编译器/库，cross compile 时还要有匹配的 cross compiler。来源：[Distribution: cgo and cross compilation](https://github.com/egoist/mygo/blob/v0.9.0/docs/distribution.md)。因此有两条可行路线：先尝试纯 Go JPEG/PNG 与 WebP/AVIF 经预编译外部工具或纯 Go 库的候选实现；或者把 cgo 纳入六平台构建，并固定、签名及打包每个平台的 native libraries。两者都需评估维护和分发复杂度。

**不可从框架文档确定的事**：MyGo 对高分辨率图像压缩吞吐、峰值内存、输出编码参数一致性没有 PicPiper 专项数据。不能因实现语言是 Go 就宣称输出等价。应以同一批 JPEG/PNG/WebP/AVIF 输入，对格式、方向、透明度、元数据剥离、色彩、尺寸、quality、文件体积、速度、内存和损坏输入错误分别做金样比较。

## 建议的定向验证

1. **体积与构建成本先行**：固定 Go/MyGo 版本，先在 macOS arm64 生成空壳与实际前端的 release `.app`。分别记录安装体积、下载包、冷/热构建耗时及 cache/build 目录占用；每加入图片库或 SDK 重测增量。两位数 MB 是待验证目标，框架文档本身不能证明成品达到该目标。
2. **桥接与原生体验**：验证 Go-JS 调用、类型生成、错误、调试、文件选择/拖放、窗口与打包资源。后台任务测试覆盖窗口关闭/真实页面导航时 context cancel、React 视图切换的状态管理、并发同步和可信 origin；从当前最小功能出发设计，不要求复制旧契约。
3. **图片处理重选型**：先用 JPEG/PNG 建立选图→预览→处理→导出闭环，随后比较 WebP 候选的质量、体积、性能和依赖。AVIF 后置；旧输出作为参考，不作为质量标准。受限图像协议需覆盖 Unicode、空格、大图和文件消失等情况。
4. **后续分发探索**：按需要增加 S3、AVIF、Windows/Linux 与其他架构。涉及 cgo 时核对各目标库、编译工具链与打包体积。框架声明支持六平台不等于应用已经验证六平台；首轮也不以完成全部平台为前提。

## 主要官方来源

- [MyGo 官方仓库](https://github.com/egoist/mygo) · [v0.9.0 release](https://github.com/egoist/mygo/releases/tag/v0.9.0) · [tag 文档](https://github.com/egoist/mygo/tree/v0.9.0/docs)
- [Getting started](https://github.com/egoist/mygo/blob/v0.9.0/docs/getting-started.md) · [Frontend](https://github.com/egoist/mygo/blob/v0.9.0/docs/frontend.md) · [Bindings](https://github.com/egoist/mygo/blob/v0.9.0/docs/bindings.md)
- [Native APIs](https://github.com/egoist/mygo/blob/v0.9.0/docs/native.md) · [Windows](https://github.com/egoist/mygo/blob/v0.9.0/docs/windows.md) · [UI input](https://github.com/egoist/mygo/blob/v0.9.0/docs/ui/input.md) · [Distribution](https://github.com/egoist/mygo/blob/v0.9.0/docs/distribution.md)
- [Go JPEG](https://pkg.go.dev/image/jpeg) · [Go PNG](https://pkg.go.dev/image/png) · [Go WebP](https://pkg.go.dev/golang.org/x/image/webp) · [libwebp](https://developers.google.com/speed/webp/docs/api) · [libavif](https://github.com/AOMediaCodec/libavif)
