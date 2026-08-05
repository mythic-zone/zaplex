import { createServerSupabaseClient, isSupabaseConfigured } from "@/lib/supabase";

const BUCKET = "whatsapp-media";

function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/mpeg": "mp3",
    "audio/amr": "amr",
  };
  return map[contentType] ?? contentType.split("/")[1] ?? "bin";
}

/**
 * Stores an inbound WhatsApp attachment for audit purposes. Best-effort only
 * — the AI analysis runs directly off the in-memory buffer, so a storage
 * failure here shouldn't block the conversation.
 */
export async function uploadWhatsAppMedia(
  businessId: string,
  buffer: Buffer,
  contentType: string
): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;

  try {
    const supabase = createServerSupabaseClient();
    const path = `${businessId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extensionFor(contentType)}`;

    let { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
      contentType,
      upsert: true,
    });

    if (error && /bucket.*not.*found/i.test(error.message)) {
      await supabase.storage.createBucket(BUCKET, { public: true });
      ({ error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
        contentType,
        upsert: true,
      }));
    }

    if (error) {
      console.error("[whatsapp-media] upload failed:", error.message);
      return null;
    }

    return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  } catch (err) {
    console.error("[whatsapp-media] upload error:", err);
    return null;
  }
}
