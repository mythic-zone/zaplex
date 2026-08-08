import { NextResponse } from "next/server";
import { validateTelegramSecret } from "@/services/telegram";
import { processInboundTelegram } from "@/services/telegram-bot";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: { file_id: string; mime_type?: string };
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

const recentlyProcessed = new Set<string>();
const MAX_PROCESSED = 500;

function markProcessed(key: string) {
  recentlyProcessed.add(key);
  if (recentlyProcessed.size > MAX_PROCESSED) {
    const first = recentlyProcessed.values().next().value;
    if (first) recentlyProcessed.delete(first);
  }
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const limit = rateLimit(`telegram-webhook:${ip}`, 120, 60_000);
  if (!limit.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!validateTelegramSecret(secret)) {
    return NextResponse.json({ error: "Invalid secret token" }, { status: 403 });
  }

  try {
    const update = (await request.json()) as TelegramUpdate;
    const message = update.message;
    if (!message) {
      return NextResponse.json({ ok: true });
    }

    const dedupeKey = `${message.chat.id}:${message.message_id}`;
    if (recentlyProcessed.has(dedupeKey)) {
      return NextResponse.json({ ok: true });
    }
    markProcessed(dedupeKey);

    const from = String(message.chat.id);
    const body = message.text ?? message.caption ?? "";

    let mediaFileId: string | undefined;
    let mediaContentType: string | undefined;
    if (message.photo && message.photo.length > 0) {
      mediaFileId = message.photo[message.photo.length - 1].file_id;
      mediaContentType = "image/jpeg";
    } else if (message.voice) {
      mediaFileId = message.voice.file_id;
      mediaContentType = message.voice.mime_type ?? "audio/ogg";
    }

    if (!from || (!body && !mediaFileId)) {
      return NextResponse.json({ ok: true });
    }

    await processInboundTelegram({
      from,
      body,
      messageId: String(message.message_id),
      mediaFileId,
      mediaContentType,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Telegram webhook error]", err);
    return NextResponse.json({ ok: true });
  }
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "Zaplex Telegram AI",
  });
}
