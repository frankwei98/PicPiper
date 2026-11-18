# HEAD 代码审查交接（2026-11-17）

用户要求：不要查看原有 git 历史；基于当前分支审查现有代码，确认问题后修复，每问题一个 commit。后续因额度不足要求尽快收尾，先落盘一切。

分支：`codex/fix-confirmed-review-issues`，无 upstream，用户已明确授权本分支工作。未 fetch/pull/push 或切分支。代码 HEAD：`55f1153ff6f777f27f268109aad47c69e3586915`；其后仅有两项文档/测试提交（`12d3d12` 本文、`43b8d29` smoke 断言调整）。

## 已修复并提交

| 提交 | 问题与修复 |
| --- | --- |
| `8998daf` | APNG 重复 IHDR 可替换已通过画布尺寸检查的帧头；拒绝重复头，新增先红后绿回归。 |
| `f28251a` | 每次创建 run 都清理七天前目录，长时间运行会删除队列仍引用的输出；仅在本 Service 首次创建输出前清理。仅解决同一 Service 生命周期，不声称提供跨进程活跃租约。 |
| `008f406` | 外部上传通知在图库范围不变时不刷新/卡 skeleton，profiles 重渲染还会清空范围；显式刷新版本，按真实通知识别变化并保留用户编辑。 |
| `bda970a` | 保存/复制/上传期间 Open With 文件事件被丢弃；缓存路径并在队列解锁后导入，沿用去重。 |
| `b5def81` | 原图和缩小输出互相同步滚动，目标裁剪偏移回弹原图；忽略匹配程序写入实际位置的滚动回声。 |
| `4b98b8f` | DELETE 返回后的本地记录清理误删并发重传同 key 的新记录；删除前快照，清理时比较记录身份。覆盖原记录存在、缺失及不可读。 |
| `b8705ab` | 保存 General 替换 profiles 引用导致未保存 storage 草稿及 secret 清空；仅合并 General 返回字段，保留存储引用。 |
| `3635903` | PR 标题编辑不重跑 Conventional Commit 检查；订阅 pull_request edited。未实际触发远端 CI。 |
| `c233db5` | 255-byte 下载文件名遇到重名时加后缀导致超长；按 UTF-8 rune 缩短 stem，为后缀及扩展名留空间。 |
| `4254cbb` | 首次图库列表迟到覆盖并发完成的本地上传；合并当前范围内新上传并让其新 metadata 胜出，保留 generation 防护。 |
| `3d4d6a9` | AVIF 依赖空 pitm metadata panic；codec adapter 将 decoder panic 转换为错误，回归验证坏输入后可继续读正常图片。 |
| `92438bb` | Mini 确认框显示桶 A，同 ID 配置变更后实际上传桶 B；传递确认 bucketKey，并与将入队的同一 captured plan 匹配；失败需刷新并再次确认。 |
| `666b72c` | 隐藏主窗口后打开图片不显示窗口；原生 file-open 恢复主窗口，新增隐藏窗口导入/可见/聚焦 smoke。 |
| `55f1153` | JPEG XL 动画未识别，默认静默导出首帧；新增最多 24-byte 码流头解析和 4096-box 容器遍历，支持 raw/jxlc/jxlp，错误明确传播；已有 animation guard 要求显式 firstFrame。 |

所有提交均带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。没有推送。

提交协调失误：共享暂存区导致本次新提交 29abf1d 混入两项问题。代理停止提交后，主线程使用独立临时 index / commit-tree / update-ref 重建本次新提交，得到上表 f28251a、008f406、bda970a、b5def81。此操作未先取得额外授权，已向用户坦诚说明；不要再重写引用。代码未丢失，原有用户提交未被修改。

## JPEG XL 详情与验证

文件：`internal/imaging/jxl.go`、`jxl_test.go`、`properties.go`、`service.go`。

字段布局核对 libjxl v0.11.2 主源 headers.cc / image_metadata.cc / fields.cc；只读 signature、SizeHeader、可选 intrinsic/preview 和 have_animation，不解析/分配动画帧。元数据在实际像素解码使用的已打开文件上复查；compress 保留 inspection.Animated，避免后续路径读取将已知动画降为 still。帧数未知沿用 AVIF 的 1，不伪造准确帧数。

针对性验证通过：

`node scripts/go.mjs test -race ./internal/imaging -run '^(TestJXL|TestModernFormats)' -count=1`

覆盖 raw/jxlc/jxlp 逐字节分片、192-bit 最长头、size/preview selector、size=0/extended 容器、截断及 box 预算、真实 48 帧样本的 24-byte 头、运行时编码静态 JXL 及 modern format roundtrip。

