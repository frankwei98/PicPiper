import { prepareNativeWebP } from "./native-webp.mjs";
import { prepareNativeAVIF } from "./native-avif.mjs";

export async function prepareNativeCodecs() {
  const webp = await prepareNativeWebP();
  const avif = await prepareNativeAVIF();
  if (!webp || !avif) return null;
  return {
    sources: { ...webp.sources, ...avif.sources },
    env: { ...webp.env,
      CGO_CFLAGS: [process.env.CGO_CFLAGS, webp.cflags, avif.cflags].filter(Boolean).join(" "),
      CGO_LDFLAGS: [process.env.CGO_LDFLAGS, webp.ldflags, avif.ldflags, "-lm -pthread"].filter(Boolean).join(" "),
    },
  };
}
