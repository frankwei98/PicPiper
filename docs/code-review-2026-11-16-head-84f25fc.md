# Pic Piper 代码审查发现与修复交接（原始 HEAD 84f25fc）

> **2026-11-17 更新**：原始发现保留供追溯，原有行号均对应 `84f25fc`。当前状态以第 3、10 节为准；第 9 节保留上一轮交接。实现快照 `a4f8806` 已补修 L5(c) 的 Mini 路径及 U1，性能优化按用户决定另议。仍在用户指定的 `fix/review-findings` 分支。

- **快照**：HEAD `84f25fc46b86bd534ba86e80e37736bc60f4a08e`，分支 `fix/review-findings`（没有上游跟踪分支），审查日期 2026-11-16。
- **原始审查方法**：只读当时磁盘代码，没有使用 git 历史，没有改动代码。后续复核与修复包含回归测试、实现修改和逐问题提交，见第 9、10 节。
- **读者**：接手修复或复核的 agent。每条发现自成一节，可以单独领取。
- **与 `docs/code-review-2026-11-16.md` 的关系**：那份报告针对更早的快照 `e752d07`。本文档是在其修复之后的新一轮审查，两者的发现不重叠；有两处结论与它不同，见第 7 节。

## 1. 原始审查基线

以下命令在本快照上全部通过：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 32 个文件、264 个测试通过 |
| `node scripts/go.mjs vet ./...` | 干净 |
| `gofmt -l main.go main_test.go smoke.go internal scripts/icon` | 无输出 |
| `node scripts/go.mjs test ./...` | 全部 ok |

原始审查没有运行：`-race` 测试、`pnpm build`、`pnpm smoke`。后续修复的验证结果见第 9.3、10.5 节。

## 2. 处理流程

1. **确认基线分支（已完成）。** 用户明确授权继续 `fix/review-findings`；分支仍无上游。本轮未切分支、fetch、pull、merge、rebase 或 push。
2. **复核发现。** 按该节「证据」里的 `file:line` 读码；HEAD 已移动时先重新定位行号。完成标准：能在当前代码里指出触发路径，或拿出证伪证据（证伪的发现标记为关闭，不改代码）。
3. **先写回归测试。** 测试放在被改模块旁边。完成标准：新测试在修复前失败。
4. **修复。** 完成标准：该节「完成标准」逐条满足，新测试通过。
5. **整体验证。** 跑 `AGENTS.md`「Verification」一节的全部命令。完成标准：全部通过。
6. **回报。** 完成标准：每条领取的发现都有一个状态——已修复、已证伪、需要决策。

验证状态的含义：

- **实测**：在本机运行并观察到了失败。
- **读码确认**：本轮逐行读过相关代码，触发路径完整，但没有运行。
- **推断**：读码得出的怀疑，缺少一环证据，先复核再决定是否处理。

## 3. 发现总表

| ID | 当前结论 | 提交 / 处理 |
| --- | --- | --- |
| H1 | 实测成立，已修复 | `4ae4019`：macOS ENOTSUP 独占复制回退 |
| M1 | 实测成立，已修复 | `421726d`：下载完整暂存后独占发布，失败不留半文件 |
| M2 | 实测成立，已修复 | `7603d32`：主窗口/Mini 一致清洗派生输出名，区分校验提示 |
| M3 | 实测成立，已修复 | `67065de`：取消/超时保留类型，响应与网络错误统一脱敏；覆盖下载正文取消 |
| M4 | 原为已声明的平台限制，按用户要求扩展 | `a3c6fad`：内嵌 LittleCMS 2.20 完整 RGB ICC 转换，含 LUT、16 位和 alpha |
| M5 | 实测成立，已修复 | `cae57da`：缓存命中/删除不等渲染，防止在途写回，清理旧 source 文件 |
| M6 | 实测成立，已修复 | `55ffb99`：Mini 动画失败引导到主窗口，不自动丢帧 |
| L1 | 关闭：用户确认保留 0600 | 输出权限策略，本轮不改为 0644 |
| L2 | 行为成立，按用户选择调整 | `1a0167e`：只用 profile 默认前缀，空前缀保留 |
| L3 | 原有行为有设计/测试依据，按用户要求改进容错 | `4faf946`：展示已验证结果，计数提示未知项；缺失元数据不再永久删除记录 |
| L4 | 读码及回归确认，已修复 | `e5e052c`：坏记录隔离到 0600 备份，有效记录继续可用 |
| L5(a) | 重复 ID 校验已修复 | `08da7ae`：不同 ID 可指向同一桶，重复 ID 返回 invalidSettings |
| L5(b) | 删除功能已实现 | `34db944`：删除本机 profile/凭据并清理引用，保留桶内对象和上传历史 |
| L5(c) | Mini 路径已复现并修复；其余推断待验证 | `a4f8806`：Mini 只提交实际修改字段，后端锁内合并最新设置，订阅跨窗口通知，见第 10.1 节 |
| L6 | 读码及回归确认，已修复 | `c55289f`：两分钟租约、15 秒心跳；进行中的后端请求继续阻止重启 |
| L7 | 关闭：有文档支持的预期行为 | `docs/releasing.md` 明确支持打包应用的隔离 update smoke |
| L8 | 已有测量，优化另议 | 对比图生成/传输、方向处理成本成立；三项在样本上撤回，HDR 限合成输入，见第 10.3 节 |
| U1 | 成功回调丢响应已复现并修复 | `daf66f4`：带超时的 Shutdown 排空响应；本机 2400 次由 4 次丢失降为 0，见第 10.2 节 |
| U2 | 待原生 Finder 拖放验证 | 模拟确认错误可被原生导入清除；没有证明实际绘制过一帧错误，见第 10.4 节 |
| U3 | 当前样本反证，关闭本次尺寸疑点 | 旋转 JXL/HEIC 的卡片与解码均为 480×640，无需额外交换尺寸 |
| R1（修复时发现） | 已修复 | `77a9aca`：上传到 profile 前缀的对象若不属于当前浏览前缀，不插入当前列表 |
| R2（验证时发现） | 已复现，待单独诊断；未纳入本轮修复 | 上一轮当前版三次、原始 84f25fc 对照版一次同现 URL 激活焦点失败；最新结果见第 10.5 节 |
| R3（最终复查发现） | 已修复 | `c27b3c8`：回退复制失败清理前检查目标文件身份，不移除复制期间被替换的文件 |

