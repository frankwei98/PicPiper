# Image compression workbench polish

Date: 2026-11-12. Implementation on the user-selected `migration/mygo` uses Go/MyGo without Rust. The user subsequently requested separate commits for acceptance. Production S3 writes and public release are outside this work.

## Product acceptance

- An image-focused workbench replaces the large card grid: compact batch list, large selected-image preview, output inspector and persistent export actions.
- Imports automatically process, repeated imports do not silently duplicate work, batch operations are available, and changing format/quality never exports stale outputs.
- Presets expose practical choices without implying cross-codec quality equivalence. PNG losslessness and larger outputs are explained. JPEG XL lossless is clearly identified.
- Current image can be inspected before/after and opened at full resolution. Original images remain untouched. Export preserves existing files.
- Queue scheduling, late results, failed inputs, cancellation and repeated setting changes have behavior coverage.
- Concrete backend image correctness issues found during review are fixed and covered with regression fixtures.
- Required frontend/Go/race/build checks and the real packaged macOS smoke pass, with screenshots inspected. Report actual limitations instead of claiming literal perfection.

## Design direction

Preserve the restrained native workbench palette: paper `#ffffff`, canvas `#eef2f6`, ink `#172b3a`, teal `#146b70`, error `#a33f35`; dark variants use the existing theme. System sans typography keeps filename/data legible and follows platform conventions. No new font downloads.

Prefer a photo editor's contact list and inspection stage over a dashboard of large repeated cards. Filename and status align left; byte counts align consistently. The selected image is the primary visual element. Controls remain quiet, labeled and keyboard accessible. Persistent actions must fit the 920 × 600 minimum.

```text
[batch list 240] [      image preview       ] [output 230]
[file / state ] [  Original | Compressed   ] [preset    ]
[file / bytes ] [                          ] [format    ]
[add / clear  ] [  compare full resolution ] [quality   ]
[             batch status and save / upload            ]
```

At constrained desktop widths, the output inspector moves above the stage and the list remains compact. At smaller browser widths the sections stack. Review layout against the brief before implementation: retaining a card grid with changed colors would not satisfy the earlier feedback, so the preview stage and list are structural requirements. Keep existing S3 workflow intact.

## Resulting behavior

- The image list, selected-image stage and output inspector replace the repeated card grid. The inspector moves to the right at 1420px; smaller desktop windows keep it above the preview. Row selection supports Arrow Up/Down, Home and End. The full-resolution dialog retains Fit and 100% views.
- Presets apply to the current eligible batch and later imports: original format at quality 85, balanced WebP at 82, smaller AVIF at 55, and automatic lossless at 100 (JPEG XL for 8-bit stills, PNG for high-bit-depth pixels, WebP for WebP animation). These quality values are format-specific starting points, not a measured equivalence between codecs. Lossless resets resizing to original dimensions.
- Longest-edge choices are original, 3840, 2560, 1920, 1280 and 960 pixels. Shrinking preserves aspect ratio without cropping or upscaling. Catmull-Rom from `golang.org/x/image/draw` replaces four-sample thumbnail interpolation and filters transparent edges in premultiplied color space.
- Imports deduplicate exact source paths. Two inspection workers keep large imports moving. Clear, stop and retry actions retain task-version protection against late results. File-picker errors appear in the page and allow another attempt. Save/upload locks prevent queue mutations during an export.
- Concurrent tasks share the pending cache-run creation promise. Setting changes invalidate ready outputs before export; rejected run creation can retry.
- JPEG APP segments and WebP chunks are seek-skipped so large payloads before EXIF do not hide orientation. PNG EXIF can also be read after IDAT. Metadata allocation remains bounded. Failed/cancelled export copies remove their newly reserved partial file while preserving pre-existing files.
- Larger outputs are labeled with advice to lower quality or change format. PNG ignores quality. JPEG replaces transparency with white. Metadata and location data are removed.

## Validation scope and remaining limits

