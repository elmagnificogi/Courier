import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const AES_BLOCK_SIZE = 32;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function parseQueryPreservingPlus(search: string): URLSearchParams {
  const params = new URLSearchParams();
  const q = search.startsWith("?") ? search.slice(1) : search;
  if (!q) {
    return params;
  }
  for (const part of q.split("&")) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    const rawName = eq >= 0 ? part.slice(0, eq) : part;
    const rawValue = eq >= 0 ? part.slice(eq + 1) : "";
    const name = decodeURIComponent(rawName.replace(/\+/g, "%2B"));
    const value = decodeURIComponent(rawValue.replace(/\+/g, "%2B"));
    params.append(name, value);
  }
  return params;
}

export function sha1Signature(parts: string[]): string {
  const sorted = [...parts].sort().join("");
  return createHash("sha1").update(sorted).digest("hex");
}

export function decodeEncodingAesKey(encodingAesKey: string): Buffer {
  const value = encodingAesKey.trim();
  if (value.length !== 43) {
    throw new Error("EncodingAESKey must be 43 characters");
  }
  const decoded = Buffer.from(`${value}=`, "base64");
  if (decoded.length !== 32) {
    throw new Error("EncodingAESKey must decode to 32 bytes");
  }
  return decoded;
}

function pkcs7Pad(data: Buffer): Buffer {
  const pad = AES_BLOCK_SIZE - (data.length % AES_BLOCK_SIZE);
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(data: Buffer): Buffer {
  if (data.length === 0) {
    throw new Error("invalid pkcs7 padding");
  }
  const pad = data[data.length - 1] ?? 0;
  if (pad === 0 || pad > AES_BLOCK_SIZE || pad > data.length) {
    throw new Error("invalid pkcs7 padding");
  }
  for (let i = data.length - pad; i < data.length; i += 1) {
    if (data[i] !== pad) {
      throw new Error("invalid pkcs7 padding");
    }
  }
  return data.subarray(0, data.length - pad);
}

export function encryptWeixinMessage(plainText: string, encodingAesKey: string, receiveId: string): string {
  const aesKey = decodeEncodingAesKey(encodingAesKey);
  const iv = aesKey.subarray(0, 16);
  const random = randomBytes(16);
  const msg = Buffer.from(plainText, "utf8");
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(msg.length, 0);
  const payload = pkcs7Pad(Buffer.concat([random, msgLen, msg, Buffer.from(receiveId, "utf8")]));
  const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(payload), cipher.final()]).toString("base64");
}

export function decryptWeixinMessage(cipherText: string, encodingAesKey: string, receiveId?: string): string {
  const aesKey = decodeEncodingAesKey(encodingAesKey);
  const iv = aesKey.subarray(0, 16);
  const encrypted = Buffer.from(cipherText, "base64");
  const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const payload = pkcs7Unpad(padded);
  if (payload.length < 20) {
    throw new Error("decrypted payload too short");
  }
  const msgLen = payload.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  if (msgEnd > payload.length) {
    throw new Error("decrypted message length mismatch");
  }
  const message = payload.subarray(msgStart, msgEnd).toString("utf8");
  if (receiveId) {
    const actualReceiveId = payload.subarray(msgEnd).toString("utf8");
    if (actualReceiveId !== receiveId) {
      throw new Error("decrypted receiveId mismatch");
    }
  }
  return message;
}

export function xmlTag(xml: string, tag: string): string {
  const cdata = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i"));
  if (cdata?.[1] !== undefined) {
    return cdata[1];
  }
  const plain = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return (plain?.[1] ?? "").trim();
}

export function splitMessage(text: string, maxLen = 1800): string[] {
  const value = text.trim();
  if (!value) {
    return [""];
  }
  if (value.length <= maxLen) {
    return [value];
  }
  const parts: string[] = [];
  let remaining = value;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) {
      cut = maxLen;
    }
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

export class MessageDeduper {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  seenBefore(id: string): boolean {
    if (!id) {
      return false;
    }
    this.prune();
    if (this.seen.has(id)) {
      return true;
    }
    this.seen.set(id, Date.now());
    return false;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, at] of this.seen) {
      if (at < cutoff) {
        this.seen.delete(key);
      }
    }
  }
}

export function padEd25519Seed(secret: string): Buffer {
  let seed = secret;
  while (Buffer.byteLength(seed, "utf8") < 32) {
    seed += seed;
  }
  return Buffer.from(seed, "utf8").subarray(0, 32);
}

export function ed25519PrivateKeyDer(secret: string): Buffer {
  return Buffer.concat([PKCS8_ED25519_PREFIX, padEd25519Seed(secret)]);
}