用户已确认：M4 完整 RGB 色彩转换；L1 保持 0600；L2 使用 profile 前缀；L3 展示部分结果；L5 增加删除入口。2026-11-17 追加授权补修 L5(c)、U1，每个问题一个 commit；性能优化另议。

## 4. 详细发现

除各节「当前状态」外，下述现象、行号、原修复方向与原完成标准均记录原始 `84f25fc` 快照。已关闭或完成的项目不代表当前代码仍有这些问题；验收证据见第 9、10 节。

### H1 [高] macOS 导出到 exFAT/FAT32 卷失败

> **当前状态**：已修复（`4ae4019`）。原问题已独立复现；当前导出包含 ENOTSUP 回退及不覆盖回归。

- **位置**：`internal/imaging/export_darwin.go:5-7`
- **现象**：`publishExport` 只调用 `unix.RenameatxNp(..., unix.RENAME_EXCL)`。目标卷不支持 `RENAME_EXCL` 时返回 `ENOTSUP`，没有回退。
- **触发场景**：在 macOS 上把压缩结果「保存到文件夹」或 Mini 导出到 exFAT、FAT32 的 U 盘或 SD 卡。`copyReserved`（`export.go:99-104`）把错误直接返回，用户看到通用的 `operationFailed`（`main.go:212`）。APFS 不受影响。部分网络挂载可能也受影响，没有测。
- **证据**：
  1. 实测：用 `hdiutil` 建临时 exFAT 和 FAT32 镜像并挂载，对其中的文件调用 `renamex_np(a, b, RENAME_EXCL)`，两者都返回 errno 45 `ENOTSUP`；同样的调用在 APFS 临时目录返回 0。
  2. 回退函数 `publishExportWith` 和 `copyExclusive`（`export.go:33-64`）只被 `export_other.go:8` 调用，该文件的构建约束是 `!darwin`。
  3. `export_test.go:30,47,67` 的回退测试直接调用 `publishExportWith` 并注入假的 link 函数，macOS 的实际发布路径没有被覆盖。
- **复现**：

  ```bash
  D=$(mktemp -d /tmp/pp-exfat-XXXXXX)
  hdiutil create -quiet -size 40m -fs ExFAT -volname PPT "$D/t.dmg"
  mkdir "$D/mnt" && hdiutil attach -quiet -nobrowse -mountpoint "$D/mnt" "$D/t.dmg"
  # 在应用里把任一压缩结果导出到 $D/mnt，预期失败
  hdiutil detach -quiet "$D/mnt" && rm -rf "$D"
  ```

- **修复方向**：让 darwin 路径也经过 `publishExportWith`，把 `RenameatxNp` 作为注入的发布函数。`copyExclusive` 用 `O_EXCL` 打开目标，保持「不覆盖已有文件」的约定。
- **完成标准**：
  - darwin 构建下有一条回归测试，注入返回 `ENOTSUP` 的发布函数，导出成功且不覆盖已有文件。
  - 在 exFAT 镜像上手工导出成功；目标已存在同名文件时生成 `name-2.ext`。

### M1 [中] 下载失败或取消后，半截文件留在用户目录

> **当前状态**：已修复（`421726d`）。实现已移至 `internal/cloud/download*.go`，完整写入目标目录内私有暂存文件后再独占发布。

- **位置**：`internal/cloud/cloud.go:575-608`（`saveUnique`），调用点 `cloud.go:237-245`（`download_gallery_object`）
- **现象**：`saveUnique` 直接以最终文件名创建文件（:590），`io.Copy` 或 `Close` 出错后直接返回（:597-604），不删除已写入的部分。
- **触发场景**：下载中途断网、超时或被取消。用户目录里留下一个文件名正常的截断图片；重试会再生成 `name (2).ext`。
- **修复方向**：先写入目标目录内的临时文件，完成后再独占发布；或者出错时删除本次创建的文件。imaging 的 `copyReserved` 已经是前一种做法，可以参考。
- **完成标准**：回归测试用一个中途返回错误的 reader 调用下载路径，结束后目标目录没有新增文件，已有同名文件内容不变。

### M2 [中] macOS 上合法的源文件名无法压缩，提示有误导

> **当前状态**：已修复（`7603d32`）。主窗口和 Mini 清洗保留字符/控制字符与设备名，空主干有安全回退，后端仍严格验证。

- **位置**：`internal/imaging/service.go:319-333`（`validFileName`）、`:369`（`compress` 里的校验）
- **现象**：输出文件名由源文件名直接派生，没有清洗：
  - 主窗口：`src/features/optimize/optimizeQueue.ts:18-22`（`makeOutputFileName`）。
  - Mini：`internal/mini/service.go:462`。

  之后 `validFileName` 按 Windows 规则校验，不通过就返回 "The output filename must match the selected format."。
- **触发场景**：源文件名含 `? * " < > | :`，或主干是 `con`、`prn`、`aux`、`nul`、`com1`–`com9`、`lpt1`–`lpt9`（不分大小写）。例如 `what?.png`、`aux.jpg`。Finder 里名字带 `/` 的文件在 POSIX 层是 `:`，同样命中。
- **修复方向**：在派生输出名的地方把非法字符替换掉、给保留名加后缀，保留 `validFileName` 对最终输出名的严格校验。主窗口和 Mini 两条派生路径要给出一致的结果。真正因扩展名不符被拒时，才使用现在这句提示。
- **完成标准**：
  - `a?b:c.png` 和 `con.png` 在主窗口和 Mini 里都能压缩成功，输出名通过 `validFileName`。
  - Go 和前端各有一条针对上述文件名的回归测试。

### M3 [中] S3 错误透传服务商原始响应体；取消和超时被错误归类

> **当前状态**：已修复（`67065de`）。模拟 StringToSign 响应确会透传，但没有证明真实密钥泄漏。修复覆盖请求及正文读取两条取消路径，HTTP 状态和已知 S3 错误码可用于诊断。

