import { Role } from "@prisma/client";
import { prisma } from "@/lib/db";

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  CASHIER: "Cashier",
  STAFF: "Staff",
};

export const INVITEABLE_ROLES: Role[] = [
  Role.MANAGER,
  Role.CASHIER,
  Role.STAFF,
];

export function inviteableRolesFor(actorRole: Role): Role[] {
  if (actorRole === Role.OWNER) {
    return [Role.MANAGER, Role.CASHIER, Role.STAFF];
  }
  if (actorRole === Role.MANAGER) {
    return [Role.CASHIER, Role.STAFF];
  }
  return [];
}

export async function getPendingInviteForEmail(email: string) {
  return prisma.teamInvite.findFirst({
    where: {
      email: email.toLowerCase(),
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { token: true },
  });
}

export async function getTeamMembers(businessId: string) {
  return prisma.membership.findMany({
    where: { businessId },
    select: {
      id: true,
      role: true,
      phone: true,
      sectionOverrides: true,
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          imageUrl: true,
        },
      },
    },
    orderBy: [{ role: "desc" }, { createdAt: "asc" }],
  });
}

export async function getPendingInvites(businessId: string) {
  return prisma.teamInvite.findMany({
    where: {
      businessId,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
}

export function displayName(user: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email;
}
