export interface WecomAibotMedia {
  kind: "image" | "file";
  url: string;
  aeskey: string;
}

export interface WecomAibotInbound {
  text: string;
  media: WecomAibotMedia[];
}

interface WecomAibotItem {
  msgtype?: string;
  text?: { content?: string };
  image?: { url?: string; aeskey?: string };
  file?: { url?: string; aeskey?: string };
  voice?: { content?: string; recognition?: string };
}

export interface WecomAibotBody extends WecomAibotItem {
  mixed?: { msg_item?: WecomAibotItem[] };
}

export function collectWecomAibotInbound(body: WecomAibotBody): WecomAibotInbound {
  const texts: string[] = [];
  const media: WecomAibotMedia[] = [];
  if (body.msgtype === "mixed") {
    for (const item of body.mixed?.msg_item ?? []) {
      absorbWecomItem(item, texts, media);
    }
    return { text: texts.join("\n").trim(), media };
  }
  absorbWecomItem(body, texts, media);
  return { text: texts.join("\n").trim(), media };
}

export function stripWecomMention(text: string): string {
  return text.replace(/^@\S+\s*/, "").trim();
}

function absorbWecomItem(item: WecomAibotItem, texts: string[], media: WecomAibotMedia[]): void {
  const type = item.msgtype ?? "";
  if (type === "text") {
    const content = item.text?.content?.trim();
    if (content) {
      texts.push(content);
    }
  }
  if (type === "voice") {
    const content = item.voice?.content?.trim() || item.voice?.recognition?.trim();
    if (content) {
      texts.push(content);
    }
  }
  if (type === "image" && item.image?.url) {
    media.push({ kind: "image", url: item.image.url, aeskey: item.image.aeskey ?? "" });
  }
  if (type === "file" && item.file?.url) {
    media.push({ kind: "file", url: item.file.url, aeskey: item.file.aeskey ?? "" });
  }
}
