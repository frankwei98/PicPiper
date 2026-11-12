# 图片处理性能改进（2026-11-12）

本次实现包含静态原生 WebP 编码、两个可复用的隔离 worker，以及 PNG 的 8 位 YCbCr 路径和快速无损压缩。基线是 `origin/migration/mygo` 的 `f68b8a2262d12f1f017c3a76fa1db0dba5729079`，修改位于 `codex/perf-image-pipeline`。

## 测量条件

同一台 Apple M1 Pro、macOS 27.2、Go 1.27.3 / darwin-arm64，分别顺序运行基线和修改后的实现，无并行构建或测试。输入沿用既有 benchmark 的 1200×800 合成图，经 quality 98 JPEG 编码并解码。JPEG/WebP/AVIF/JXL 输出 quality 85，不缩放导出；缩略图最长边 1024。每项运行三轮，每轮三次操作，表中为三轮 `ns/op` 的中位数。这是有限样本的本机测量，没有置信区间，不能代替真实照片/大图的吞吐量和峰值内存评估。

这不是先前 Debian 13 ARM64 benchmark 的重跑，也没有重新测量 Rust。基线源码中的 service、worker、codec adapter、编码 benchmark、Go wrapper 和 Go module 与该提交逐文件核对一致；仅加入同一个四阶段 benchmark 文件来补充基线测量。

## 热编码

编码器先预热一次；计时包含 PNG/WebP 所需的像素转换，排除输入 JPEG 解码、文件写入、进程启动和 UI。

| 格式 | 修改前 | 修改后 | 耗时比（前 / 后） | 输出字节（前 → 后） |
| --- | ---: | ---: | ---: | ---: |
| JPG | 11.9 ms | 11.8 ms | 1.01× | 60110 → 60110 |
| PNG | 91.1 ms | 40.2 ms | 2.27× | 898805 → 602522 |
| WEBP | 229.4 ms | 46.7 ms | 4.91× | 26472 → 26472 |
| AVIF | 348.1 ms | 346.7 ms | 1.00× | 67126 → 67126 |
| JXL | 174.3 ms | 169.2 ms | 1.03× | 20481 → 20481 |

PNG 输出由意外的 16 位改为 8 位，像素通道等于原路径的高 8 位。此样本从 898805 字节变为 602522 字节；转换后的默认压缩通常还能更小，本次选用 `png.BestSpeed` 优先改善延迟。其他 PNG 输入可能因此生成更大的文件，真实 16 位输入保持 16 位精度。PNG Go 分配次数从约 960026 次/张降至 27 次，但分配字节约从 4.23 MB 增至 4.71 MB，不能称为降低总分配内存。

WebP 保留 method 4、quality、Exact；原生 libwebp 启用内部线程。样本输出字节数相同不代表所有输入的编码结果都逐字节相同。Go 的 `B/op` 不包含 libwebp 的 C 堆内存。AVIF/JXL 的热编码基本没有改变，收益来自下面的 worker 生命周期。

## 后端四阶段流程

依次通过公开隔离服务调用 `inspect_image`、原图 `read_thumbnail`、`compress_image`、实际编码结果的 `read_thumbnail`。包含进程、JSON IPC、解码、预览、编码和文件写入。它是串行的后端组合基准，不含 GUI 桥接和 React/WebView 渲染，不能当成界面的导入到 ready 延迟。

`cold` 每次新建服务并关闭，包含首次 worker/codec 初始化；`warm` 先完整处理一张图，再复用同一服务。基线即使在 warm 模式仍会为每个请求启动新进程。

| 格式 / 生命周期 | 修改前 | 修改后 | 耗时比（前 / 后） |
| --- | ---: | ---: | ---: |
| PNG / cold | 325.7 ms | 208.6 ms | 1.56× |
| PNG / warm | 312.3 ms | 189.3 ms | 1.65× |
| WEBP / cold | 445.7 ms | 229.5 ms | 1.94× |
| WEBP / warm | 443.1 ms | 213.7 ms | 2.07× |
| AVIF / cold | 2117.4 ms | 1311.8 ms | 1.61× |
| AVIF / warm | 2139.2 ms | 541.4 ms | 3.95× |
| JXL / cold | 1238.9 ms | 1154.7 ms | 1.07× |
| JXL / warm | 1260.2 ms | 423.4 ms | 2.98× |