- **位置**：`internal/cloud/cloud.go:857`（`s3error`），调用点 `:209`、`:239`、`:295`、`:803`
- **现象**：
  - (a) `s3error` 用 `appErr(code, e.Error())` 包装任何错误。请求被取消或超时时，错误变成 `s3DownloadFailed` 之类的应用错误，`Backend.Call` 里的 `errors.As(appErr)` 先命中，`cancelled` 和 `timedOut` 两个分支（`main.go:207-210`）走不到。用户看到的是 `Get "https://…": context canceled` 这样的 Go 错误串。
  - (b) HTTP 非 2xx 时，`doS3` 读取最多 4096 字节响应体放进 `statusError`（`:850-854`），`Error()` 把它原样拼进消息（`:676`），最终显示在界面上。
- **与现有策略的冲突**：`internal/cloud/r2_probe.go:16-17` 的注释写明 "Provider messages, request IDs, canonical requests and signatures can contain credential material"，并只允许已知错误码过桥。两处策略不一致。响应体里具体带什么取决于服务商，没有实测。
- **修复方向**：
  - (a) `s3error` 遇到 `context.Canceled` 和 `context.DeadlineExceeded` 时原样返回。
  - (b) 只透传 HTTP 状态码和解析出的 S3 错误码。用户已确认纳入本轮，统一保留 HTTP 状态及已知错误码。
- **完成标准**：
  - (a) 回归测试：取消进行中的下载，桥返回的错误码是 `cancelled`。
  - (b) 若采纳：回归测试用含 `<StringToSign>` 的 403 响应体，返回的消息里不包含该内容。

### M4 [中] Windows/Linux 上带 ICC 的图片一律被拒

> **当前状态**：原行为是 README 已声明的限制；用户选择完整方案，已实现（`a3c6fad`）。可移植构建使用随应用内嵌的 LittleCMS 2.20 WASM，覆盖 RGB matrix/TRC 与 LUT profile；保留 16 位、alpha，非 RGB/损坏 profile 仍明确拒绝，范围与原 macOS RGB 支持一致。

- **位置**：`internal/imaging/profile_other.go:1,12-14`（构建约束 `!darwin || !cgo`），调用点 `internal/imaging/service.go:271-275`、`codecs.go:103`
- **现象**：非 darwin 或关闭 cgo 的构建里，`normalizeProfile` 恒返回错误。调用方只判断 `len(metadata.profile) > 0`，没有「已经是 sRGB 就跳过」的分支。`properties.go` 对 PNG `iCCP`（:78-89）、WebP `ICCP`（:115-117）、JPEG APP2（:151-165）都会填充 `profile`。
- **触发场景**：在 Windows 或 Linux 构建里导入任何带内嵌 ICC 的图片，包括最常见的 sRGB profile，报 `colorProfileUnsupported`。相机、手机或图像编辑器导出的文件可能携带 ICC；本轮没有测量此类文件的实际占比。
- **背景**：`README.md:30` 写明 ICC 转换目前只支持 macOS，`README.md:58` 写明 Windows/Linux 尚未验证。但 `.release-targets.json` 已经列入 `windows-amd64`、`windows-arm64`、`linux-amd64`、`linux-arm64`。
- **原方案比较**（用户已选择完整方案并完成）：
  - 最小方案：识别 sRGB profile 并直接放行，其余 profile 维持现在的明确拒绝。
  - 完整方案：引入不依赖 CoreGraphics 的转换实现。
- **完成标准**：`CGO_ENABLED=0 node scripts/go.mjs test ./internal/imaging` 下有一条回归测试，带内嵌 sRGB ICC 的 JPEG 压缩成功；Display P3 样本按所选方案得到转换结果或明确的拒绝信息。

### M5 [中] 缩略图缓存命中也要排队

> **当前状态**：已修复（`cae57da`）。先读缓存、未命中占槽后二次检查；删除只持短缓存锁，以代次防止在途渲染重新落盘。启动/清理时只移除一小时前的 source-*，不碰活跃文件。

- **位置**：`internal/cloud/thumbnails.go:57-63`
- **现象**：容量为 1 的 `thumbnailSlot` 在查缓存（:73-81）之前就被占用。`:57` 的注释说这个槽是为了限制未命中的并发，但缓存命中也在等它。`removeGalleryThumbnails`（:161-167）同样等这个槽，而 `delete_gallery_object`（`cloud.go:212`）会调用它。
- **触发场景**：图库里一张大图的缩略图正在下载和渲染（上限 45 秒，:64）。此时其他已缓存的缩略图不显示，删除对象的操作也不返回。
- **附带问题**：进程崩溃后残留的 `source-*` 临时文件（:103-107）不会被清理，`pruneThumbnails`（:130-159）只处理 `.thumb`。
- **修复方向**：先查缓存，未命中再占槽，占到槽后再查一次缓存以去重。删除路径是否需要等槽取决于「删除后在途渲染又把缓存写回」这个竞争是否需要防，修复时要一并考虑。
- **完成标准**：回归测试里让一次未命中阻塞在 `renderThumbnail`，同时对另一个已缓存的 key 发起读取，后者立即返回。

### M6 [中] Mini 处理动图时给出无法执行的提示

> **当前状态**：已修复（`55ffb99`）。真实合成 APNG 路径回归通过；Mini 给出到主窗口选择格式/帧处理的提示，不静默提取首帧。

- **位置**：`internal/mini/service.go:464`，对应校验在 `internal/imaging/service.go:378-384`
- **现象**：Mini 固定传 `"animationMode": "preserve"`。源文件是动图且不是 WebP 时，`compress` 返回 "Choose First frame only to export a still image from this animation…"。`safeError`（`mini/service.go:499-503`）把这句话原样显示，而 Mini 界面没有「仅首帧」选项。
- **触发场景**：把 APNG 或 AVIF 序列拖进 Mini 或托盘图标。
- **修复方向**：Mini 对非 WebP 动图改用首帧并附带警告，或者显示一条 Mini 能执行的提示（例如引导到主窗口处理）。
- **完成标准**：`internal/mini` 有一条回归测试，APNG 输入得到的结果是成功加警告，或者是一条不提及 Mini 中不存在的选项的错误信息。

### L1 [低] 导出和下载的文件权限是 0600

> **当前状态**：关闭：用户明确要求保留 0600。此为权限策略，不作为本轮实现错误。下述 0644 方案为原始提议，未采纳。

