# Go/MyGo image codec selection

Later implementation updates: [native WebP and worker reuse](image-pipeline-performance.md), then [native AVIF and compression tuning](avif-performance.md). The recommendations below describe the earlier codec-selection review.

Research date: 2026-11-12. Scope: macOS arm64 first, Go/MyGo desktop app, two-digit decimal MB app package, no local Rust installation, still-image read/write for WebP, AVIF, JPEG XL, and HEIC. This compares the exact modules in [`go.mod`](../go.mod) with Apple Image I/O and native codec stacks. It does not repeat the implementation or test results in [`mygo-codec-results.md`](mygo-codec-results.md).

The later [workbench polish](image-workbench-polish.md) adds cancellable worker processes, 16-bit PNG handling, animated WebP preservation and a small CoreGraphics RGB profile conversion bridge. It records the latest package sizes and validation; the measurements below describe this earlier codec-selection review.

## Recommendation

Keep the pinned bundled Go/WASM codecs as the product baseline for WebP, AVIF, and JPEG XL. Keep the pinned HEIC decoder for now. The current app report establishes that this specific build works without Rust installed and produces a 20.67 MB app; it also records feature checks and warm encode samples. The selected implementations provide a fixed codec set without depending on installed shared codec libraries, while remaining inside the requested package-size range. This is not evidence of verified runtime behavior on platforms other than the tested macOS arm64 system.

Consider a separate macOS-only Image I/O HEIC decode path as a measured follow-up, not a wholesale codec replacement. HEIC is the best candidate because Apple owns the framework and the OS can supply decoding without bundling an HEVC decoder. Whether this materially shrinks the app cannot be established from the current aggregate package report. It would make HEIC availability/fidelity depend on OS behavior and require a maintained purego/CoreFoundation bridge. Keep the bundled decoder as fallback if that bridge cannot guarantee the current HEIC import contract. There is no verified evidence here that Image I/O on the configured minimum macOS 12 provides all requested encoders or AVIF/JPEG XL support.

Do not adopt libvips/libheif as the default distribution strategy for this app. They can provide broad codec coverage, but require shipping and managing a native library/dependency/plugin set or imposing installation requirements. That conflicts with the strongest current product properties: a self-contained app and no codec installation. Native libraries remain an option if later measurements show the WASM package/runtime cost or throughput is unacceptable and the app accepts native packaging complexity.

## Evidence and limits