worker 按需启动、每进程顺序处理，忙碌和空闲进程合计最多两个。健康 worker 在业务错误后继续复用；取消或协议/进程失败会终止并回收进程，取消时删除未完成输出，后续请求重新创建 worker。应用关闭会回收空闲进程。缓存编译状态会提高空闲时的常驻内存，本轮没有测量峰值 RSS；流程 benchmark 的分配指标也只涵盖父进程。

## 构建与行为验证

静态 WebP 使用官方 libwebp 1.6.0 源码归档，SHA-256 为 `e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564`。首次通过 `scripts/go.mjs` 构建/测试需要网络、CMake 和 C 编译器；源码和静态库缓存在 `.tools/native-webp/`。打包时收集 COPYING 和 PATENTS。保留 `nodynamic`，AVIF/JXL/HEIC 不会跟随本机共享库切换；WebP 动画继续使用原有 bundled 实现。显式 `CGO_ENABLED=0` 或通过 GOOS/GOARCH 指定其他目标时，保留便携 WebP 回退。

MyGo 默认会在嵌套构建时禁用未显式设置的 cgo，wrapper 现在显式启用它。Darwin 编译/链接的部署目标固定到 Go 1.27 已要求的 macOS 13，应用声明从旧的 12.0 修正为 13.0，避免继承构建机器 SDK 的 27.2。最终 Mach-O 的 `minos` 已验证为 13.0；这不代表已在 macOS 13 实机测试。

已通过：

- `pnpm test`：14 个测试文件、146 项测试。
- `pnpm build:web`、`pnpm test:go`、全量 Go race、独立进程的 modern codec 首次并发 race、`CGO_ENABLED=0` 的 internal 测试、`go vet`、gofmt 和 diff 检查。
- PNG 的 8/16 位精度、非零原点子图、透明像素；原生 WebP 的 alpha、子图 stride、边界尺寸和写入错误。
- worker 的进程复用、业务错误、崩溃恢复、取消后清理、比较任务占用释放和关闭回收。
- `pnpm build` 和最终 `pnpm smoke`。GUI smoke 报告为 `build/smoke-WBoZtK/report.json`，覆盖格式转换/比较、混合批次、16 位/HDR/动画、取消、导出以及回环 S3 流程。已检查 WebP 比较、精度、HDR、动画和最小窗口截图。
- 最终应用通过 ad-hoc 签名验证，`otool -L` 仅列出系统库/框架，没有 Homebrew/libwebp 动态依赖。

本机 pnpm 11.8 的运行前依赖检查触发了重新安装；验证命令使用 `pnpm_config_verify_deps_before_run=false`，此前已成功执行 frozen-lockfile 安装。未改变 lockfile。Cgo 的静态库 flags 在多个包间重复，Apple linker 会提示忽略重复库；构建和签名均成功。

## 复现与剩余工作

```sh
node scripts/go.mjs test ./internal/imaging -run '^$' \
  -bench 'BenchmarkEncodeFormats|BenchmarkIsolatedImagePipeline' \
  -benchmem -benchtime=3x -count=3
```

原始日志：[修改前](benchmarks/image-pipeline-before.txt)、[修改后](benchmarks/image-pipeline-after.txt)。要复测基线，在该提交的独立源码目录加入相同的 `pipeline_bench_test.go` 后运行同一命令；不要把新的 worker 协议或 PNG helper 带入基线。

本次没有改变 JPEG 编码器、AVIF/JXL 编码参数或并发上限，也没有实现跨请求复用解码像素。后续可继续测真实照片、截图、透明图和 12MP/40MP 大图，再评估重复解码、比较图的 PNG/base64 传输，以及高 RSS 时的空闲 worker 回收。当前 macOS 测量不能推出 Linux 速度或已达到 Rust 性能。