- **位置**：`internal/imaging/export.go:50,75`、`internal/cloud/cloud.go:590`
- **现象**：写到用户所选目录的文件以 0600 创建，其他账户和以其他身份运行的服务读不到。凭据和设置文件用 0600 是 `AGENTS.md` 的要求，用户导出的图片不在这个要求之内。
- **修复方向**：用户可见的输出改为 0644，由 umask 收紧。用户已确认保留当前权限，本轮不执行此建议。
- **完成标准**：导出和下载的回归测试断言文件权限与 `0644 &^ umask` 一致。

### L2 [低] 图库前缀筛选框同时被当作上传前缀

> **当前状态**：已按用户选择修复（`1a0167e`）。空 profile 前缀也原样保留。另以 `77a9aca` 修复新对象与当前可见范围的一致性，见 R1。

- **位置**：`src/features/gallery/S3GalleryPage.tsx:262`
- **现象**：`currentPrefix = prefix || selectedProfile.defaultPrefix || "images"`。`prefix` 是图库的筛选输入，按字符串前缀匹配，可以是输入到一半的内容。
- **触发场景**：筛选框里输入 `ima` 后点上传，对象写到 `ima/...`。
- **修复方向**：上传前缀只取 profile 的默认前缀，或者在上传前明确展示将要写入的前缀。
- **完成标准**：组件测试断言筛选框有内容时，传给 `generateObjectKey` 的 `prefix` 是 profile 的默认前缀（或用户确认过的值）。

### L3 [低] `listUploads` 容错偏弱

> **当前状态**：已按用户选择改进（`4faf946`）。原先整页失败与身份不匹配后清理均有明确测试依据，不是无意实现；现在临时错误/元数据缺失保留记录且提示计数，返回其他已验证对象；明确 404、明确不同 upload ID/ETag 仍清理。

- **位置**：`internal/cloud/uploads.go:131-144`（`verifyUpload`）、`:240-250`
- **现象**：
  - 一批里任意一次 HEAD 返回非 404 错误，整页返回 `s3ListFailed`（:248-249）。
  - HEAD 成功但响应里没有 `X-Amz-Meta-Picpiper-Upload-Id`，或 ETag 不同，记录被判为失效并永久删除（:142-143、:241-243、:223）。经过代理或不回传自定义元数据的端点会把全部历史清空。
- **修复方向**：单条 HEAD 失败时保留该记录并在页面上标记，不让整页失败。元数据缺失和元数据不匹配分开处理，缺失时保留记录。
- **完成标准**：回归测试覆盖两种情况——一条 HEAD 返回 500 时其余对象仍然列出；HEAD 不带元数据头时本地记录仍在。

### L4 [低] 一条坏记录让整个桶的上传历史不可用

> **当前状态**：已修复（`e5e052c`）。单条解码或字段错误会备份并隔离；整份 JSON 损坏、备份失败仍显式报错，避免静默丢数据。

- **位置**：`internal/cloud/uploads.go:46-62`
- **现象**：`loadUploadRecordsLocked` 遇到任意一条校验失败的记录就整体返回错误。依赖它的 `listUploads`（:178-183）、`recordUpload`（:63-69）、`forgetUpload`（:84-90）全部失败，没有恢复手段。
- **触发概率**：记录由应用自己写入（`cloud.go:307`），正常流程下字段齐全。触发条件是文件被外部修改、磁盘损坏，或以后收紧了校验规则。
- **修复方向**：加载时跳过并隔离坏记录，保留其余记录。
- **完成标准**：回归测试在记录文件里放一条 `uploadId` 为空的记录，其余记录仍能列出，新上传仍能写入。

### L5 [低] 设置管理的缺口

> **当前状态**：重复 ID 已修复（`08da7ae`），删除本机 profile/凭据入口已完成（`34db944`）。L5(c) 已确定性复现 Mini 过期快照覆盖，并补修；主窗口完整快照保存及 R2 取消/导入竞态仍待验证，见第 10.1 节。

- **重复 profile ID**（读码确认）：`validateSettings`（`internal/cloud/cloud.go:474-499`）不拒绝重复 ID。secret 文件按 ID 存放，重复 ID 的两个 profile 会共用一份凭据。完成标准：保存含重复 ID 的设置返回 `invalidSettings`，有回归测试。
- **删除 profile 的入口（原始缺口，现已完成）**：原始快照没有删除控件/操作；用户已确认实现。`34db944` 增加确认界面与后端本机删除操作，凭据行为见第 9.1 节。
- **整体覆盖保存**（原始推断，行号需重新定位）：`SettingsPage.tsx` 保存时把 React 状态里的完整设置写回，包括失败回滚时的再次保存。此处尚未构造出实际失败；已确认并修复的是另一路径：Mini 挂载时的旧 `mini` 对象写回，覆盖主窗口后来保存的字段。不能将 Mini 的复现推广为所有设置保存都必然丢更新。

### L6 [低] `update_activity` 租约没有过期机制

> **当前状态**：已修复（`c55289f`）。不是简单固定 TTL：前端每 15 秒续约，两分钟未续约才到期；续约与释放有序，且 active 后端请求和 Mini 任务仍阻止重启。

- **位置**：`updates.go:130-143`，前端 `src/api/updates.ts:33-52`
- **现象**：租约只在前端显式发送 `busy: false` 时删除。WebView 重载或前端异常后，租约永久残留，`prepareQuit`（`updates.go:49-62`）一直认为应用在忙。
- **影响范围**：`prepareQuit` 只在更新已安装时才因为「忙」而阻止退出，所以表现为已下载的更新一直推迟重启。
- **修复方向**：给租约加时间戳和过期时间，或者在页面重新加载时清空该窗口的租约。
- **完成标准**：`updates_test.go` 有一条测试，租约超过过期时间后 `prepareQuit` 返回 true。

### L7 [信息] smoke 驱动编进发布包

> **当前状态**：关闭为预期诊断设计。`docs/releasing.md:99-105` 已明确支持发布产物内的隔离 `--update-smoke`；无需再请用户确认。

- **位置**：`smoke.go`、`smoke_mini.go`、`smoke_desktop.go`、`smoke_settings.go`、`package_smoke.go`、`update_smoke.go` 都没有构建约束；入口在 `main.go:262,270-271`。
- **现象**：`--smoke-test`、`--package-smoke`、`--update-smoke` 在发布的二进制里可用。打包 smoke 要驱动真实的打包产物，看起来是有意的设计。
- **处理**：文档已证实这是预期行为，不需要修改发布入口。