| Criterion | Pinned gen2brain modules in this repository | Apple Image I/O via purego | libvips / libheif |
| --- | --- | --- | --- |
| Format coverage | The current app report establishes this build's WebP, AVIF, JPEG XL read/write and HEIC read behavior. The pinned HEIC package is a decoder. | Image I/O has source and destination APIs; Apple exposes APIs to query supported source and destination type identifiers. Those APIs report what the running system supports, not a fixed format matrix. Apple documentation found `UTTypeWebP`; it does not establish the complete read/write matrix for macOS 12 or the configured minimum. HEIC is the plausible native use; AVIF/JXL support at the minimum is **unknown** from the sources reviewed. | libvips documents WebP, HEIF/AVIF, and JPEG XL loaders/savers, with optional codec libraries. libheif supplies HEIF/AVIF handling and supports backend plugins. Availability depends on how both it and its codec dependencies were built. This is project capability, not proof of a particular packaged configuration. |
| Package and deployment | The checked-in report measures the actual `.app` at 20,668,625 bytes (20.67 MB), including the app and current codecs; the isolated size contribution per codec is **unknown**. No system codec install is required in the reported `nodynamic` build. | The framework is part of macOS, so no codec shared library needs to be bundled for framework operations. The achievable app-size reduction is **unknown**; a bridge and any fallback still have costs. System feature availability becomes OS-dependent. | A self-contained package must ship libvips, libheif, required codec libraries, and any chosen plugins, plus meet their loader/signing/notarization requirements. Exact arm64 `.app` size is **unknown**; no comparable package measurement was found. Requiring Homebrew-installed libraries would violate the no-install product goal. |
| Build and maintenance | Go module versions are pinned. README implementation paths use embedded WASM plus wazero (some projects can first use a dynamic library; the checked-in build disables that via `nodynamic`, per the existing report). The upstream assets are prebuilt; local Rust is not required. App code owns config, limits, concurrency control, and the wrapper surface. | purego provides `Dlopen`/`RegisterLibFunc` for exported C symbols, so binding the framework's C API is technically possible without cgo. Image I/O APIs use CoreFoundation/CoreGraphics reference objects and CF ownership rules. Correct Go bindings, CFData/URL conversion, object release, type discovery, pixel extraction, error mapping and macOS-only build separation become app-maintained code. This path is **not** a one-line function call or an official Go binding. | libvips/libheif are mature C/C++ projects but add native build and packaging surfaces. Build options determine codecs. Plugin discovery, architecture compatibility, dynamic-library loading, licenses/notices, signing and security updates must be managed. Rust-free is possible with native C/C++ build chains, but that is not equivalent to a lightweight Go-only pipeline. |
| Direction, alpha, color | Existing report records orientation coverage for JPEG/PNG/WebP and flags incomplete AVIF/HEIC orientation coverage. It does not establish HDR, wide-gamut ICC or high-bit-depth roundtrip guarantees. Alpha has a tested path in AVIF/JPEG XL and WebP as described in that report. Do not infer equivalent behavior for every codec from library-level support claims. | Image I/O exposes orientation and profile metadata and returns decoded images, but correct transform application, alpha/pixel format conversion and color-management policy still need explicit app handling and regression fixtures. Apple docs establish metadata APIs, not this app's end-to-end output fidelity. Exact format-specific behavior on macOS 12 is **unknown**. | libvips/libheif expose broad read/write functionality and metadata options, but actual fidelity depends on the selected backend and encode/decode settings. The sources reviewed do not prove app-equivalent orientation, alpha, ICC/HDR, or high-bit-depth behavior for a chosen build. It would require fixture-based validation. |
| Performance | The existing report has one warm synthetic encode sample only (WebP 110.73 ms, AVIF 174.69 ms, JPEG XL 89.13 ms); it excludes initialization and does not generalize to photos or batches. No comparative claim is justified. The app serializes WASM codec work due to observed shared initialization/config state; the reviewed independent WebP path is exempt. | Image I/O may use optimized system implementations, but no direct comparative benchmark for these workflows was found. Treat performance advantage as **unmeasured**. | Native libraries may avoid WASM overhead, but no app-specific apples-to-apples benchmark was found. Treat performance advantage as **unmeasured**. |
| License | The Go wrappers' repository pages identify MIT licenses, and the pinned package reports include bundled upstream notice texts. Because vendored/bundled codec assets can have their own license files, continue using the project's generated notice collection; do not infer every embedded component is MIT from the wrapper license alone. | Apple system frameworks are OS components rather than libraries this app redistributes. The app still owns its bridge code and its distribution policy. | libvips is LGPL-2.1-or-later; libheif is LGPL-3.0-or-later in its current README, with some bundled samples under MIT. Codec backends have separate licenses and patent implications; audit the exact configured dependency graph before shipping. |

## Specific assessment of the pinned set

