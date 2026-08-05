"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Role } from "@prisma/client";
import {
  inviteTeamMember,
  cancelTeamInvite,
  updateMemberRole,
  removeTeamMember,
  updateMyPhone,
} from "@/actions/team";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_LABELS } from "@/lib/team";
import { Copy, Loader2, Trash2, UserMinus } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { MemberAccessEditor } from "@/features/settings/member-access-editor";
import type { RolePermissionsMap } from "@/lib/permissions";

type Member = {
  id: string;
  role: Role;
  phone?: string | null;
  sectionOverrides?: Prisma.JsonValue | null;
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
};

type PendingInvite = {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
};

interface TeamPanelProps {
  members: Member[];
  pendingInvites: PendingInvite[];
  currentUserId: string;
  canManage: boolean;
  canChangeRoles: boolean;
  canCustomizeMemberAccess?: boolean;
  rolePermissions?: RolePermissionsMap;
  inviteableRoles: Role[];
}

function memberName(member: Member) {
  const name = [member.user.firstName, member.user.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || member.user.email;
}

export function TeamPanel({
  members,
  pendingInvites,
  currentUserId,
  canManage,
  canChangeRoles,
  canCustomizeMemberAccess = false,
  rolePermissions,
  inviteableRoles,
}: TeamPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState<Role>(inviteableRoles[0] ?? Role.STAFF);
  const currentMember = members.find((m) => m.user.id === currentUserId);
  const [phoneDraft, setPhoneDraft] = useState(currentMember?.phone ?? "");
  const [phoneSaved, setPhoneSaved] = useState(false);

  function handleInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInviteUrl(null);
    const formData = new FormData(e.currentTarget);
    formData.set("role", role);

    startTransition(async () => {
      const result = await inviteTeamMember(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.inviteUrl) {
        setInviteUrl(result.inviteUrl);
      }
      router.refresh();
      (e.target as HTMLFormElement).reset();
    });
  }

  async function copyInviteUrl() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleCancelInvite(inviteId: string) {
    startTransition(async () => {
      const result = await cancelTeamInvite(inviteId);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  function handleRoleChange(userId: string, newRole: Role) {
    const formData = new FormData();
    formData.set("userId", userId);
    formData.set("role", newRole);
    startTransition(async () => {
      const result = await updateMemberRole(formData);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  function handleRemove(userId: string) {
    if (!confirm("Remove this person from your team?")) return;
    startTransition(async () => {
      const result = await removeTeamMember(userId);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  function handleSavePhone(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPhoneSaved(false);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await updateMyPhone(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      setPhoneSaved(true);
      router.refresh();
      setTimeout(() => setPhoneSaved(false), 2000);
    });
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSavePhone}
        className="space-y-3 rounded-xl border p-4 surface-muted"
      >
        <div>
          <p className="text-sm font-medium">Your WhatsApp number</p>
          <p className="text-xs text-muted-foreground">
            Used to verify it&apos;s you when you send invoice photos or
            voice notes to the WhatsApp inventory assistant. Only you can
            change your own number.
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            name="phone"
            type="tel"
            placeholder="e.g. 08012345678"
            value={phoneDraft}
            onChange={(e) => setPhoneDraft(e.target.value)}
            disabled={isPending}
          />
          <Button type="submit" disabled={isPending} variant="outline">
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </div>
        {phoneSaved && (
          <p className="text-xs text-green-600">WhatsApp number saved!</p>
        )}
      </form>

      {canManage && inviteableRoles.length > 0 && (
        <form onSubmit={handleInvite} className="space-y-3 rounded-xl border p-4 surface-muted">
          <p className="text-sm font-medium">Invite team member</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="team-email">Email address</Label>
              <Input
                id="team-email"
                name="email"
                type="email"
                required
                placeholder="cashier@example.com"
                disabled={isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="team-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as Role)}
                disabled={isPending}
              >
                <SelectTrigger id="team-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inviteableRoles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={isPending} className="w-full">
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Send invite"
                )}
              </Button>
            </div>
          </div>
          {inviteUrl && (
            <div className="flex flex-col gap-2 rounded-lg bg-card border p-3">
              <p className="text-xs text-muted-foreground">
                Share this link with your team member:
              </p>
              <div className="flex gap-2">
                <Input readOnly value={inviteUrl} className="text-xs font-mono" />
                <Button type="button" variant="outline" size="icon" onClick={copyInviteUrl}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              {copied && (
                <p className="text-xs text-green-600">Link copied!</p>
              )}
            </div>
          )}
        </form>
      )}

      {!canManage && (
        <p className="text-sm text-muted-foreground">
          Only owners and managers can invite team members.
        </p>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium">
          Team members ({members.length})
        </p>
        <ul className="divide-y rounded-xl border">
          {members.map((member) => (
            <li
              key={member.id}
              className="flex flex-col gap-3 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{memberName(member)}</p>
                  <p className="text-sm text-muted-foreground truncate">
                    {member.user.email}
                  </p>
                  {member.phone && (
                    <p className="text-xs text-muted-foreground truncate">
                      WhatsApp: {member.phone}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canChangeRoles &&
                  member.role !== Role.OWNER &&
                  member.user.id !== currentUserId ? (
                    <Select
                      value={member.role}
                      onValueChange={(v) =>
                        handleRoleChange(member.user.id, v as Role)
                      }
                      disabled={isPending}
                    >
                      <SelectTrigger className="w-[120px] h-10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[Role.MANAGER, Role.CASHIER, Role.STAFF].map((r) => (
                          <SelectItem key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-sm font-medium text-brand px-3 py-1.5 rounded-full bg-biz-blue/10 dark:bg-primary/15">
                      {ROLE_LABELS[member.role]}
                    </span>
                  )}
                  {canChangeRoles &&
                    member.role !== Role.OWNER &&
                    member.user.id !== currentUserId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-10 w-10"
                        onClick={() => handleRemove(member.user.id)}
                        disabled={isPending}
                        aria-label="Remove member"
                      >
                        <UserMinus className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                </div>
              </div>
              {canCustomizeMemberAccess &&
                rolePermissions &&
                member.role !== Role.OWNER && (
                  <MemberAccessEditor
                    membershipId={member.id}
                    memberRole={member.role}
                    sectionOverrides={member.sectionOverrides ?? null}
                    rolePermissions={rolePermissions}
                  />
                )}
            </li>
          ))}
        </ul>
      </div>

      {pendingInvites.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Pending invites</p>
          <ul className="divide-y rounded-xl border">
            {pendingInvites.map((invite) => (
              <li
                key={invite.id}
                className="flex items-center justify-between gap-3 p-4"
              >
                <div>
                  <p className="font-medium">{invite.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {ROLE_LABELS[invite.role]} · expires{" "}
                    {new Date(invite.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                {canManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleCancelInvite(invite.id)}
                    disabled={isPending}
                    aria-label="Cancel invite"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-950/40 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
    </div>
  );
}
