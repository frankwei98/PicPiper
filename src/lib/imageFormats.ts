type ImageCapability = "compressImport" | "galleryUpload" | "write";

export const IMAGE_FORMAT_REGISTRY = [
  {
    id: "jpg",
    extensions: [
      { extension: "jpg", contentType: "image/jpeg" },
      { extension: "jpeg", contentType: "image/jpeg" },
    ],
    compressImport: true,
    galleryUpload: true,
    write: true,
  },
  {
    id: "png",
    extensions: [{ extension: "png", contentType: "image/png" }],
    compressImport: true,
    galleryUpload: true,
    write: true,
  },
  {
    id: "webp",
    extensions: [{ extension: "webp", contentType: "image/webp" }],
    compressImport: true,
    galleryUpload: true,
    write: true,
  },
  {
    id: "avif",
    extensions: [{ extension: "avif", contentType: "image/avif" }],
    compressImport: true,
    galleryUpload: true,
    write: true,
  },
  {
    id: "heif",
    extensions: [
      { extension: "heif", contentType: "image/heif" },
      { extension: "heic", contentType: "image/heic" },
    ],
    compressImport: false,
    galleryUpload: true,
    write: false,
  },
] as const;

type ImageFormatDefinition = (typeof IMAGE_FORMAT_REGISTRY)[number];

export type ImageFormat = ImageFormatDefinition["id"];
export type CompressibleImageFormat = Extract<ImageFormatDefinition, { compressImport: true }>["id"];
export type WritableImageFormat = Extract<ImageFormatDefinition, { write: true }>["id"];

export function extensionsFor(capability: ImageCapability): string[] {
  return IMAGE_FORMAT_REGISTRY.filter((format) => format[capability]).flatMap((format) =>
    format.extensions.map(({ extension }) => extension),
  );
}

export function writableImageFormats(): WritableImageFormat[] {
  return IMAGE_FORMAT_REGISTRY.filter((format): format is Extract<ImageFormatDefinition, { write: true }> => format.write)
    .map((format) => format.id);
}

export function contentTypeForExtension(extension: string): string {
  const normalizedExtension = extension.toLowerCase();
  for (const format of IMAGE_FORMAT_REGISTRY) {
    const match = format.extensions.find((candidate) => candidate.extension === normalizedExtension);
    if (match) return match.contentType;
  }
  return "application/octet-stream";
}
