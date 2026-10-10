import { createCipheriv, createDecipheriv } from "node:crypto";
import { decodeEncodingAesKey } from "./weixinCrypto";

const AES_BLOCK_SIZE = 32;

function pkcs7Pad(data: Buffer): Buffer {
  const pad = AES_BLOCK_SIZE - (data.length % AES_BLOCK_SIZE);
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(data: Buffer): Buffer {
  if (data.length === 0) {
    throw new Error("invalid pkcs7 padding");
  }
  const pad = data[data.length - 1] ?? 0;
  if (pad < 1 || pad > AES_BLOCK_SIZE || pad > data.length) {
    throw new Error("invalid pkcs7 padding");
  }
  for (let i = data.length - pad; i < data.length; i += 1) {
    if (data[i] !== pad) {
      throw new Error("invalid pkcs7 padding");
    }
  }
  return data.subarray(0, data.length - pad);
}

export function decodeAibotAesKey(aesKey: string): Buffer {
  const trimmed = aesKey.trim();
  if (!trimmed) {
    throw new Error("aibot aeskey is empty");
  }
  if (trimmed.length === 43 && !trimmed.includes("=")) {
    return decodeEncodingAesKey(trimmed);
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(`aibot aeskey must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

export function encryptAibotMedia(plain: Buffer, aesKey: string): Buffer {
  const key = decodeAibotAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const padded = pkcs7Pad(plain);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function decryptAibotMedia(encrypted: Buffer, aesKey: string): Buffer {
  if (encrypted.length === 0) {
    throw new Error("encrypted media is empty");
  }
  const key = decodeAibotAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return pkcs7Unpad(decrypted);
}

export function filenameFromContentDisposition(header: string | null | undefined): string {
  if (!header) {
    return "";
  }
  const utf8 = header.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (utf8?.[1]) {
    try {
      return sanitizeFileName(decodeURIComponent(utf8[1]));
    } catch {
      return sanitizeFileName(utf8[1]);
    }
  }
  const plain = header.match(/filename="?([^";\n]+)"?/i);
  if (plain?.[1]) {
    try {
      return sanitizeFileName(decodeURIComponent(plain[1].trim()));
    } catch {
      return sanitizeFileName(plain[1].trim());
    }
  }
  return "";
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned.slice(0, 80);
}
