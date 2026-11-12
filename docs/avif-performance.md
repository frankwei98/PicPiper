# AVIF 体积与速度优化（2026-11-12）

基线为 `6f374757aae5c4852875fa3495378ea025689592`。本轮先改善相同 quality 下的体积与解码误差，再用静态原生编码改善速度，没有修改 UI quality、预设、输出分辨率或色度采样率。没有运行 Rust，也不据此声称与 ravif 的质量 85 等价。

## 最终配置

- 原生 macOS/Linux：固定 libavif 1.4.2 + libaom 3.14.1，8-bit YUV 4:4:4，原样传入 quality，颜色 speed 6，保留 libavif 默认 IQ 策略。每次编码最多两个线程，应用仍最多两个隔离 worker。
- Alpha 保持 quality 100；独立设置 `alpha:cpu-used=5`，增加无损 alpha 的搜索。输入使用 straight-alpha NRGBA，避免编码前 8-bit 预乘/反预乘带来的颜色舍入；输出声明 sRGB/BT.709 原色与 BT.601 YUV 矩阵。
- `CGO_ENABLED=0`、跨平台目标和其他平台继续使用 bundled WASM。它也改用 speed 6、qualityAlpha 100 和 4:4:4，但不能设置独立 alpha 速度，并保留上游 wrapper 的预乘转换。它的速度比原来的 speed 8 慢；本轮速度提升依赖原生构建。
- AVIF 解码、旋转、色彩/HDR 归一化、预览继续使用现有路径。WASM 调用继续受初始化锁保护，原生编码每次独立创建 encoder。

## 同机对照

Apple M1 Pro，macOS 27.2，Go 1.27.3 / darwin-arm64。每项先预热一次，每轮三次操作，运行三轮，耗时取三轮中位数。比较期间没有并行构建/测试；编码时间包含实际 adapter 的像素转换，不含输入解码、输出解码/质量计算、磁盘写入和 WASM 首次编译。原配置通过同一 benchmark 直接调用 pinned wrapper，qualityAlpha 100、speed 8、4:4:4。

质量 85：

| 输入 | 原字节 | 新字节 | 体积减少 | 原耗时 | 新耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1200×800 JPEG 合成渐变 | 67,126 | 38,405 | 42.8% | 347.9 ms | 83.8 ms |
| 768×512 合成纹理 | 26,793 | 13,492 | 49.6% | 223.0 ms | 39.3 ms |
| 768×512 文字/渐变 | 28,744 | 23,551 | 18.1% | 368.0 ms | 182.0 ms |
| 768×512 透明渐变 | 45,930 | 8,882 | 80.7% | 283.9 ms | 91.4 ms |
| Kodak kodim03，768×512 照片 | 61,153 | 58,435 | 4.4% | 315.8 ms | 83.7 ms |

小体积预设使用的质量 55：

| 输入 | 原字节 → 新字节 | 体积减少 | 原耗时 → 新耗时 |
| --- | ---: | ---: | ---: |
| JPEG 合成渐变 | 26,141 → 15,956 | 39.0% | 317.8 → 71.9 ms |
| 合成纹理 | 13,664 → 7,198 | 47.3% | 200.2 → 32.3 ms |
| 文字/渐变 | 19,483 → 13,860 | 28.9% | 349.4 → 162.0 ms |
| 透明渐变 | 30,553 → 5,682 | 81.4% | 270.0 → 84.2 ms |
| Kodak 照片 | 24,889 → 23,064 | 7.3% | 246.9 → 67.0 ms |

这些输入中，体积、速度和下面的误差指标同时改善；照片的体积收益明显小于合成图。样本数有限，没有置信区间，不能推广为所有照片、透明素材或大图的固定收益，也没有测量峰值 RSS/C 堆内存。

### 画质检查

对同一 decoded source 的 RGB 计算 PSNR 和 8×8 分块 SSIM，透明像素以黑底合成后的显示值比较，alpha 另外逐像素检查。质量 85 的诊断结果：

| 输入 | RGB PSNR，前 → 后 | RGB SSIM，前 → 后 |
| --- | ---: | ---: |
| JPEG 合成渐变 | 41.07 → 43.89 dB | 0.9684 → 0.9840 |
| 合成纹理 | 47.10 → 49.35 dB | 0.9931 → 0.9960 |
| 文字/渐变 | 44.48 → 47.21 dB | 0.9913 → 0.9946 |
| 透明渐变 | 47.90 → 52.74 dB | 0.9942 → 0.9963 |
| Kodak 照片 | 42.05 → 42.37 dB | 0.9759 → 0.9771 |

全部样本的最大 alpha 误差为 0。质量 55 的 PSNR/SSIM 也均提高。RGB PSNR/SSIM 是误差诊断，不是感知质量等价证明；不能拿本轮 quality 55 与 Rust quality 85 的字节数直接排名。回归测试同时要求合成 JPEG 的 AVIF 不超过 45,000 字节、8-bit RGB MSE 不超过 4；原配置稳定失败，新配置 MSE 约 2.72。

### 应用后端流程

同机顺序运行基线提交的独立源码快照与当前代码，使用既有 `BenchmarkIsolatedImagePipeline`：inspect → 原图缩略图 → compress → 实际输出缩略图。输入为上述 1200×800 合成 JPEG、quality 85，每轮三次、三轮中位数。

