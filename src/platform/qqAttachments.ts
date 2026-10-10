import { extname } from "node:path";

export interface QqAttachmentLike {
  url?: string;
  filename?: string;
  content_type?: string;
}

export function isQqImageAttachment(attachment: QqAttachmentLike): boolean {
  const type = String(attachment.content_type ?? "").toLowerCase();
  if (type.startsWith("image/")) {
    return true;
  }
  return /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(attachment.filename ?? "");
}

export function isQqFileAttachment(attachment: QqAttachmentLike): boolean {
  if (isQqImageAttachment(attachment)) {
    return false;
  }
  const type = String(attachment.content_type ?? "").toLowerCase();
  if (!type && !attachment.filename) {
    return false;
  }
  if (type === "voice" || type.startsWith("audio/")) {
    return false;
  }
  if (type === "file" || type.startsWith("application/") || type.startsWith("text/") || type.startsWith("video/")) {
    return true;
  }
  return Boolean(extname(attachment.filename ?? ""));
}

export function qqAttachmentFileName(attachment: QqAttachmentLike, kind: "photo" | "document"): string {
  const raw = String(attachment.filename ?? "").replace(/[\\/:*?"<>|]/g, "_").trim();
  if (raw && extname(raw)) {
    return raw.slice(0, 80);
  }
  const type = String(attachment.content_type ?? "").toLowerCase();
  if (kind === "document") {
    if (type.includes("pdf")) return "qq-file.pdf";
    if (type.includes("zip")) return "qq-file.zip";
    if (type.includes("json")) return "qq-file.json";
    if (type.includes("markdown")) return "qq-file.md";
    if (type.startsWith("text/")) return "qq-file.txt";
    if (type.startsWith("video/")) return "qq-file.mp4";
    return "qq-file.bin";
  }
  if (type.includes("png")) return "qq-image.png";
  if (type.includes("webp")) return "qq-image.webp";
  if (type.includes("gif")) return "qq-image.gif";
  return "qq-image.jpg";
}