### L8 [低] 性能成本（已测量，优化另议）

> **当前状态**：已取得合成 JPEG 阶段计时及 worker 内存数据，见第 10.3 节。本轮不优化。数据支持对比图生成/传输与方向处理有明显成本；没有历史性能基线，不能称为已证明的性能回归。

以下为原始读码候选；最新取舍见第 10.3 节：

- 全分辨率对比图以 base64 套 JSON 传输，从子进程 stdout 到桥要经过多次完整拷贝（`internal/imaging/worker.go:170-200`、`service.go:507-517`）。`ImageComparison.tsx` 会同时请求两张。
- `applyOrientation`（`orientation.go:175-212`）和 `toneMapHDR` 逐像素调用 `At` / `Set`。
- 一次压缩会打开源文件 3–4 次（`decode` 内部的 `inspect`、`decodeConfig`、`properties`，加上 `service.go:376` 的 `imageProperties`）。
- Mini 每张图都调用一次 `create_optimizer_run`（`internal/mini/service.go:459`），各建一个 run 目录。
- 图库上传前文件被完整读取 2–3 遍：`generate_object_key` 算一次哈希（`cloud.go:329-333`），`upload_gallery_object` 再算一次并上传。

## 5. 待复核的疑点

原审查中的三条均为推断。U1 现已复现并修复；其余结论如下，不因缺少应用层处理就假定解码库没有处理。

- **U1【已复现、已修复】OAuth 成功回调可能丢失响应**：先前 1000 次拒绝回调未覆盖成功路径。追加真实回环 TCP、假 token 交换测试，修复前 2400 次成功回调有 4 次在会话已授权时收到响应头前 EOF。可控回归进一步证实 `Server.Close` 与处理器返回后的响应刷出竞争。`daf66f4` 改为异步、最多等待 5 秒的 `Shutdown`，超时才强制关闭；显式取消仍立即关闭。同批 2400 次修复后全部收到完整页面。真实 Cloudflare 登录的发生率未测，详见第 10.2 节。
- **U2【待 Finder 实测，未修复】主窗口拖放可能短暂报错**：MyGo 0.9.0 的桥保留 DOM drop 并上报原生路径，`OptimizePage.tsx` 原生导入又会清除 `dropError`。独立重跑两条前端模拟：DOM drop 缺少路径时设置错误；随后原生导入清除错误；没有原生事件则错误保留。模拟不证明原生事件时序或实际绘制，补充材料中的「至少渲染一帧」缺少证据。仍需在打包应用里从 Finder 物理拖放验证，见第 10.4 节。
- **U3【当前样本反证，关闭】JXL/HEIC 的方向与尺寸**：`jpegxl@v0.6.0/testdata/or6_ll.jxl` 与 `heic@v0.7.2/testdata/test_exif.heic`（irot=3）的卡片和实际解码尺寸均为 480×640；解码库已返回正确方向的尺寸。未发现需要额外交换尺寸的依据；有新的失败样本时重新打开。原疑点：`internal/imaging/service.go:183` 的宽高交换只覆盖 EXIF 方向和 AVIF `irot`。带方向信息的 JXL 或带 `irot` 的 HEIC，导入卡片显示的宽高是否与解码结果一致没有验证。复核方法：用旋转 90° 的非正方形 JXL 和 HEIC 样本，对比导入卡片和压缩结果的宽高。

## 6. 其他候选

以下候选没有足够证据作为本轮修复项；除标为关闭的已知行为外，保留待验证。它们不计入“已修复”。

- 【待验证，未修复】 `internal/cloud/r2_oauth.go:348-475`（`connectR2Buckets`）：逐个桶串行探测；重复导入同一个桶会产生重复 profile；清理失败的消息里拼了原始错误串；token 名用 `time.Now()` 而不是 `s.now`。
- 【算法差异本身不是缺陷；端点归一化影响待验证】 桶的身份有三种算法：`uploadBucketID`（`uploads.go:38`，不做大小写归一）、`MiniPlan.BucketKey`（`mini.go:127`）、`thumbnailIdentity`。
- 【待验证，未修复】 `internal/cloud/cloud.go:337-340`：渲染出的 key 恰好以默认前缀开头时，不再拼接前缀。
- 【关闭：现有编码策略，README 已区分动画无损】 WebP 质量 100：静态图是有损，动图是无损（`codecs.go:123` 与 `webp_native.go`、`webp_bundled.go`）。
- 【待验证，未修复】 动态 WebP 缩放后不出现 "Resized to…" 警告，因为缩放发生在 `decodeWebPAnimation` 内部。
- 【产品语义待确认，未认定缺陷】 Mini 一次拖入多张时，只把最后一张成功的图片写进剪贴板（`internal/mini/service.go:352-353`）。
- 【待验证，未修复】 `desktop.go:103-126`：面板正在异步关闭时调用 `showPanel`，这次显示会丢失。
- 【待验证，未修复】 `src/features/optimize/useOptimizeUploads.ts`：选中的已上传项被静默跳过；高亮和已上传计数跨批次累积；请求里的 `sourceFilename`、`originalBytes`、`targetFormat` 后端不使用。
- 【默认选择语义待验证，未修复】 `src/features/optimize/CompressionResults.tsx`：`selected` 只初始化一次，后到的结果不会被选中。
- 【现有服务商能力要求，未认定实现缺陷】 上传要求服务商支持 `If-None-Match: *`；`test_s3_connection` 要求 ListObjectsV2 权限，而正常使用不列举桶。
- 【待验证，未修复】 主窗口每次重新排队都清空 `optimizerRun.current`（`OptimizePage.tsx:434,544`），旧的 run 目录要等 7 天清理。


## 7. 与上一份报告不同的结论

- **darwin 的 `RENAME_EXCL`**：上一份报告的 F1 认为 darwin 路径不受无硬链接文件系统影响。本轮实测结果相反，见 H1。
- **`statusError` 携带响应体**：上一份报告第 3 节第 4 条判定不构成缺陷，理由是不含 secret。本轮把它列为 M3(b)，理由是它与 `r2_probe.go` 自己的脱敏策略不一致；用户已选择统一脱敏并完成修复。M3(a) 的取消和超时归类问题不受这个分歧影响。

