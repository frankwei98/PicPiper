# Portable RGB ICC conversion

The checked-in `lcms.wasm` builds the unmodified [LittleCMS 2.20 engine](https://github.com/mm2/Little-CMS/releases/tag/lcms2.20) with the small adapter in `src/bridge.c`. LittleCMS is MIT licensed; its license is in `LICENSE` and included in application codec notices.

Go uses wazero, which the image codecs already depend on. One compiled module is shared, but each transform has independent memory and C state. Modules have a 64 MiB memory limit, no filesystem/network access, and transform at most 4096 pixels per call. RGB alpha and big-endian 16-bit samples are preserved. Relative colorimetric conversion supports the engine's RGB matrix/TRC and LUT profiles; malformed and non-RGB profiles return an error.

Regular builds use the checked-in binary and do not download a compiler. To regenerate the module and synthetic test profiles, install [WASI SDK 34](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34), then run:

```sh
WASI_SDK_PATH=/path/to/wasi-sdk-34 node scripts/build-color.mjs
```

The script downloads the official LittleCMS source archive and verifies SHA-256 `18ff5504fa9cc8a2b1f3591180d90ead16c8a2ea78e530523b46eab70e1ca6b9` before compiling. The SDK 34 arm64-macos archive used for the checked-in build has SHA-256 `9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9`.