The automatic lossless preset chooses an encoder that retains the supported source's decoded precision and frames: 8-bit JPEG XL for ordinary stills, PNG for high-bit-depth pixels and lossless WebP for WebP animations. PNG orientation and Catmull-Rom resizing retain 16-bit samples. A direct request for high-bit-depth JPEG XL at quality 100 returns an actionable error instead of silently quantizing to 8-bit. The preset does not retain original JPEG bitstreams or source metadata.

Animated WebP retains all frames, timing, loop count, transparency and resized dimensions, with bounds of 120 frames and 40 million aggregate frame pixels. The bundled decoder omits loop count in its result; the adapter reads the WebP ANIM chunk directly. Batch presets keep WebP animations in WebP. Selecting a static format asks for explicit first-frame export confirmation; cancelling keeps the current output. The Animation selector can request first-frame extraction or restore full-frame WebP. Detected APNG/AVIF sequences expose first-frame extraction even when their frame count is unavailable. APNG extraction skips a separate default poster, decodes the first animation frame and places it at its original canvas offset. Backend defaults preserve frames and require an explicit `animationMode: firstFrame` for static extraction. JPEG XL/HEIF import remains scoped to stills. Previews and comparisons show a still frame.

On macOS, bounded ICC extraction and CoreGraphics normalize supported embedded RGB profiles to sRGB before removing the profile. Tests check a Display P3 sample against expected RGB values, alpha, image orientation and retention of 16-bit sample precision. HEIF/AVIF color properties recognize embedded ICC and Display P3 nclx. PNG cICP and HEIF/AVIF nclx PQ/HLG sources automatically tone-map to SDR/sRGB through the common decode path used by previews, full comparisons and compression. Mapping uses the ST 2084 EOTF for PQ, the ARIB STD-B67 inverse OETF plus a 1000-nit BT.2100 reference-display OOTF for HLG, D65 BT.2020/P3/BT.709 primaries and a luminance-based extended Reinhard shoulder (203-nit reference white, exposure two, transfer-defined peak of 10000/1000 nits). This is a fixed SDR rendering policy, not dynamic metadata processing or HDR delivery. It preserves alpha and 16-bit intermediate samples; lossless PNG retains the mapped samples. The UI identifies SDR rendering and leaves the HDR original untouched. Unsupported HDR primaries and unreadable profiles remain actionable errors. Gamut conversion can clip colors outside sRGB. HEVC HEIF/HEIC still import is supported; HEIC is not an output format.

