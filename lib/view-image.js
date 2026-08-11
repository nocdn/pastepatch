import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { assertReadableFileTarget, resolveToolPath } from "./fs-ops.js";

/** Longest side after resize (vision-friendly, keeps payload reasonable). */
export const DEFAULT_MAX_DIMENSION = 2048;
/** Refuse to load files larger than this from disk. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** Soft cap on delivered image bytes (after resize/re-encode). */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const FORMAT_MIME = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

const PASSTHROUGH_FORMATS = new Set(["jpeg", "jpg", "png", "webp", "gif"]);

/**
 * Load an image under the project sandbox and return MCP content blocks:
 * text metadata + a real `type: "image"` payload (base64 + mimeType).
 *
 * Large images are downscaled (and may be re-encoded) so the tool result stays
 * within a size suitable for remote MCP / vision models.
 */
export async function viewImageFile({
  path: filePath,
  root,
  maxDimension = DEFAULT_MAX_DIMENSION,
  allowOutside = false,
} = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("path is required.");
  }

  const pathOptions = { allowOutside: allowOutside === true };
  await assertReadableFileTarget(filePath, root, pathOptions);
  const absolute = resolveToolPath(filePath, root, pathOptions);

  const maxDim = clampInt(maxDimension, 64, 4096, DEFAULT_MAX_DIMENSION);

  const raw = await readFile(absolute);
  if (raw.length > MAX_INPUT_BYTES) {
    throw new Error(
      `Image too large to load (${formatBytes(raw.length)}; max ${formatBytes(MAX_INPUT_BYTES)}). ` +
        `Export a smaller file or raise limits in a future release.`,
    );
  }

  let metadata;
  try {
    metadata = await sharp(raw, { animated: false, limitInputPixels: 64_000_000 }).metadata();
  } catch (error) {
    throw new Error(
      `Not a supported image (or file is corrupt): ${error.message || error}. ` +
        `Supported: jpeg, png, webp, gif, avif, tiff, svg.`,
    );
  }

  const originalFormat = normalizeFormat(metadata.format);
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  const originalBytes = raw.length;
  const hasAlpha = Boolean(metadata.hasAlpha);

  const needsResize =
    (originalWidth > 0 && originalWidth > maxDim) ||
    (originalHeight > 0 && originalHeight > maxDim);

  // Pass through small, already-vision-friendly images unchanged when possible.
  if (
    !needsResize &&
    originalBytes <= MAX_OUTPUT_BYTES &&
    PASSTHROUGH_FORMATS.has(originalFormat) &&
    originalFormat !== "svg"
  ) {
    const mimeType = FORMAT_MIME[originalFormat] || "application/octet-stream";
    return buildResult({
      path: filePath,
      mimeType,
      buffer: raw,
      format: originalFormat === "jpg" ? "jpeg" : originalFormat,
      width: originalWidth,
      height: originalHeight,
      originalFormat,
      originalWidth,
      originalHeight,
      originalBytes,
      resized: false,
      reencoded: false,
    });
  }

  let pipeline = sharp(raw, { animated: false, limitInputPixels: 64_000_000 }).rotate();

  if (needsResize) {
    pipeline = pipeline.resize({
      width: maxDim,
      height: maxDim,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  // Prefer JPEG for opaque photos/screenshots; keep PNG when transparency matters.
  const outputFormat = hasAlpha ? "png" : "jpeg";
  let quality = 85;
  let buffer;
  let outMeta;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let attemptPipeline = pipeline.clone();
    if (outputFormat === "jpeg") {
      attemptPipeline = attemptPipeline.jpeg({ quality, mozjpeg: true });
    } else {
      attemptPipeline = attemptPipeline.png({ compressionLevel: 9, effort: 6 });
    }
    buffer = await attemptPipeline.toBuffer({ resolveWithObject: false });
    outMeta = await sharp(buffer).metadata();
    if (buffer.length <= MAX_OUTPUT_BYTES) {
      break;
    }
    // Still too big: lower quality (jpeg) or shrink further.
    if (outputFormat === "jpeg" && quality > 55) {
      quality -= 15;
      continue;
    }
    const currentMax = Math.max(outMeta.width || maxDim, outMeta.height || maxDim);
    const nextMax = Math.max(256, Math.floor(currentMax * 0.75));
    pipeline = sharp(raw, { animated: false, limitInputPixels: 64_000_000 })
      .rotate()
      .resize({
        width: nextMax,
        height: nextMax,
        fit: "inside",
        withoutEnlargement: true,
      });
  }

  if (buffer.length > MAX_OUTPUT_BYTES) {
    throw new Error(
      `Could not compress image under ${formatBytes(MAX_OUTPUT_BYTES)} ` +
        `(got ${formatBytes(buffer.length)}). Try a smaller source image.`,
    );
  }

  const mimeType = FORMAT_MIME[outputFormat];
  const resized =
    needsResize ||
    (outMeta.width || 0) !== originalWidth ||
    (outMeta.height || 0) !== originalHeight;

  return buildResult({
    path: filePath,
    mimeType,
    buffer,
    format: outputFormat,
    width: outMeta.width || 0,
    height: outMeta.height || 0,
    originalFormat,
    originalWidth,
    originalHeight,
    originalBytes,
    resized,
    reencoded: true,
  });
}

function buildResult({
  path: filePath,
  mimeType,
  buffer,
  format,
  width,
  height,
  originalFormat,
  originalWidth,
  originalHeight,
  originalBytes,
  resized,
  reencoded,
}) {
  const bytes = buffer.length;
  const meta = {
    path: filePath,
    format,
    mimeType,
    width,
    height,
    bytes,
    original_format: originalFormat || format,
    original_width: originalWidth || width,
    original_height: originalHeight || height,
    original_bytes: originalBytes,
    resized,
    reencoded,
  };

  const text = [
    `Image: ${filePath}`,
    `format: ${meta.original_format}${reencoded && meta.original_format !== format ? ` → ${format}` : ""}`,
    `dimensions: ${meta.original_width}×${meta.original_height}` +
      (resized ? ` → ${width}×${height}` : ""),
    `size: ${formatBytes(originalBytes)}${reencoded || bytes !== originalBytes ? ` → ${formatBytes(bytes)}` : ""}`,
    `resized: ${resized ? "yes" : "no"}`,
    `reencoded: ${reencoded ? "yes" : "no"}`,
    `mimeType: ${mimeType}`,
  ].join("\n");

  return {
    meta,
    content: [
      { type: "text", text },
      {
        type: "image",
        data: buffer.toString("base64"),
        mimeType,
        annotations: {
          audience: ["assistant", "user"],
          priority: 0.9,
        },
      },
    ],
  };
}

function normalizeFormat(format) {
  const value = String(format || "").toLowerCase();
  if (value === "jpg") {
    return "jpeg";
  }
  return value;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function formatBytes(n) {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
