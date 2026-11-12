import { join } from "node:path";
import { prepareNativeCodec } from "./native-codec.mjs";

export const avifVersion = "1.4.2";
export const aomVersion = "3.14.1";

export function prepareNativeAVIF() {
  return prepareNativeCodec({
    name: "avif", revision: 1,
    archives: {
      avif: {
        url: `https://codeload.github.com/AOMediaCodec/libavif/tar.gz/refs/tags/v${avifVersion}`,
        sha256: "2b645287340ba5a631d268b551dc2d72bd73ac33335962dd36dcdb6d8366921d",
      },
      aom: {
        url: `https://storage.googleapis.com/aom-releases/libaom-${aomVersion}.tar.gz`,
        sha256: "44bf90dbd23e734d50e70a8c41c285193922938bd0d3bc2ee56764d181d55ef5",
      },
    },
    libraries: ["libavif.a", "libaom.a"],
    build: ({ cmake, install, target }) => {
      cmake("aom", [
        "-DCONFIG_PIC=1", "-DCONFIG_AV1_DECODER=0", "-DCONFIG_WEBM_IO=0",
        ...["DOCS", "EXAMPLES", "TESTDATA", "TESTS", "TOOLS"].map((name) => `-DENABLE_${name}=0`),
        ...(target.GOARCH === "amd64" ? ["-DENABLE_NASM=ON"] : []),
      ]);
      cmake("avif", [
        "-DAVIF_CODEC_AOM=SYSTEM", "-DAVIF_CODEC_AOM_DECODE=OFF",
        `-DAOM_INCLUDE_DIR=${join(install, "include")}`, `-DAOM_LIBRARY=${join(install, "lib", "libaom.a")}`,
        `-DCMAKE_PREFIX_PATH=${install}`, "-DAVIF_LIBYUV=OFF", "-DAVIF_ZLIBPNG=OFF", "-DAVIF_JPEG=OFF",
      ], { PKG_CONFIG_PATH: join(install, "lib", "pkgconfig") });
    },
  });
}
