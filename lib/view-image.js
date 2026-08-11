import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { assertReadableFileTarget, resolveToolPath } from "./fs-ops.js";

/** Refuse to load files larger than this from disk. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;

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

/**
 * Load an image under the project sandbox and return MCP content blocks:
 * text metadata + a real `type: "image"` payload (base64 + mimeType).
 *
 * Always returns the original full-resolution file bytes (no resize / re-encode).
 */
export async function viewImageFile({
  path: filePath,
  root,
  allowOutside = false,
} = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("path is required.");
  }

  const pathOptions = { allowOutside: allowOutside === true };
  await assertReadableFileTarget(filePath, root, pathOptions);
  const absolute = resolveToolPath(filePath, root, pathOptions);

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

  const format = normalizeFormat(metadata.format);
  if (!format || !FORMAT_MIME[format]) {
    throw new Error(
      `Unsupported image format${metadata.format ? ` "${metadata.format}"` : ""}. ` +
        `Supported: jpeg, png, webp, gif, avif, tiff, svg.`,
    );
  }

  const mimeType = FORMAT_MIME[format];
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const bytes = raw.length;

  const meta = {
    path: filePath,
    format: format === "jpg" ? "jpeg" : format,
    mimeType,
    width,
    height,
    bytes,
  };

  const text = [
    `Image: ${filePath}`,
    `format: ${meta.format}`,
    `dimensions: ${width}×${height}`,
    `size: ${formatBytes(bytes)}`,
    `mimeType: ${mimeType}`,
    `full_resolution: yes`,
  ].join("\n");

  return {
    meta,
    content: [
      { type: "text", text },
      {
        type: "image",
        data: raw.toString("base64"),
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

export function formatBytes(n) {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
