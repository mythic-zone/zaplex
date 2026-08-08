"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { currentUser } from "@clerk/nextjs/server";
import { Role, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  canChangeRoles,
  canManageTeam,
  requireSectionAccess,
  syncClerkUser,
} from "@/lib/auth";
import { getAppUrl } from "@/lib/env";
import { setActiveBusinessId } from "@/lib/active-business";
import { inviteableRolesFor } from "@/lib/team";
import {
  teamInviteSchema,
  updateMemberRoleSchema,
  updateMyTelegramIdSchema,
} from "@/lib/validations";

const INVITE_TTL_DAYS = 7;

function createInviteToken() {
  return randomBytes(24).toString("hex");
}

export async function inviteTeamMember(formData: FormData) {
  try {
    const ctx = await requireSectionAccess("settings");
    if (!canManageTeam(ctx.role)) {
      return { error: "Only owners and managers can manage the team" };
    }

    const parsed = teamInviteSchema.safeParse({
      email: formData.get("email"),
      role: formData.get("role"),
    });

    if (!parsed.success) {
      return {
        error: parsed.error.flatten().fieldErrors.email?.[0] ??
          parsed.error.flatten().fieldErrors.role?.[0] ??
          "Invalid invite details",
      };
    }

    const role = parsed.data.role as Role;
    const allowed = inviteableRolesFor(ctx.role);
    if (!allowed.includes(role)) {
      return { error: "You cannot assign that role" };
    }

    const email = parsed.data.email.toLowerCase();

    const existingMember = await prisma.membership.findFirst({
      where: {
        businessId: ctx.businessId,
        user: { email: { equals: email, mode: "insensitive" } },
      },
    });

    if (existingMember) {
      return { error: "This person is already on your team" };
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITE_TTL_DAYS);

    const invite = await prisma.teamInvite.upsert({
      where: {
        businessId_email: {
          businessId: ctx.businessId,
          email,
        },
      },
      create: {
        businessId: ctx.businessId,
        email,
        role,
        token: createInviteToken(),
        invitedBy: ctx.userId,
        expiresAt,
      },
      update: {
        role,
        token: createInviteToken(),
        invitedBy: ctx.userId,
        expiresAt,
        acceptedAt: null,
      },
    });

    const inviteUrl = `${getAppUrl()}/invite/${invite.token}`;

    revalidatePath("/settings");
    return { success: true, inviteUrl };
  } catch (error) {
    console.error("inviteTeamMember failed:", error);
    return {
      error:
        error instanceof Error ? error.message : "Could not send invite",
    };
  }
}

export async function cancelTeamInvite(inviteId: string) {
  try {
    const ctx = await requireSectionAccess("settings");
    if (!canManageTeam(ctx.role)) {
      return { error: "Only owners and managers can manage the team" };
    }

    await prisma.teamInvite.deleteMany({
      where: { id: inviteId, businessId: ctx.businessId, acceptedAt: null },
    });

    revalidatePath("/settings");
    return { success: true };
  } catch (error) {
    console.error("cancelTeamInvite failed:", error);
    return { error: "Could not cancel invite" };
  }
}

export async function updateMemberRole(formData: FormData) {
  try {
    const ctx = await requireSectionAccess("settings");
    if (!canChangeRoles(ctx.role)) {
      return { error: "Only the owner can change roles" };
    }

    const parsed = updateMemberRoleSchema.safeParse({
      userId: formData.get("userId"),
      role: formData.get("role"),
    });

    if (!parsed.success) {
      return { error: "Invalid role update" };
    }

    const target = await prisma.membership.findUnique({
      where: {
        userId_businessId: {
          userId: parsed.data.userId,
          businessId: ctx.businessId,
        },
      },
    });

    if (!target) {
      return { error: "Team member not found" };
    }

    if (target.role === Role.OWNER) {
      return { error: "Cannot change the owner's role" };
    }

    if (parsed.data.userId === ctx.userId) {
      return { error: "You cannot change your own role" };
    }

    await prisma.membership.update({
      where: { id: target.id },
      data: { role: parsed.data.role as Role },
    });

    revalidatePath("/settings");
    return { success: true };
  } catch (error) {
    console.error("updateMemberRole failed:", error);
    return { error: "Could not update role" };
  }
}

