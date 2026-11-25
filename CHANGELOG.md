# Changelog

## [1.3.2](https://github.com/frankwei98/PicPiper/compare/v1.3.1...v1.3.2) (2026-11-25)


### Bug Fixes

* **cloud:** block uploads of private file aliases ([8d0b5bc](https://github.com/frankwei98/PicPiper/commit/8d0b5bccb41db168829da391e8a8691b6e65dab2))
* **cloud:** keep custom upload names usable in the gallery ([8d66e74](https://github.com/frankwei98/PicPiper/commit/8d66e74bc46df95cf548990ca2c0c4db9096ba6f))
* **gallery:** avoid rebuilding the cache index on shared hits ([74aadeb](https://github.com/frankwei98/PicPiper/commit/74aadebd822e923ec7d3f505930814cc1a08586b))
* **gallery:** count legacy writes in thumbnail eviction ([64e2998](https://github.com/frankwei98/PicPiper/commit/64e2998e33f874c03fe4632c66e15ced638c63ca))
* **gallery:** enforce thumbnail budget across instances ([6f9dcb2](https://github.com/frankwei98/PicPiper/commit/6f9dcb2861e4a6fcb9661e9d50896da8b5c29fd4))
* **gallery:** verify selected uploads and isolate pending bucket actions ([8f74bb6](https://github.com/frankwei98/PicPiper/commit/8f74bb6170f5bc01e9f3d71680842d2b60fc4e4d))
* harden BMFF preflight, decode bounds, S3 paths, and worker stdout ([f8320bc](https://github.com/frankwei98/PicPiper/commit/f8320bc72f93747cacb6118413e5e02973f5e19c))
* **imaging:** account for 16-bit color conversion memory ([0154729](https://github.com/frankwei98/PicPiper/commit/0154729e8fae73929ee75ec5cbad18d1f243baa3))
* **imaging:** admit small modern images without large slots ([524f8a2](https://github.com/frankwei98/PicPiper/commit/524f8a28ea578e4ac571297b9dc105b677cfe190))
* **imaging:** bound resize allocations and filter fine detail ([19e7b93](https://github.com/frankwei98/PicPiper/commit/19e7b93478127a6505a3a968cdf51218e0c68125))
* **imaging:** budget encoded WebP buffers ([8304c34](https://github.com/frankwei98/PicPiper/commit/8304c34285818ef8de2ea622f9c75ef278078666))
* **imaging:** budget HDR and animated PNG buffers ([88146da](https://github.com/frankwei98/PicPiper/commit/88146dad35bca8392fbedde81f6f1281a64485ef))
* **imaging:** consume worker response delimiters before PNG frames ([3b9dbf3](https://github.com/frankwei98/PicPiper/commit/3b9dbf379576edd9d632cb86d01a8ad55bde2864))
* **imaging:** handle oversized Windows output names ([d3a98d1](https://github.com/frankwei98/PicPiper/commit/d3a98d1c115ee5999fdc01c0f2c2fd1c9bc2dfb8))
* **imaging:** limit all-frame WebP compression ([2721355](https://github.com/frankwei98/PicPiper/commit/2721355d68571b5e9b6c4553667450610302159a))
* **imaging:** preserve long output names across compression and export ([105c47d](https://github.com/frankwei98/PicPiper/commit/105c47d9f2f61643d25ad483990206e80d3d8f56))
* **imaging:** preserve resize filtering with bounded scratch space ([4b281a1](https://github.com/frankwei98/PicPiper/commit/4b281a1bb355423921ecf58122efc483dfcaf1c8))
* **imaging:** reclaim abandoned comparison previews ([3b96e4d](https://github.com/frankwei98/PicPiper/commit/3b96e4d02bf95c82e8c2281e3679247b4dc57a62))
* **imaging:** require ownership for comparison previews ([4edd778](https://github.com/frankwei98/PicPiper/commit/4edd77841bc3c50e79e38789c85902e6e5c70066))
* **imaging:** stream clipboard PNGs without temporary files ([95d42ff](https://github.com/frankwei98/PicPiper/commit/95d42ff07acecc865569af1ee5dd9b2d720a36d2))
* **mini:** preload thumbnails inside the results scroller ([5854fbe](https://github.com/frankwei98/PicPiper/commit/5854fbe89e3f9eff6016880c8944c3f41af503e0))
* **optimize:** compare both zoom modes from stable snapshots ([31a4d14](https://github.com/frankwei98/PicPiper/commit/31a4d14993493958c84af2a1927f6980e187aa0f))
* **optimize:** end loading state for failed result thumbnails ([03278fd](https://github.com/frankwei98/PicPiper/commit/03278fd5ed3028cb44315b33e9bd869621937da2))
* **optimize:** label the dimensions of the displayed preview ([73ca9f9](https://github.com/frankwei98/PicPiper/commit/73ca9f9442187ce5d28e6042dc9720e8858db7f9))
* **optimize:** retain originals on disk for the batch ([99024c8](https://github.com/frankwei98/PicPiper/commit/99024c85ca3b7495b73e76973aa09e3f87bb0412))
* **optimize:** retain the selected original across tabs ([efd48f1](https://github.com/frankwei98/PicPiper/commit/efd48f1642db80371608f76ea38639b2d78e04fc))
* **optimize:** retain the selected original preview ([01e2fa5](https://github.com/frankwei98/PicPiper/commit/01e2fa59b378e0bb9c0479ca315dbef5e9882ad4))
* **optimize:** retry failed original previews ([7e9d5ab](https://github.com/frankwei98/PicPiper/commit/7e9d5abd6e51af6e06644900dc66c15f22d2de4e))
* **optimize:** reuse both comparison preview sizes ([f9970f0](https://github.com/frankwei98/PicPiper/commit/f9970f05ae596dd24b8ea7a5234c0c9f2e749b84))
* **optimize:** share the selected output preview ([145c27b](https://github.com/frankwei98/PicPiper/commit/145c27b2f8680d792ae1cb7ce11cd41ac3a506c4))
* **optimize:** skip abandoned full-resolution comparisons ([895af4e](https://github.com/frankwei98/PicPiper/commit/895af4e259bcb29c0300c2c2764f119f805f5a12))
* **release:** check every page for unresolved releases ([7b256a8](https://github.com/frankwei98/PicPiper/commit/7b256a8fc8e1d4f3963522e6e793542bfe37a3ad))
* **settings:** keep update checks and preferences in sync ([f3f6b4b](https://github.com/frankwei98/PicPiper/commit/f3f6b4bafa3b9e601a5ad737948669232c98f59e))
* **settings:** validate naming edits and guard credential rollback ([2caa98b](https://github.com/frankwei98/PicPiper/commit/2caa98b9208da5e746bab9fdc3a6dc8862e8b3b4))


### Performance Improvements

* **gallery:** index thumbnail cache size and recency ([9504339](https://github.com/frankwei98/PicPiper/commit/95043390cd40c0f9b4972cf3d09440fad851e957))
* **gallery:** update the thumbnail index incrementally ([13db0e6](https://github.com/frankwei98/PicPiper/commit/13db0e6689244888ecb18ef6a68a98dbe6c8364b))
* **imaging:** avoid redundant canvases for high-depth images ([3f3aa36](https://github.com/frankwei98/PicPiper/commit/3f3aa361333b3ebabdf00add6ecac0da4f779824))
* **imaging:** bound large resize memory ([322d644](https://github.com/frankwei98/PicPiper/commit/322d6441bce05c12ef50015f55a0490673c16f40))
* **imaging:** limit concurrent large image operations ([611e0e7](https://github.com/frankwei98/PicPiper/commit/611e0e7543dd650ea363795356e6f3883c81d849))
* **imaging:** stream comparison and clipboard PNG files ([a9315e1](https://github.com/frankwei98/PicPiper/commit/a9315e18c56c8d949afb4ebf5bb10d4a619c70e9))
* **mini:** reuse thumbnails across panel sessions ([0cf476e](https://github.com/frankwei98/PicPiper/commit/0cf476ebad80ad83d5163551db2f03db1b36cd55))
* **mini:** skip unchanged snapshots and lazy-load thumbnails ([07bd7b2](https://github.com/frankwei98/PicPiper/commit/07bd7b2d3ae74756fdf2456a24e5a0d3508cb200))
* **optimize:** load previews on demand ([3486035](https://github.com/frankwei98/PicPiper/commit/3486035e63d1c793a35aea2834546226c179d76e))

## [1.3.1](https://github.com/frankwei98/PicPiper/compare/v1.3.0...v1.3.1) (2026-11-18)


### Bug Fixes

* **ci:** revalidate edited pull request titles ([b584476](https://github.com/frankwei98/PicPiper/commit/b584476ce18b1c23a60f890893b41e4b593c3707))
* **cloud:** fit download collision names within filesystem limits ([119119d](https://github.com/frankwei98/PicPiper/commit/119119dc4b5bbcc37210576ecb15c1e79e43e552))
* **cloud:** preserve concurrent uploads after gallery deletion ([25d9b05](https://github.com/frankwei98/PicPiper/commit/25d9b05c6b3d701734fec73ebab78e10f848781b))
* **cloud:** reject invalid default upload prefixes ([4c89336](https://github.com/frankwei98/PicPiper/commit/4c8933696210b7e7bfc08309c675529b121086d7))
* **desktop:** reveal the main window when opening images ([f287c6b](https://github.com/frankwei98/PicPiper/commit/f287c6ba3ccbbb667374f0fa6798d2409c17cf51))
* **gallery:** preserve uploads during initial listing ([6242472](https://github.com/frankwei98/PicPiper/commit/6242472c1709add597a4cca042c73a7b34fff037))
* **gallery:** preserve uploads during pagination ([1e0f0cf](https://github.com/frankwei98/PicPiper/commit/1e0f0cf5cddfed4f878626d95fbb43a29189b933))
* **gallery:** refresh unchanged scopes after uploads ([8bafbd3](https://github.com/frankwei98/PicPiper/commit/8bafbd3dbce9cd51672122ed0003481d8e95c26d))
* **imaging:** contain malformed codec metadata panics ([75de786](https://github.com/frankwei98/PicPiper/commit/75de78691a2f89a4c85cd2fd766872f8fb075c06))
* **imaging:** detect JPEG XL animation before still export ([1fce80b](https://github.com/frankwei98/PicPiper/commit/1fce80bbc4b125fa14598e38b9fc88f61c5f709d))
* **imaging:** reject repeated APNG headers ([0c9fe30](https://github.com/frankwei98/PicPiper/commit/0c9fe30239d5e70af076a1d3495b7856d4689e43))
* **imaging:** retain queued outputs for the session ([a208884](https://github.com/frankwei98/PicPiper/commit/a208884c785ccfc266967073754556f0f39ee205))
* **mini:** ignore stale queue polling errors ([8b92d7e](https://github.com/frankwei98/PicPiper/commit/8b92d7eb9fc8afa6330c62800f5bcef6ca298341))
* **mini:** validate confirmed upload bucket identity ([229fd67](https://github.com/frankwei98/PicPiper/commit/229fd67f13cc41391751e2a2ece7049d79493571))
* **optimize:** ignore clamped comparison scroll echoes ([106781b](https://github.com/frankwei98/PicPiper/commit/106781b72e04c3d1a7e56d70c642c99967b40f35))
* **optimize:** preserve empty profile upload prefixes ([8e6bcdf](https://github.com/frankwei98/PicPiper/commit/8e6bcdfe211c6d1df38991df669cd786817f1b99))
* **optimize:** queue native opens during output operations ([48ec9f8](https://github.com/frankwei98/PicPiper/commit/48ec9f8f8cc35cc7b1192223e3489382f4362b47))
* **settings:** preserve storage drafts when saving general preferences ([1bbef75](https://github.com/frankwei98/PicPiper/commit/1bbef75e63b29a11f0147e598aa77ad798b2fd99))

## [1.3.0](https://github.com/frankwei98/PicPiper/compare/v1.2.1...v1.3.0) (2026-11-17)


### Features

* **imaging:** convert RGB ICC profiles on portable builds ([035bd2f](https://github.com/frankwei98/PicPiper/commit/035bd2fb69a093de52ccdec1388eeaf2502e2bbe))
* **settings:** delete profiles and their local credentials ([ed932c0](https://github.com/frankwei98/PicPiper/commit/ed932c01a633d949d53df3eeefd4e2425351e16a))


### Bug Fixes

* **build:** isolate lock helper from application Go flags ([af4aa0c](https://github.com/frankwei98/PicPiper/commit/af4aa0cc9d340dfccc3c72f2c00dd5a4ead88f0a))
* **build:** serialize native codec preparation with kernel locks ([6882ef9](https://github.com/frankwei98/PicPiper/commit/6882ef914a222fabf9fbfa13399181d1935f2ea3))
* **build:** terminate the actual lock helper on timeout ([ccbaef0](https://github.com/frankwei98/PicPiper/commit/ccbaef0ff88c7a9acb6c4ee61f5712e9438ec74c))
* **download:** publish only complete image files ([d5bb4e7](https://github.com/frankwei98/PicPiper/commit/d5bb4e7e08d63f6567e99431ce1cf978d9daed80))
* **download:** publish staged files only with atomic operations ([84273e6](https://github.com/frankwei98/PicPiper/commit/84273e6064c657fd7d8e9ef2dadc23536682a17b))
* **export:** fall back on unsupported macOS volumes ([e2c0c95](https://github.com/frankwei98/PicPiper/commit/e2c0c957f8b7303693851b7ee17fb9b71dd26a12))
* **export:** preserve replacement files after fallback failures ([2c042e7](https://github.com/frankwei98/PicPiper/commit/2c042e786d2ceb4995ae14c9556dfdc7b6a9d5e6))
* **export:** publish without hard links on unsupported filesystems ([d6fdceb](https://github.com/frankwei98/PicPiper/commit/d6fdceb64bd3178b2f395eb2a1ff7f76a00a7838))
* **export:** retain errors unrelated to link support ([25106f3](https://github.com/frankwei98/PicPiper/commit/25106f32c4bb60706403949218186545be84f738))
* **gallery:** isolate invalid upload history records ([cb6f23a](https://github.com/frankwei98/PicPiper/commit/cb6f23a0ca678277fbfed6b05ab1cddbeb0c2b7a))
* **gallery:** keep uploads outside the visible scope hidden ([0440dde](https://github.com/frankwei98/PicPiper/commit/0440dde593d0ecc32bd35304c0cccc019e47ddee))
* **gallery:** show verified results when some checks fail ([0443e18](https://github.com/frankwei98/PicPiper/commit/0443e18565f6fb0dfce327fca733d2656cc775f2))
* **gallery:** upload using the profile prefix ([2476658](https://github.com/frankwei98/PicPiper/commit/2476658122316a4266fee92e1e3f2573d3df6e59))
* **imaging:** report AVIF container rotation consistently ([aa0fe5b](https://github.com/frankwei98/PicPiper/commit/aa0fe5b0a72f20693d5a58e2995c53fdd802139c))
* **mini:** guide animation failures to the main window ([7756e71](https://github.com/frankwei98/PicPiper/commit/7756e71ecadd2c0372a0aa403458c54a48ebf06f))
* **mini:** merge compression edits into current settings ([214973a](https://github.com/frankwei98/PicPiper/commit/214973a2889325878cbdfedfad50c193cfc49ade))
* **naming:** normalize reserved Windows stem components ([ae3ecc0](https://github.com/frankwei98/PicPiper/commit/ae3ecc029c465b8e9afb2d6bcbfd78b3accdf896))
* **naming:** sanitize generated image filenames ([8982350](https://github.com/frankwei98/PicPiper/commit/8982350518163206b7cc5b128d9acb178e11b17a))
* **oauth:** drain callback responses before closing the server ([5916097](https://github.com/frankwei98/PicPiper/commit/591609780f980093ad71650aae6f7d30eebe01af))
* **release:** refresh verified draft before publication ([f6c2e68](https://github.com/frankwei98/PicPiper/commit/f6c2e6832de1bf6a59badf1d245c885f04737147))
* **release:** reject unexpected draft assets before publishing ([eb7ad17](https://github.com/frankwei98/PicPiper/commit/eb7ad170cfd24804b8c4a45629e8156e36b20d20))
* **s3:** preserve cancellation and redact provider errors ([31432bc](https://github.com/frankwei98/PicPiper/commit/31432bcb723df3c33e2d4aaa6f0123c5a27eb06a))
* **scripts:** reclaim stale native codec locks without a pid ([01bee60](https://github.com/frankwei98/PicPiper/commit/01bee60ade3a03d62d9a2d8899cb8e07d3453cc3))
* **settings:** merge scoped saves with current Mini preferences ([47b9455](https://github.com/frankwei98/PicPiper/commit/47b9455e49ee9b90f611aa033ef38d62a85ef976))
* **settings:** preserve credentials shared by case-equivalent IDs ([77b31b7](https://github.com/frankwei98/PicPiper/commit/77b31b7ee2ebf8ee64777d0ec058ffc81424e5f6))
* **settings:** reject duplicate storage profile IDs ([323eee7](https://github.com/frankwei98/PicPiper/commit/323eee78a8e896a863d6bd7fe5a15b674b73a82b))
* **settings:** retain saved profile state when refresh fails ([b5aa8f2](https://github.com/frankwei98/PicPiper/commit/b5aa8f2a988b43190b71fee8b94f75a76f349086))
* **smoke:** restore the developer clipboard after copy checks ([4cac811](https://github.com/frankwei98/PicPiper/commit/4cac811d62afabae5ac02509b30d30d86f4e2b2c))
* **thumbnails:** let cache hits and deletion bypass rendering ([7ede657](https://github.com/frankwei98/PicPiper/commit/7ede657f5db7352aea3d24806c68453c0ab362f3))
* **updates:** expire abandoned activity leases with heartbeats ([abf1c39](https://github.com/frankwei98/PicPiper/commit/abf1c397738377a13a0756746d9d752da398ca1a))

## [1.2.1](https://github.com/frankwei98/PicPiper/compare/v1.2.0...v1.2.1) (2026-11-16)


### Features

* add Windows and Linux installers for amd64 and arm64 ([e752d07](https://github.com/frankwei98/PicPiper/commit/e752d07db4f0fc6e97a0de044f9d25bbe9fc7969))

## [1.2.0](https://github.com/frankwei98/PicPiper/compare/v1.1.0...v1.2.0) (2026-11-15)


### Features

* add compression result actions and configurable image concurrency ([#11](https://github.com/frankwei98/PicPiper/issues/11)) ([da8d659](https://github.com/frankwei98/PicPiper/commit/da8d659d9b77692b7273543b0fb44c34c3b68657))

## [1.1.0](https://github.com/frankwei98/PicPiper/compare/v1.0.0...v1.1.0) (2026-11-14)


### Features

* add signed in-app updates and automated releases ([4181042](https://github.com/frankwei98/PicPiper/commit/4181042e74a9e411a8b6645f3947ed87a8660161))


### Bug Fixes

* **release:** resolve repository and retry existing tags ([52eb3f5](https://github.com/frankwei98/PicPiper/commit/52eb3f56a9e0de128c1b5e611e201c167ea96444))

## 1.0.0

Initial Go/MyGo release with batch image compression, S3-compatible storage,
Cloudflare R2 onboarding, multilingual settings and the Mini status bar workflow.

This release requires manual installation. In-app updates begin with the next
release that includes the updater.
