import { prisma } from "@/lib/db";
import { normalizeNigerianPhone } from "@/lib/phone";
import type { Role } from "@prisma/client";

export interface ResolvedWhatsAppManager {
  businessId: string;
  role: Role;
  userId?: string;
  employeeId?: string;
}

/**
 * Resolves an inbound WhatsApp phone number to a business Owner/Manager.
 * Checks `Membership.phone` first — the self-service number real (logged-in)
 * team members set in Settings → Team. `Employee.phone` is a legacy fallback
 * (that model isn't wired to any UI today), and `Business.phone` is the
 * last resort, treated as the OWNER's line.
 */
export async function resolveManagerFromWhatsApp(
  rawPhone: string
): Promise<ResolvedWhatsAppManager | null> {
  const phone = normalizeNigerianPhone(rawPhone);
  const last10 = phone.replace(/\D/g, "").slice(-10);
  if (!last10) return null;

  const membership = await prisma.membership.findFirst({
    where: {
      role: { in: ["OWNER", "MANAGER"] },
      phone: { contains: last10 },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (membership) {
    return { businessId: membership.businessId, role: membership.role, userId: membership.userId };
  }

  const employee = await prisma.employee.findFirst({
    where: {
      isActive: true,
      role: { in: ["OWNER", "MANAGER"] },
      phone: { contains: last10 },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (employee) {
    return { businessId: employee.businessId, role: employee.role, employeeId: employee.id };
  }

  const business = await prisma.business.findFirst({
    where: { phone: { contains: last10 } },
    orderBy: { updatedAt: "desc" },
  });
  if (business) {
    return { businessId: business.id, role: "OWNER" };
  }

  return null;
}