| 生命周期 | 原耗时 | 新耗时 | 减少 |
| --- | ---: | ---: | ---: |
| cold，新建 worker | 1,279.2 ms | 1,039.2 ms | 18.8% |
| warm，复用 worker | 558.4 ms | 289.5 ms | 48.2% |

流程包含进程、IPC、文件写入和输出解码，不含 GUI/React。冷流程仍承担 WASM AVIF 解码器首次初始化，因此收益小于纯编码。

## 参数选择依据

先用单线程逐项改变参数，排除线程/后端差异：

- speed 8 → 6：WASM 合成 JPEG 从 67,126 降至 38,270 字节，PSNR/SSIM 同时改善，但耗时从约 350 ms 增至 1,747 ms。相同版本的原生编码将 speed 6 降至约 131 ms，双线程进一步降至约 75 ms；最终 adapter 包含转换，约 84 ms。
- speed 5/4：合成 JPEG 为 39,994/39,462 字节，反而略大，单线程约 1.2/1.4 秒。编码启发式不保证速度越慢文件越小，不采用全局 speed 5/4。
- tune=ssim/psnr：合成 JPEG 分别约 56.9/57.1 KB，未取得更好的体积结果，因此保留 IQ 默认策略。
- 4:2:0：部分图略小，但文字图 PSNR 约 47.2 → 33.6 dB，彩色细边受损，因此保留 4:4:4。
- 仅将无损 alpha 的 cpu-used 从 6 改成 5：透明渐变约 22.1 → 8.9 KB，颜色编码数据与解码误差保持一致。比全局降低速度档更有针对性。

探针的时间只用于选择参数；最终表格来自实际 adapter 的独立三轮测试。原始数据见 [最终对照](benchmarks/avif-comparison.txt)、[参数探针](benchmarks/avif-tuning-probes.csv)、[原流程](benchmarks/avif-pipeline-before.txt)、[新流程](benchmarks/avif-pipeline-after.txt)。

## 重现与打包

```bash
node scripts/go.mjs test ./internal/imaging -run '^TestAVIFCompressionSizeAndFidelity$' -count=1 -v
node scripts/go.mjs test ./internal/imaging -run '^$' -bench '^BenchmarkAVIFCompression$' -benchtime=3x -count=3
node scripts/go.mjs test ./internal/imaging -run '^$' -bench '^BenchmarkIsolatedImagePipeline/avif/' -benchtime=3x -count=3
```

可设置 `PICPIPER_AVIF_FIXTURE=/absolute/path/photo.png` 增加一张照片；设置 `PICPIPER_AVIF_OUTPUT=/absolute/path/results` 可保存 AVIF 和解码 PNG，便于目视比较。输出写入与质量计算不计时。本轮照片来自公开 [Kodak 测试集](https://r0k.us/graphics/kodak/)的 [kodim03.png](https://r0k.us/graphics/kodak/kodak/kodim03.png)，SHA-256 `e25ca1ff2f0c0cb5fdfd5f9b0a0bb21ac4c3de3c84a67f35b09a85d3306249db`；图片未加入仓库。

原生源码归档的 SHA-256、版本和构建选项固定在 `scripts/native-avif.mjs`。首次构建需要 CMake、pkg-config、C/C++ 编译器；x86-64 还需要 NASM。静态库缓存在 `.tools/native-avif/`，只构建 AV1 编码器，不额外引入原生解码器或运行时共享 codec 库。与 WebP 共用下载校验/构建锁/缓存逻辑；打包收集 libavif、libaom 和所用第三方组件的许可证。

实现依据为 pinned [libavif codec_aom.c](https://github.com/AOMediaCodec/libavif/blob/v1.4.2/src/codec_aom.c) 的 quality/IQ、alpha codec option 和速度配置，以及 [libavif 构建定义](https://github.com/AOMediaCodec/libavif/blob/v1.4.2/CMakeLists.txt)。

## 验证与代价

已通过前端 146 项测试、`pnpm build:web`、完整 Go 测试、完整 Go race、独立运行的 `TestModernCodecsConcurrentFirstUse` race、`CGO_ENABLED=0` internal 回退测试、vet、gofmt 与 diff 检查。新增回归覆盖体积/误差预算、非零原点子图与 stride、透明边缘与精确 alpha、写入错误、边界尺寸和并发 AVIF 往返；既有色彩/HDR/方向与隔离 worker 取消测试继续通过。

`pnpm build` 与真实打包应用的 `pnpm smoke` 通过，报告为 `build/smoke-8RMCxz/report.json`。已检查 AVIF 全分辨率比较、最小窗口截图，以及 benchmark 解码后的文字、透明渐变和照片。Smoke 也覆盖混合批次、16-bit/HDR/动画、取消、导出及本地 S3 流程；不涉及真实云账号或手动 OS 文件选择器。

静态编码器增加了发行包成本：本机 `.app` 从 **21,015,860 → 27,376,704 字节**（约增加 6.36 MB），可执行文件为 27,189,648 字节，DMG 为 9,653,760 字节。最终应用通过 ad-hoc 签名校验，Mach-O `minos=13.0`，`otool -L` 仅列系统库/框架。没有在 macOS 13 实机或 Linux/x86-64 实测本轮原生构建；Linux CI 已增加 NASM/pkg-config 构建依赖。