export async function removeTeamMember(userId: string) {
  try {
    const ctx = await requireSectionAccess("settings");
    if (!canChangeRoles(ctx.role)) {
      return { error: "Only the owner can remove team members" };
    }

    if (userId === ctx.userId) {
      return { error: "You cannot remove yourself" };
    }

    const target = await prisma.membership.findUnique({
      where: {
        userId_businessId: { userId, businessId: ctx.businessId },
      },
    });

    if (!target) {
      return { error: "Team member not found" };
    }

    if (target.role === Role.OWNER) {
      return { error: "Cannot remove the owner" };
    }

    await prisma.membership.delete({ where: { id: target.id } });

    revalidatePath("/settings");
    return { success: true };
  } catch (error) {
    console.error("removeTeamMember failed:", error);
    return { error: "Could not remove team member" };
  }
}

/**
 * Self-service: lets the signed-in member set or clear the Telegram ID used
 * to authorize them in the inventory assistant. Each member manages their
 * own ID only — no one edits it on someone else's behalf.
 */
export async function updateMyTelegramId(formData: FormData) {
  try {
    const ctx = await requireSectionAccess("settings");

    const parsed = updateMyTelegramIdSchema.safeParse({
      telegramId: formData.get("telegramId"),
    });

    if (!parsed.success) {
      return {
        error: parsed.error.flatten().fieldErrors.telegramId?.[0] ?? "Invalid Telegram ID",
      };
    }

    const telegramId = parsed.data.telegramId || null;

    await prisma.membership.update({
      where: { userId_businessId: { userId: ctx.userId, businessId: ctx.businessId } },
      data: { telegramId },
    });

    revalidatePath("/settings");
    return { success: true, telegramId };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { error: "This Telegram ID is already linked to another team member" };
    }
    console.error("updateMyTelegramId failed:", error);
    return { error: "Could not update Telegram ID" };
  }
}

export async function getInviteDetails(token: string) {
  const invite = await prisma.teamInvite.findUnique({
    where: { token },
    include: { business: { select: { name: true } } },
  });

  if (!invite || invite.acceptedAt) {
    return null;
  }

  if (invite.expiresAt < new Date()) {
    return null;
  }

  return {
    businessName: invite.business.name,
    email: invite.email,
    role: invite.role,
  };
}

export async function acceptTeamInvite(token: string) {
  try {
    const user = await currentUser();
    if (!user) {
      return { error: "Sign in to accept this invite", needsAuth: true };
    }

    await syncClerkUser({
      id: user.id,
      emailAddresses: user.emailAddresses,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
    });

    const invite = await prisma.teamInvite.findUnique({
      where: { token },
    });

    if (!invite || invite.acceptedAt) {
      return { error: "This invite is invalid or already used" };
    }

    if (invite.expiresAt < new Date()) {
      return { error: "This invite has expired. Ask for a new one." };
    }

    const userEmail = user.emailAddresses[0]?.emailAddress?.toLowerCase();
    if (userEmail && userEmail !== invite.email.toLowerCase()) {
      return {
        error: `Sign in as ${invite.email} to accept this invite`,
      };
    }

    const existing = await prisma.membership.findUnique({
      where: {
        userId_businessId: {
          userId: user.id,
          businessId: invite.businessId,
        },
      },
    });

    if (existing) {
      await prisma.teamInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });
      await setActiveBusinessId(invite.businessId);
      return { success: true, businessId: invite.businessId, alreadyMember: true };
    }

    await prisma.$transaction([
      prisma.membership.create({
        data: {
          userId: user.id,
          businessId: invite.businessId,
          role: invite.role,
        },
      }),
      prisma.teamInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          businessId: invite.businessId,
          userId: user.id,
          action: "team.member_joined",
          entity: "membership",
          entityId: user.id,
          metadata: { role: invite.role, email: invite.email },
        },
      }),
    ]);

    await setActiveBusinessId(invite.businessId);

    revalidatePath("/settings");
    revalidatePath("/dashboard");
    return { success: true, businessId: invite.businessId };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { success: true, alreadyMember: true };
    }
    console.error("acceptTeamInvite failed:", error);
    return { error: "Could not accept invite. Try again." };
  }
}
