# Changelog

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
