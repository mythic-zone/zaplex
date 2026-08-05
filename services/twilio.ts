import twilio from "twilio";

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;
  return twilio(accountSid, authToken);
}

export function getTwilioWhatsAppFrom(): string {
  const num = process.env.TWILIO_WHATSAPP_NUMBER ?? "";
  if (num.startsWith("whatsapp:")) return num;
  return `whatsapp:${num}`;
}

export function normalizeWhatsAppNumber(phone: string): string {
  const cleaned = phone.replace(/^whatsapp:/i, "").trim();
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

export function toWhatsAppAddress(phone: string): string {
  const normalized = normalizeWhatsAppNumber(phone);
  return `whatsapp:${normalized}`;
}

export async function sendWhatsAppMessage(
  to: string,
  body: string,
  from?: string
): Promise<{ success: boolean; sid?: string; error?: string }> {
  const client = getTwilioClient();
  if (!client) {
    return { success: false, error: "Twilio not configured" };
  }

  try {
    const message = await client.messages.create({
      from: from ?? getTwilioWhatsAppFrom(),
      to: toWhatsAppAddress(to),
      body,
    });
    return { success: true, sid: message.sid };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Failed to send message";
    return { success: false, error };
  }
}

export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null
): boolean {
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) {
    // Skip validation in development when token missing
    return process.env.NODE_ENV === "development";
  }
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );
}

export function isTwilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_WHATSAPP_NUMBER
  );
}

/**
 * Downloads a Twilio media attachment (MediaUrl0, etc). Twilio media URLs
 * require the same Basic Auth as the REST API — an unauthenticated fetch
 * returns a 401 HTML page, not the file.
 */
export async function fetchTwilioMedia(
  mediaUrl: string
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) return null;

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}
