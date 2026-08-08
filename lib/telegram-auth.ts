import { prisma } from "@/lib/db";
import type { Role } from "@prisma/client";

export interface ResolvedTelegramManager {
  businessId: string;
  role: Role;
  userId?: string;
  employeeId?: string;
}

/**
 * Resolves an inbound Telegram user ID to a business Owner/Manager, via
 * `Membership.telegramId` — the self-service ID real (logged-in) team
 * members set in Settings -> Team after the bot shows it to them on /start.
 */
export async function resolveManagerFromTelegram(
  telegramId: string
): Promise<ResolvedTelegramManager | null> {
  if (!telegramId) return null;

  const membership = await prisma.membership.findFirst({
    where: {
      role: { in: ["OWNER", "MANAGER"] },
      telegramId,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (membership) {
    return { businessId: membership.businessId, role: membership.role, userId: membership.userId };
  }

  return null;
}
