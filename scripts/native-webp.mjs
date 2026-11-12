import { prepareNativeCodec } from "./native-codec.mjs";

export const webpVersion = "1.6.0";

export function prepareNativeWebP() {
  return prepareNativeCodec({
    name: "webp", revision: 1,
    archives: { webp: {
      url: `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${webpVersion}.tar.gz`,
      sha256: "e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564",
    } },
    libraries: ["libwebp.a", "libsharpyuv.a"],
    build: ({ cmake }) => cmake("webp", [
      "-DWEBP_LINK_STATIC=ON",
      ...["ANIM_UTILS", "CWEBP", "DWEBP", "GIF2WEBP", "IMG2WEBP", "VWEBP", "WEBPINFO", "LIBWEBPMUX", "WEBPMUX", "EXTRAS"].map((name) => `-DWEBP_BUILD_${name}=OFF`),
    ]),
  });
}