Color and container references: [ITU-R BT.2100](https://www.itu.int/rec/R-REC-BT.2100) defines PQ/HLG image parameters; [PNG Third Edition](https://www.w3.org/TR/png-3/) defines cICP priority over iCCP and APNG frame/default-image ordering. The SDR rendering curve and exposure above are this app's policy, rather than a claim of a standards-mandated artistic rendering.

Production image operations run in the app's own executable via a private stdin/stdout worker protocol, bounded to two simultaneous workers. Task groups include the image version and cover overlapping inspection/preview/compression stages. Cancellation records prevent a late bridge request from restarting old work. Cancel, clear, removal and superseding settings terminate the old child process; incomplete compression staging directories are removed. Application shutdown cancels and reaps workers. Unit tests simulate a synchronous encoder that never returns; real-app smoke also cancels an actual AVIF operation within three seconds. A new version can immediately use the released slot. Failed/cancelled images retain the latest preset for their next retry, and a superseded source-preview read is retried if necessary.

The in-process codec adapter remains locked for AVIF/JPEG XL/HEIC and independent for WebP/JPEG/PNG, including in unit tests. Partial batch exports may leave files that completed successfully before a later failure. Cache cleanup remains best effort after seven days, without an immediate disk quota.

Real-app validation uses synthetic images, private application data and a loopback bucket. It covers native file-open events, rather than a physical Finder drop or an OS picker. Provider credentials, Intel/other OS builds and the minimum macOS release still require separate validation.

## Verification record

All checks passed on macOS arm64 on 2026-11-12. Checks and packaging were rerun for acceptance after implementation commit `6edeea9`, before the documentation commit:

- `pnpm test`: 13 files, 140 tests passed.
- `pnpm build:web`: TypeScript and production frontend build passed.
- `pnpm test:go`: passed.
- `node scripts/go.mjs test -race ./...`: passed, including mixed concurrent codec use and child-process cancellation.
- `node scripts/go.mjs test -race ./internal/imaging -run '^TestModernCodecsConcurrentFirstUse$' -count=1`: passed in a fresh process.
- `node scripts/go.mjs vet ./...`: passed.
- `test -z "$(gofmt -l main.go main_test.go smoke.go internal scripts/icon)"`: passed.
- `pnpm build`: passed; acceptance warm build reported 9.0 seconds, including frontend and DMG creation. This is a warm local measurement, not a cold-build benchmark.
- `pnpm smoke`: passed all 21 reported workflow steps. Final artifacts: [`build/smoke-RHKela`](../build/smoke-RHKela/report.json).
- `codesign --verify --deep --strict --verbose=2`: passed; signature remains ad hoc, without notarization.
- `git diff --check`: passed.

Regression coverage exercises aspect ratios and no upscaling, fine-detail downsampling and alpha edges, 16-bit orientation/resizing, Display P3-to-sRGB conversion, PQ/HLG transfer reference values and monotonic highlights, actual 16-bit cICP PNG and PQ-tagged AVIF decoding, matching HDR preview/comparison/export rendering, HDR alpha and original-file preservation, cICP priority over iCCP, unreadable-profile rejection, animation frame/timing/loop preservation, opted-in first-frame output, APNG poster exclusion/canvas offsets/palette ordering, confirmation cancellation and restoration of all frames, synchronous worker termination and cleanup, overlapping task stages and early cancellation, EXIF beyond large payloads, failed/cancelled export cleanup, duplicate imports, failed picker recovery, retrying with the latest preset, reloading a superseded original preview, automatic lossless target selection, shared pending cache creation, and withholding exports during a resize. Existing late-result, upload, comparison and output-path behavior tests remain in place.

The real packaged app encoded WebP/AVIF/JPEG XL/JPEG and displayed full-resolution comparisons; imported a mixed JPEG/transparent PNG/HEIC batch; skipped a duplicate; applied batch presets; compared 1200 × 800 against a resized 960 × 640 output; reset lossless output to full dimensions; selected PNG for a synthetic 16-bit image and WebP for a synthetic animation; confirmed and completed first-frame PNG export and restored all-frame WebP; imported actual PQ/HLG cICP PNG fixtures and compared tone-mapped PQ preview pixels against exported PNG pixels; cancelled an actual AVIF operation within three seconds; exported files; and uploaded/browsed/downloaded/copied/deleted against the loopback bucket. Minimum-window checks cover ordinary, animation and HDR selections, assert a preview height of at least 100 CSS pixels, and require the entire preview caption to remain inside the workbench and above the action bar.

Screenshots were visually inspected during refinement, including the final [minimum HDR window](../build/smoke-RHKela/minimum-hdr.png), [minimum animation window](../build/smoke-RHKela/minimum-animation.png), and [first-frame output](../build/smoke-RHKela/first-frame-output.png). HDR comparison, first-frame confirmation, 16-bit lossless selection, wide layout, transparent batch, resized comparison and both themes were also inspected across the packaged runs. The final report contains fresh versions of all screenshots. Earlier runs exposed an oversized footer, a hidden caption and an HDR preview smaller than the 100px acceptance floor. The final layout consolidates contextual notes, reserves a 320px minimum workbench and checks caption containment as well as action-bar overlap.

Final package file sizes (sum of regular-file lengths for the app, not allocated disk blocks):

| Artifact | Bytes | Decimal MB |
| --- | ---: | ---: |
| `Pic Piper.app` | 20,887,169 | 20.887 |
| Main executable | 20,737,744 | 20.738 |
| `pic-piper-0.3.0-arm64.dmg` | 7,718,912 | 7.719 |

MyGo displays the app as 19.9 MB using a binary-unit value; the table uses decimal MB explicitly. No Rust compiler or external codec program was installed or invoked. Implementation is split into build tooling, cloud services, image processing, desktop/workbench integration and documentation commits on `migration/mygo`.