- [`github.com/gen2brain/webp v0.6.4`](https://github.com/gen2brain/webp/tree/v0.6.4): wrapper README describes libwebp transpiled from WASM to Go and a decoder/encoder. It attempts dynamic-library use unless disabled by build mode. The repository identifies MIT; bundled libwebp notices remain relevant. The current app's `nodynamic` build makes the embedded path deterministic.
- [`github.com/gen2brain/avif v0.6.0`](https://github.com/gen2brain/avif/tree/v0.6.0): wrapper README describes libavif in WASM run by wazero, with dav1d decode and aom encode components, with dynamic-library use available unless disabled. The current app report says its selected path is WASM. Wrapper license in the exact tag should be confirmed against the checked-in notices before redistribution; this research did not establish every transitive codec license from the tag source.
- [`github.com/gen2brain/jpegxl v0.6.0`](https://github.com/gen2brain/jpegxl/tree/v0.6.0): README describes libjxl WASM and dynamic-library fallback. The current app report says default WASM path, and explicitly notes that the optional wasm2go path is not used. That report records a shared decoder/encoder configuration concern and concurrent first-use race, addressed locally by serialization. The pinned module is therefore functional but has concurrency cost and app-specific synchronization obligations.
- [`github.com/gen2brain/heic v0.7.2`](https://github.com/gen2brain/heic/tree/v0.7.2): README describes HEVC-in-HEIF decoding, using a Rust-produced WASM asset with wazero or optional dynamic libheif; it is a decoder, not an encoder. Consuming the prebuilt WASM does not require Rust locally. The wrapper identifies MIT, but bundled decoder notices are still controlling for redistribution. Its narrow read-only role makes it the sensible system-API migration candidate.

Upstream package documentation describes potential dynamic-library behavior, but the current app report says the build uses `nodynamic`, so those possible paths are not assumed to ship. Likewise, libvips/libheif's format matrices are not treated as evidence that any unspecified binary has been configured with those codecs.

## Image I/O: actual benefit and maintenance cost

Apple's `CGImageSource` reads image data, and `CGImageDestination` writes it. `CGImageSourceCopyTypeIdentifiers()` and `CGImageDestinationCopyTypeIdentifiers()` return runtime-supported format identifiers. This is valuable capability discovery and permits graceful fallback. Apple's UTI docs define WebP, but the documented identifiers are not a promise that the minimum OS supports every desired operation. The project currently targets macOS 12, so any proposed format must be checked on macOS 12 and current macOS before claiming support.

A purego bridge is plausible: purego can dynamically load a system framework and bind exported C functions without cgo. That can avoid an additional cgo bridge while satisfying the no-Rust constraint, but does not erase native API responsibilities. The app must safely manage CF ownership, CFData and image references, inspect frame count/dimensions, normalize orientation, map the decoded image into Go pixels, preserve alpha, decide color-space conversion, and map errors. Source/destination type lists should be queried at runtime. Framework constants and CF type encodings require careful bindings; Objective-C-only APIs cannot be assumed callable through the C-symbol mechanism. A small native shim can simplify these APIs but adds app-maintained platform-specific code. The macOS MyGo build already requires a native compiler; avoiding Rust does not require avoiding cgo.

The likely benefit for HEIC is less bundled decoder data and use of Apple's own OS-supported HEIF stack. Neither package reduction nor faster performance is measured. A system-only HEIC implementation also narrows support to Apple platforms and gives behavior to the OS version and installed image components. Adding HEIC writing would require a destination path with quality settings, capability discovery, and output regressions; the existence of `CGImageDestination` alone does not establish that implementation.

**Selection:** retain current HEIC decoder until an Image I/O spike demonstrates (1) macOS 12 and current OS can decode the product's representative HEIC files, (2) orientation, alpha and color behavior match the current contract, (3) error handling is robust, and (4) package reduction is worthwhile. If validated, prefer Image I/O for HEIC decode on macOS and retain the current decoder as fallback only if package-size and support goals still justify it. Do not replace WebP/AVIF/JXL encoders based solely on Apple API availability.

## libvips and libheif: scope and distribution tradeoff

libvips documents its format operations as adapters to codec libraries: WebP through libwebp; HEIF/AVIF through libheif; JPEG XL through libjxl. It describes JPEG XL support as experimental in its current documentation. libheif supports HEIC and AVIF through build-selected codecs (for example libde265/x265 or dav1d/aom among its documented options), and supports built-in or dynamically loaded codec plugins. This design can provide a broad native toolbox, but does not define a small, self-contained Go package.

For Pic Piper, packaging a reliable libvips/libheif stack means pinning and building an arm64 dependency graph, controlling plugin discovery, including licenses/notices, signing every embedded dynamic library, and testing the final signed app. If the app instead relies on Homebrew libraries, users must install them and versions can differ. Both are viable for a native image-processing product, but add more build/release maintenance than the current two-digit MB WASM app. No source reviewed gave a package-size number comparable to Pic Piper, so “too large” is not asserted; it is a distribution complexity tradeoff.

## Version-specific maintenance findings

The existing report's concurrency issue is concrete app evidence: modern codec WASM runtime first-use initialization raced, and JPEG XL's decoder/encoder use shared configuration. The report says a global mutex resolves the observed race. This is a real throughput and maintainability cost, especially for batches, even though current measurements do not quantify the cost. Keep that synchronization unless a controlled source-level review and regression establishes that a newer selected code path is safe.

A direct GitHub API check on 2026-11-12 returned these first three tags for each repository: WebP `v0.6.4, v0.6.3, v0.6.2`; AVIF and JPEG XL `v0.6.0, v0.5.3, v0.5.2`; HEIC `v0.7.2, v0.7.1, v0.7.0`. The first tag in each official list matches the current pin ([WebP tags](https://api.github.com/repos/gen2brain/webp/tags?per_page=3), [AVIF tags](https://api.github.com/repos/gen2brain/avif/tags?per_page=3), [JPEG XL tags](https://api.github.com/repos/gen2brain/jpegxl/tags?per_page=3), [HEIC tags](https://api.github.com/repos/gen2brain/heic/tags?per_page=3)). No newer tagged fix for the observed races was established. Generic WASM runtime improvements alone would not prove the JPEG XL shared configuration was fixed; inspect the exact implementation and repeat the isolated first-use regression before changing synchronization.

## Immediate selection actions

1. Keep the current pins and `nodynamic` build path as the release baseline; it already meets no-local-Rust and package-size goals with evidenced behavior.
2. Keep serialization for the WASM paths (AVIF, JPEG XL, HEIC). The 2026-11-12 implementation review below establishes a narrower exception for the independent translated WebP implementation. Do not extend that exception to other backends without source review and isolated first-use race tests.
3. Treat HEIC system decode as a bounded optimization candidate. First query actual source type support and test the configured macOS 12 minimum; measure packaged app delta and test representative EXIF/HEIF orientation, alpha and color fixtures. Avoid switching on API existence alone.
4. Do not choose libvips/libheif for the default bundle unless package-level benchmarks show a compelling speed/quality advantage and release engineering accepts a native dependency/plugin bundle.
5. Continue distributing generated codec notices and audit each exact embedded codec/backend license; wrapper license labels are not sufficient for bundled binaries.

## Applied review changes (2026-11-12)

No codec module was replaced or upgraded. Selection remains WebP/AVIF/JPEG XL through the pinned bundled implementations, and HEIC through the pinned decoder. HEIC encoding is not added by this review.

1. Removed WebP configuration, decoding and encoding from the WASM mutex. The selected `nodynamic` WebP implementation creates a separate translated module per operation, rather than using the shared wazero runtime ([fixed source](https://github.com/gen2brain/webp/blob/v0.6.4/webp_wasm2go.go)). JPEG/PNG/WebP can now proceed independently; the service's two-worker bound remains. No measured batch speedup is claimed.
2. Replaced the encoder's default-to-JPEG-XL branch with an explicit JPEG XL case and an unsupported-format error. Invalid formats must return an error without writing a different image container. The public service already validates its targets; this prevents future adapter callers from producing mislabeled output.
3. Expanded the isolated first-use regression to overlap real WebP encoding, content inspection and decoding with AVIF/JPEG XL/HEIC operations. Added invalid-target byte-output checks.

Validation: all 128 frontend tests, production frontend build, Go tests, isolated first-use race test, full race suite, vet, formatting and `git diff --check` passed. Rebuilt app remains 20.67 MB; warm full build took 9.68 seconds in this run. Local signature validation passed. The actual packaged-app smoke completed in `build/smoke-9QcCqV`, exercising format switching, full-resolution comparison, export and the private loopback S3 workflow. These checks do not establish native Image I/O fidelity or production-provider interoperability.

## Primary sources

### Project baseline

- [Existing codec evaluation and measurements](mygo-codec-results.md)
- [Pinned module versions](../go.mod)
- [MyGo macOS minimum version and file types](../mygo.json)

### Fixed wrapper sources

- [gen2brain/webp v0.6.4 README/source](https://github.com/gen2brain/webp/tree/v0.6.4)
- [gen2brain/avif v0.6.0 README/source](https://github.com/gen2brain/avif/tree/v0.6.0)
- [gen2brain/jpegxl v0.6.0 README/source](https://github.com/gen2brain/jpegxl/tree/v0.6.0)
- [gen2brain/heic v0.7.2 README/source](https://github.com/gen2brain/heic/tree/v0.7.2)
- [purego v0.11.1 source and API docs](https://github.com/ebitengine/purego/tree/v0.11.1)

### Apple APIs

- [Image I/O framework](https://developer.apple.com/documentation/imageio)
- [CGImageSource](https://developer.apple.com/documentation/imageio/cgimagesource)
- [CGImageSourceCopyTypeIdentifiers](https://developer.apple.com/documentation/imageio/cgimagesourcecopytypeidentifiers())
- [CGImageDestination](https://developer.apple.com/documentation/imageio/cgimagedestination)
- [CGImageDestinationCopyTypeIdentifiers](https://developer.apple.com/documentation/imageio/cgimagedestinationcopytypeidentifiers())
- [Image I/O image properties](https://developer.apple.com/documentation/imageio/image-properties)
- [Image orientation property](https://developer.apple.com/documentation/imageio/kcgimagepropertyorientation)
- [ICC profile name property](https://developer.apple.com/documentation/imageio/kcgimagepropertyprofilename)
- [UTTypeWebP](https://developer.apple.com/documentation/uniformtypeidentifiers/uttypewebp)
- [Core Foundation CFRelease ownership API](https://developer.apple.com/documentation/corefoundation/cfrelease)

### Native alternatives and licenses

- [libvips format capability documentation](https://www.libvips.org/API/current/const.CONFIG.html)
- [libvips 8.17 HEIF save API](https://www.libvips.org/API/8.17/method.Image.heifsave.html)
- [libvips 8.17 JPEG XL save API](https://www.libvips.org/API/8.17/method.Image.jxlsave.html)
- [libvips project license](https://github.com/libvips/libvips/blob/master/COPYING)
- [libheif README: codec backends, plugins, build and license](https://github.com/strukturag/libheif/blob/master/README.md)
- [libheif license](https://github.com/strukturag/libheif/blob/master/COPYING)