上一份报告的 5 条发现，本轮在当前代码里看到其中 4 条已有对应处理（非 darwin 的导出回退、AVIF `irot`、构建锁回收、草稿多余资产检查）。第 4 条 smoke 剪贴板只读了 `smoke.go` 开头的快照代码，没有读完恢复部分。

## 8. 本轮检查后没有发现问题的区域

SigV4 规范化与签名、输出路径约束（`under`）、R2 OAuth 的 state/Host/PKCE 校验、任务取消与前端 `taskVersion` 的配合、Mini 队列的持锁入队、`listUploads` 的游标分页、发布工作流的权限与脚本来源。

## 9. 本轮修复交接（2026-11-16）

本节保留 2026-11-16 的交接记录；L5(c)、U1、L8 的后续状态及最新验证以第 10 节为准。

### 9.1 提交与范围

实现快照 `c27b3c8`，仍在用户指定的 `fix/review-findings` 分支；15 个实现提交对应第 3 节各独立问题。L5 分为 ID 唯一性和删除功能两个独立提交。R1 是切换上传前缀后发现的列表范围一致性问题；R3 是最终复查确认的回退复制失败清理安全问题，二者分别提交。本文档状态汇总另作一个提交。

凭据行为：删除 profile 删除本机 `<id>.secret` 并清理默认/Mini 引用；不会发出云端对象删除或 token 撤销请求，不删除桶级上传历史。设置写入失败不会先破坏凭据；凭据移除失败会尝试恢复原设置并显式报告失败。设置和凭据跨文件操作不承诺崩溃时的事务原子性，单个设置/凭据写入仍遵循已有私有权限与原子写策略。

### 9.2 不做与待验证

- **明确不改**：L1 的 0600；L7 的发布诊断入口；U3 当前样本未支持的尺寸交换。
- **当时保留待验证**：L5(c) 过期设置快照覆盖；U1 成功 OAuth 回调刷出竞争；U2 物理 Finder 拖放的反馈顺序；L8 性能测量；第 6 节标为待验证的候选。2026-11-17 的补充复核与取舍见第 10 节。
- **L3 不应倒退的约定**：缺失元数据不等于已被替换，保留本地记录；明确身份/ETag 不同仍视为外部替换。部分结果通过 `unverifiedCount` 和刷新按钮说明；取消请求仍作为取消返回。
- **M4 范围**：完整 RGB ICC profile 转换，而非仅识别几个 profile 名称；RGB LUT 路径有独立合成样本回归。Windows/Linux 桌面窗口和安装包运行验证仍独立于可移植图像引擎测试。

### 9.3 本轮验证

| 验证 | 结果 |
| --- | --- |
| `pnpm test` | 33 个文件、277 个测试通过 |
| `pnpm build:web` | 通过 |
| `pnpm test:go` | 全部通过 |
| `node scripts/go.mjs test -race ./...` | 全部通过，含独立 ICC 实例并发 |
| `node scripts/go.mjs test -race ./internal/imaging -run '^TestModernCodecsConcurrentFirstUse$' -count=1` | 通过 |
| `node scripts/go.mjs vet ./...` | 通过 |
| `gofmt -l main.go main_test.go smoke.go internal scripts/icon` | 无输出 |
| `CGO_ENABLED=0 node scripts/go.mjs test ./internal/imaging -count=1` | 全部通过，含 sRGB JPEG、P3 16 位及 alpha |
| Windows arm64 / Linux amd64 imaging 测试二进制交叉编译 | 通过；仅证明可编译，未在目标系统运行 |
| `pnpm build` | macOS 应用与 DMG 构建通过 |
| `pnpm smoke` | 未全通过：三次均在 URL 激活焦点断言失败；原始 84f25fc 在同一环境对照也失败。此前 40 个步骤完成；截图已检查，见第 9.4 节 |
| exFAT / FAT32 目标卷导出与下载复测 | 两种格式均成功；已有文件未改，导出生成 `review-2.png`，下载生成 `download (2).png`；测试卷已卸载 |

Go 命令通过 `scripts/go.mjs`，测试使用合成数据、假凭据和回环桶；Go 缓存放在私有临时目录以满足当前沙箱权限。单元与行为测试均通过；构建仅出现已有的重复链接库、前端 chunk 大小与本地未签更新包提示。原生 smoke 的失败独立记录如下，未将部分通过称为整套通过。原生系统选择器、物理 Finder 拖放、真实服务商凭据未在本轮自动化中验证。

### 9.4 R2：原生 smoke 的基线同现焦点失败

- 当前实现三次 smoke 均在 `smoke.go` 的 URL 返回激活断言失败：`received=true, minimized=false, focused=false, active=false`。链接已送达，窗口已恢复，但未获得系统焦点。
- 当前报告：`build/smoke-4YZr6x/report.json`、`build/smoke-ZG4Iqf/report.json`、最终实现的 `build/smoke-FtUeXt/report.json`。之前的图像导入/压缩/比较、原生剪贴板、S3 本机上传/下载/删除、六语言、Mini、窗口关闭等步骤完成。最后一项 OAuth completion HTML 展示因中止没有执行，不能声称全套 GUI smoke 通过。
- 对照方法：用 `git archive 84f25fc` 在私有临时目录导出原始代码；复用相同的现有 Node 依赖和静态 codec 缓存，独立构建、打包、运行 smoke，没有切换当前分支。临时目录的 pnpm 依赖结构提示切为 warn，避免自动重装共享依赖；没有更新依赖版本。
- 对照结果：原始版在同一断言得到完全相同的四个状态。对照报告副本为 `build/smoke-baseline-84f25fc-report.json`。这不支持将失败归因于本轮修改；仍需区分当前系统环境的激活限制与已有的焦点实现问题。
- 已目视检查当前版 `settings.png`、`gallery.png`：设置页删除按钮、表单与图库布局正常，无明显重叠或溢出。对应文件位于 `build/smoke-4YZr6x/`；最终实现的 `build/smoke-FtUeXt/settings.png` 与 `minimum-window.png` 也已检查，为私有合成数据截图。
- 本轮保留这个已复现的新问题，不修改焦点实现、不放宽 smoke 断言。下次应先提取仅包含最小化/URL 返回/激活的原生复现，再检查不同前台应用及 macOS 激活时序。

### 9.5 R3：回退复制失败的清理安全

