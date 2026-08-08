import { timingSafeEqual } from "node:crypto";

function getTelegramBotToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${getTelegramBotToken()}/${method}`;
}

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

/**
 * Sends with legacy "Markdown" parse mode (our message templates already use
 * *bold* for product/field names). Legacy Markdown, unlike MarkdownV2, doesn't
 * require escaping punctuation — but a literal `_`/`*`/`` ` ``/`[` inside an
 * interpolated name (product, supplier, business name) can still produce an
 * unpaired entity and a 400 from Telegram. Rather than escaping every
 * interpolation site across the codebase, retry once as plain text.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  const token = getTelegramBotToken();
  if (!token) {
    return { success: false, error: "Telegram bot not configured" };
  }

  const send = async (parseMode: "Markdown" | undefined) => {
    const response = await fetch(apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    });
    const json = (await response.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };
    return { response, json };
  };

  try {
    let { response, json } = await send("Markdown");
    if (!response.ok && /can't parse entities/i.test(json.description ?? "")) {
      ({ response, json } = await send(undefined));
    }
    if (!response.ok || !json.ok) {
      return { success: false, error: json.description ?? "Failed to send message" };
    }
    return { success: true, messageId: json.result?.message_id };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Failed to send message";
    return { success: false, error };
  }
}

/**
 * Telegram sends back the literal secret_token you registered with
 * setWebhook in the `x-telegram-bot-api-secret-token` header — a simple
 * shared-secret check, not an HMAC signature.
 */
export function validateTelegramSecret(headerToken: string | null): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    return process.env.NODE_ENV === "development";
  }
  if (!headerToken || headerToken.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(headerToken), Buffer.from(expected));
}

/**
 * Resolves a Telegram file_id to its bytes. Two calls: getFile to resolve a
 * temporary file_path, then a plain fetch against the file download host.
 */
export async function fetchTelegramFile(
  fileId: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const token = getTelegramBotToken();
  if (!token) return null;

  const fileInfoRes = await fetch(apiUrl(`getFile?file_id=${encodeURIComponent(fileId)}`));
  if (!fileInfoRes.ok) return null;
  const fileInfo = (await fileInfoRes.json()) as {
    ok: boolean;
    result?: { file_path: string };
  };
  if (!fileInfo.ok || !fileInfo.result?.file_path) return null;

  const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") ?? guessContentType(fileInfo.result.file_path);
  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

function guessContentType(filePath: string): string {
  if (filePath.endsWith(".oga") || filePath.endsWith(".ogg")) return "audio/ogg";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

export async function setTelegramWebhook(url: string): Promise<{ success: boolean; error?: string }> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const response = await fetch(apiUrl("setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ["message"],
    }),
  });
  const json = (await response.json()) as { ok: boolean; description?: string };
  if (!json.ok) return { success: false, error: json.description };
  return { success: true };
}
