"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessContext } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  getOrCreateWhatsAppConfig,
  sendManualWhatsAppReply,
} from "@/services/whatsapp";
import { isTwilioConfigured } from "@/services/twilio";
import { getAppUrl } from "@/lib/env";
import { whatsappConfigSchema } from "@/lib/validations";

export async function getWhatsAppSettings() {
  const ctx = await requireBusinessContext();
  const config = await getOrCreateWhatsAppConfig(ctx.businessId);
  const twilioConfigured = isTwilioConfigured();
  const webhookUrl = `${getAppUrl()}/api/webhooks/whatsapp`;

  return {
    config,
    twilioConfigured,
    webhookUrl,
    businessName: ctx.business.name,
  };
}

export async function updateWhatsAppConfig(formData: FormData) {
  const ctx = await requireBusinessContext();

  const parsed = whatsappConfigSchema.safeParse({
    isEnabled: formData.get("isEnabled") === "true",
    autoReplyEnabled: formData.get("autoReplyEnabled") === "true",
    whatsappNumber: formData.get("whatsappNumber") || undefined,
    greetingMessage: formData.get("greetingMessage") || undefined,
    saleAlertsEnabled: formData.get("saleAlertsEnabled") === "true",
    ownerAlertPhone: formData.get("ownerAlertPhone") || undefined,
  });

  if (!parsed.success) {
    return { error: "Invalid configuration" };
  }

  await getOrCreateWhatsAppConfig(ctx.businessId);

  const config = await prisma.whatsAppConfig.update({
    where: { businessId: ctx.businessId },
    data: {
      isEnabled: parsed.data.isEnabled,
      autoReplyEnabled: parsed.data.autoReplyEnabled,
      whatsappNumber: parsed.data.whatsappNumber,
      greetingMessage: parsed.data.greetingMessage,
      saleAlertsEnabled: parsed.data.saleAlertsEnabled,
      ownerAlertPhone: parsed.data.ownerAlertPhone,
      twilioNumber:
        process.env.TWILIO_WHATSAPP_NUMBER?.replace(/^whatsapp:/i, "") ?? undefined,
    },
  });

  revalidatePath("/whatsapp");
  return { success: true, config };
}

export async function sendTestWhatsAppMessage(phone: string) {
  const ctx = await requireBusinessContext();
  const config = await getOrCreateWhatsAppConfig(ctx.businessId);

  if (!config.isEnabled) {
    return { error: "Enable WhatsApp AI first" };
  }

  const result = await sendManualWhatsAppReply(
    ctx.businessId,
    phone,
    `✅ Test from ${ctx.business.name}!\n\nYour WhatsApp AI is working. Customers can ask: "Do you have Paracetamol?" and get instant stock replies.`
  );

  if (!result.success) {
    return { error: result.error ?? "Failed to send test message" };
  }

  revalidatePath("/whatsapp");
  return { success: true };
}

export async function simulateInboundMessage(message: string) {
  const ctx = await requireBusinessContext();
  const { generateCustomerReply } = await import("@/services/whatsapp");

  const reply = await generateCustomerReply(
    ctx.businessId,
    message,
    "+2348000000000"
  );

  await prisma.whatsAppMessage.create({
    data: {
      businessId: ctx.businessId,
      direction: "INBOUND",
      fromNumber: "simulator",
      toNumber: "simulator",
      body: message,
      customerPhone: "+2348000000000",
      status: "REPLIED",
      aiResponse: reply,
    },
  });

  await prisma.whatsAppMessage.create({
    data: {
      businessId: ctx.businessId,
      direction: "OUTBOUND",
      fromNumber: "simulator",
      toNumber: "simulator",
      body: reply,
      customerPhone: "+2348000000000",
      status: "REPLIED",
    },
  });

  revalidatePath("/whatsapp");
  return { reply };
}