最终复查发现 `copyExclusive` 在复制错误后直接删除最终路径，会删除复制期间由其他应用替换到该路径的文件。先加入可控的实际复制失败回归，观察原实现删除了替换文件；修复后按已打开输出文件的身份与 `Lstat` 结果比较，仅清理仍属于本次复制的路径。下载回退也使用 `Lstat`，避免跟随替换的符号链接。定向导出/下载 race 回归通过；原有半文件清理与同名不覆盖测试继续通过。

## 10. 补充复核与补修（2026-11-17）

用户确认「补修 L5(c)、U1，性能优化另议」，继续当前分支，每个问题独立提交。补充材料来自报告 agent，探针在仓库外的 `/private/tmp/picpiper-review-probes/`，合成性能样本在 `/private/tmp/picpiper-l8/`。下面区分独立重跑、材料中的数据及仍未验证的推断；临时探针不纳入产品代码。

### 10.1 L5(c)：Mini 过期快照覆盖

**已修复：`a4f8806`。**

- **已复现的具体路径**：打开显示 WEBP·90 的 Mini，主窗口随后保存 AVIF；Mini 只把质量改为 85，旧实现却把整份旧 `mini` 写回，落盘 WEBP·85。`enabled`、`profileId`、`linkFormat` 同样可能被旧副本覆盖。独立重跑报告 agent 的前端探针，修复前得到预期 AVIF、实际 WEBP 的失败。
- **修复**：Mini 订阅跨窗口 `settings-changed`，忽略乱序返回的旧设置。压缩弹窗记录打开时的基准，只提交用户实际改动的格式/质量字段。新增 `save_mini_compression_settings` 操作，在后端同一把锁内读取最新设置、验证并合并字段，返回合并结果。因此即使尚未收到通知，或主窗口在弹窗打开后再改设置，也不会用未编辑的旧字段覆盖它。
- **边界**：原 `SaveMiniSettings` 整体替换接口保留，面板改用字段合并接口。此修复不等于解决所有完整设置保存的潜在竞态。主窗口 SettingsPage 的原始覆盖怀疑未复现；R2 导入落盘后取消、前端丢弃返回结果的窄窗口仍只有读码推断，继续待验证。
- **回归**：前端覆盖旧面板只改质量、弹窗打开期间外部改质量而用户只改格式、乱序读及退订；Go 覆盖两个字段的独立/并发合并、无效值不写盘及真实通用桥返回。另增加真实 Mini 窗口与设置通知的原生 smoke 用例，结果见第 10.5 节。

### 10.2 U1：OAuth 成功页被提前关闭

**已修复：`daf66f4`。** 先前仅测拒绝回调，未覆盖成功页，不能据此关闭本问题。

独立重跑使用真实回环 TCP、假 token 交换；12 个 worker、总计 2400 次，修复前丢失 4 次，均为响应头之前 `unexpected EOF`，此时会话已 `authorized`。修复后同批 2400 次全部收到完整成功页。这是并发合成探针的结果，不是实际用户登录的失败率。

机制又通过可控回归验证：在 OAuth 回调返回后，外层 HTTP handler 暂缓返回，使 net/http 的成功响应仍在缓冲区内。旧实现的异步 `Server.Close()` 此时关闭活动连接；新实现异步调用带 5 秒上限的 `Shutdown`，等待活动 handler 结束并刷出响应，超时才强制关闭。显式取消/过期仍走立即关闭路径，不等待回调页面。

`internal/cloud/r2_callback_test.go` 使用真实本机连接比对完整 `r2ConnectedHTML`，并确认授权状态不变；定向 race 和全套 race 通过。没有使用真实 Cloudflare 账号，实际浏览器登录的可见发生率仍未测。本问题与 R2 的应用 URL 返回焦点失败属于两个独立路径。

### 10.3 L8：性能测量与取舍

**本轮只记录，不优化。** 测量环境为 darwin-arm64、12 个可用 CPU；样本是低频渐变加噪声的合成 JPEG（质量 90）。12MP 为 4032×3024、约 2.1 MB，40MP 为 7728×5152、约 6.8 MB，各有 EXIF 方向 6 副本。此处编码体积的 MB 为十进制；分配量/RSS 使用 MiB（探针原输出把除以 1024² 的结果标为 MB）。

12MP 数据已独立重跑，阶段测量与 IPC 分开运行；40MP 数字来自报告 agent 的补充材料，本轮没有独立重跑。没有历史性能基线，也没有真实照片或 GUI 交互延迟数据，不能据此宣称发生了性能回归。

| 阶段 | 12MP：独立重跑 | 40MP：报告 agent 数据 |
| --- | --- | --- |
| 正常方向解码 | 68.83 ms，累计分配 17 MiB | 205 ms，57 MiB |
| EXIF 6 解码（含方向处理） | 275.55 ms，157 MiB，约 2439 万次分配 | 893 ms，513 MiB，约 7963 万次分配 |
| 单独 `applyOrientation(6)` | 212.51 ms，140 MiB，约 2439 万次分配 | 688 ms |
| `comparison()` 进程内合计 | 494.48 ms，累计分配 154 MiB | 1.63 s |
| 其中 PNG BestSpeed 编码 | 430.71 ms | 1.41 s |
| PNG → base64 体积 | 12.9 → 17.2 MB；base64 编码 3.84 ms | 41.8 → 55.8 MB |
| 合成 NRGBA64 的 HDR PQ / HLG | 914.83 ms / 1.37374 s | 2.97 s / 4.50 s |
| `inspect` / `imageProperties` | 80 µs / 30 µs | 70 µs / 30 µs |
| 创建一个 optimizer run | 260 µs | 170 µs |
| 对源文件做 SHA-256 | 660 µs | 2.5 ms |

两张 12MP 同时经过隔离 worker 请求对比图，独立重跑三次：墙钟 579–618 ms；每份桥回复 17,151,768 字节；父进程桥再序列化约 6.7–8.7 ms/请求。三轮后的父进程最大 RSS 为 185 MiB，子进程中的最大 RSS 为 215 MiB/进程。报告 agent 的 40MP×2 为 1.90–1.96 s、每份约 55.8 MB，父进程最大 RSS 667 MiB、单个 worker 最大 518 MiB。