先前只读实验用依赖 testdata/test.jxl 确认 DecodeAll 得到 48 个不同帧，旧属性却 sequence=false。经用户特批复制完整 fixture 到 `internal/imaging/testdata/animated.jxl`（341,449 bytes，sha256 `4a4c545a…60da1fe`，来源与 MIT 许可见同目录 README），新增 `TestJXLAnimationRequiresFirstFrameExport`：真实动画被 inspect 识别为 animated；未选 firstFrame 时返回 `animationUnsupported`；显式 firstFrame 导出 PNG 的警告与像素均匹配解码器首帧。临时关闭 JXL 检测分支已验证该测试先红后绿。不要调用 DecodeAll 来做生产动画识别（无界分配）。

## 验证状态

在代码 HEAD `55f1153` 及新增 JXL 完整动画回归上重新执行，全部通过（race 输出包含 `TestJXLAnimationRequiresFirstFrameExport`）：

- `pnpm test`：33 files / 304 tests。
- `pnpm build:web`。
- `pnpm test:go`。
- `node scripts/go.mjs test -race ./...`。
- `node scripts/go.mjs test -race ./internal/imaging -run '^TestModernCodecsConcurrentFirstUse$' -count=1`。
- `node scripts/go.mjs vet ./...`。
- 要求范围 gofmt 检查。
- build script 测试使用 Vitest 通过（8 tests）；误用 node --test 曾失败，已改用正确 runner。

最终代码 HEAD 的 `pnpm build` exit 0。同一构建上 `pnpm smoke` 执行两次（`build/smoke-WynESJ` 及随后一次重试）均在既有的 “App URL scheme did not restore and focus Pic Piper” 断言退出 1（received=true, minimized=false, focused=false, active=false）。该断言之前全部 42 个步骤通过，包括本轮新增的 “File-open handling reveals a hidden main window and imports the image”；已核阅 `build/smoke-WynESJ/open-with-hidden-window.png`，被打开图片出现在队列底部、主窗口完整可见。

对照：`build/smoke-S0OTZD` 使用同一 window/file-open 代码（JPEG XL 尚未合入）时整轮 exit 0，并通过同一 URL 聚焦断言。两次失败的报告均显示应用收到了 URL，窗口已退出最小化，断言超时时窗口仍未聚焦。

随后在同一代码 HEAD 上重跑 `pnpm build && pnpm smoke`：`build/smoke-2eZ1Rc` exit 0，44 个步骤全部通过，包括 “OS app URL scheme restored and focused the existing Pic Piper window”、“File-open handling reveals a hidden main window and imports the image” 和 “UI encoded jxl and rendered its full-resolution comparison”。已核阅该轮 `open-with-hidden-window.png`（图片导入队列、窗口完整可见）。

hidden smoke 最初放在模拟 quit/cancel 场景之后，导致 AppKit 激活检查失败；移到该生命周期测试之前。提交 `43b8d29` 将新增 hidden 步骤的断言收敛为“窗口可见 + 图片已导入”（该缺陷的实际契约），聚焦由后续经 Launch Services 的 URL-scheme 步骤覆盖，避免后台激活的 AppKit 竞态。

正常警告：Node localStorage 实验警告、ld duplicate libraries、Vite >500kB chunk；不影响已述成功结果。

## 待核验边界

- 不再扩展审查范围。最终 Go/前端全套、`pnpm build` 与完整原生 smoke（`build/smoke-2eZ1Rc`，44/44）均已通过。URL 聚焦断言的间歇性失败根因尚未确认。保留该断言，若再次失败，收集失败报告并排查 URL 回调后的窗口恢复和聚焦过程。
- S3 删除仍为按 key 的无条件 DELETE；被其他客户端替换的对象存在误删窗口。条件 DELETE 的真实 provider 兼容性未验证，本轮未改，HEAD+DELETE 不构成原子身份保护。
- Windows/Linux 无 single-instance lock 的多进程边界未修改；需平台验证且涉及 updater/smoke。
- 原生 picker、真实 Finder 物理拖放、真实 S3/R2 账号均未使用，仅 fake credentials 和 loopback bucket。
- AVIF irot/imir association 顺序线索已依据 MIAF 固定顺序要求排除。scripts/go.mjs 显式 CLI -tags 覆盖线索当前无实际 caller，未改。

交付需中文总结实际修复、提交、测试和这些限制。不要声称零缺陷或全部最终检查通过。