**RSS 的限制**：这些是各进程的历史高水位，未同步采样；相加既可能错开峰值，也会重复计算共享页。补充材料中的约 1.7 GiB 是进程高水位之和的上界估算，不是同时观测到的物理内存占用。WebView 的字符串和位图内存未测，不能称为整个应用的内存峰值。表中累计分配量也不等于存活内存。

本轮结论：

- **保留两处成本判断**：全分辨率对比图生成/传输带来较大的 PNG 编码时间和跨进程内存开销；12MP 的 CPU 时间主要在 PNG 编码，桥再序列化不是主要耗时。常见 JPEG 解码得到的 `*image.YCbCr` 在方向 6 的逐像素处理约有每像素两次分配，并明显增加解码时间。
- **HDR 限定**：PQ/HLG 的成本只在合成 `NRGBA64` 输入上成立；真实 HDR 解码器的输出类型与应用表现未验证。
- **在这些样本上撤回三项优先优化判断**：重复打开/读元数据、Mini 每张图创建 run 目录、重复哈希均为微秒到毫秒级。不能仅从重复调用就认定为当前瓶颈，也不外推到所有磁盘/文件规模。
- **后续再议**：保留 100% 对比语义，先决定是否优化像素访问、对比图编码或传输方式，再以真实照片、AVIF/JXL 大图、HDR 文件及 WebView 内存验收；本轮未改变这些行为。

独立重跑日志位于 `/private/tmp/picpiper-followup-20261117/l8-stages.log` 与 `l8-ipc-quiet.log`；早一轮 IPC 与其他编译重叠，不作为此处计时依据。探针 `zz_l8_probe_test.go` 可通过 Go overlay 放入 `internal/imaging` 重跑，或临时复制后运行：

```bash
L8_DIR=/private/tmp/picpiper-l8 L8_MODE=stages L8_FILES=12mp node scripts/go.mjs test ./internal/imaging -run '^TestZZL8Probe$' -count=1 -v
L8_DIR=/private/tmp/picpiper-l8 L8_MODE=ipc L8_FILES=12mp.jpg:12mp.jpg node scripts/go.mjs test ./internal/imaging -run '^TestZZL8Probe$' -count=1 -v
```

### 10.4 U2、U3 与剩余待验证项

- **U2 保留待物理 Finder 验证**：独立重跑两条 DOM/原生事件模拟均通过，仅证明前端处理器先设置错误、后清除错误，不能证明 macOS 原生派发顺序，更不能证明「至少实际绘制一帧」。缺少原生路径事件时错误保持符合提示含义。本轮没有改代码。
- **U3 继续关闭**：报告 agent 未提供失败文件，并同意已有旋转 JXL/HEIC 的 480×640 反证；没有依据再做一次宽高交换。以后出现失败样本再重开。
- **继续待验证**：真实 Cloudflare 浏览器登录下的 U1 可见性、R2 取消/导入落盘竞态、真实图像与 WebView 的性能、R2 应用 URL 激活焦点问题，以及第 6 节原有未验证候选。不将这些项目算作本轮已修复。

### 10.5 最新实现与验证

两个问题分别提交：

- `daf66f4 fix(oauth): drain callback responses before closing the server`（U1）。
- `a4f8806 fix(mini): merge compression edits into current settings`（L5(c)）。

报告更新独立提交；未推送。仍在原分支，无上游，未切换或创建分支，未 fetch/pull/merge/rebase/reset。用户原有未跟踪文件 `docs/code-review-2026-11-16.md` 未改动。

| 验证 | 结果 |
| --- | --- |
| `pnpm test` | 33 个文件、280 个测试全部通过 |
| `pnpm build:web` | 通过（含 TypeScript 检查） |
| `pnpm test:go` | 全部通过 |
| `node scripts/go.mjs test -race ./...` | 全部通过 |
| `node scripts/go.mjs test -race ./internal/imaging -run '^TestModernCodecsConcurrentFirstUse$' -count=1` | 通过 |
| `node scripts/go.mjs vet ./...` | 通过 |
| `gofmt -l main.go main_test.go smoke.go internal scripts/icon` | 无输出；另检查本轮其余 smoke 文件与新增测试格式 |
| OAuth 成功回调定向 race 与并发探针 | 可控回归通过；2400 次成功页完整到达，修复前同规模丢失 4 次 |
| `pnpm build` | macOS 应用与 DMG 构建通过 |
| `pnpm smoke`（最终） | 未全通过：41 个步骤完成，包括新增 Mini 同步用例；随后在已有的 URL 激活焦点断言失败 |

最终原生报告为 `build/smoke-WXcPXl/report.json`。新增用例通过真实 WebView 操作 Mini 弹窗、从主窗口的后端保存入口触发真实通知，再通过面板桥保存；落盘保留 AVIF、质量 85 和其余 Mini 字段。`mini-settings-synced.png` 与 `settings.png` 已目视检查，文字和控件布局正常。

**新增用例的动画限制**：最初三次在等待弹窗 DOM 移除时超时，报告目录为 `build/smoke-8poD1I/`、`smoke-xicGef/`、`smoke-21dvHO/`。第三次诊断确认点击已到达、磁盘和页头均为 AVIF·85，弹窗已有 `data-closed` / `data-ending-style`，但 DOM 未卸载。尚未确定原生绘制/动画完成时序的原因。最终只在此设置回归期间使用 Base UI 的 `BASE_UI_ANIMATIONS_DISABLED` 并在结束后恢复，避免把设置验证绑在退出动画上；产品动画未改变，最终用例不验证这段动画时序。临时点击/HTML 诊断代码已移除。

**R2 焦点失败仍在**：最终为 `received=true, minimized=false, focused=false, active=false`，与第 9.4 节原始 `84f25fc` 的对照结果一致。本轮没有改焦点逻辑或放宽其断言；OAuth completion HTML 的后续 GUI 展示步骤仍因中止未执行。U1 的完整 HTTP 响应已有独立真实 TCP 回归，不能因此称为全套 GUI 验收通过。

完整检查日志在 `/private/tmp/picpiper-followup-20261117/frontend-checks.log`、`go-checks.log`、`native-build-4.log` 与 `native-smoke-4.log`。Go 使用私有临时缓存及仓库脚本；无真实凭据，测试服务均为本机假服务。构建仍有既存的前端 chunk 大小、重复链接库及本地未签更新包提示。
