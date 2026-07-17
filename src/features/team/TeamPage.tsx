import { useState } from "react";
import { Navigate } from "react-router";
import { Pencil, Plus, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { ROLE_LABELS } from "../../constants/labels";
import { ROUTES } from "../../constants/routes";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { fmtDate } from "../../lib/utils";
import { useAuth } from "../auth/authStore";
import { TEAM_MODAL_TEXT, TEAM_TEXT } from "./team.constants";
import { removeTeamMember } from "./teamActions";
import { TeamMemberModal } from "./TeamMemberModal";
import { useTeam, type TeamMember } from "./useTeam";

export function TeamPage() {
  const currentUser = useAuth((s) => s.user);
  const { members, reload } = useTeam();
  const [modalMember, setModalMember] = useState<TeamMember | null | "new">(null);
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);

  const { run: runRemove, busy: removing } = useAsyncAction(
    (member: TeamMember) => removeTeamMember(member.id),
    { successMessage: (_result, member) => TEAM_MODAL_TEXT.toast.removed(member.name) },
  );

  // Manager-only page - anyone else gets bounced to the dashboard.
  if (currentUser && currentUser.role !== "manager") {
    return <Navigate to={ROUTES.dashboard} replace />;
  }

  const confirmRemove = async () => {
    if (!removeTarget) return;
    const ok = await runRemove(removeTarget);
    if (ok) {
      setRemoveTarget(null);
      reload();
    }
  };

  return (
    <>
      <PageHeader
        title={TEAM_TEXT.title}
        subtitle={
          members ? TEAM_TEXT.subtitle(members.length) : TEAM_TEXT.loadingSubtitle
        }
        actions={
          <Button onClick={() => setModalMember("new")}>
            <Plus className="size-4" />
            {TEAM_TEXT.addMember}
          </Button>
        }
      />

      {members === null ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : members.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={TEAM_TEXT.empty.title}
          hint={TEAM_TEXT.empty.hint}
          action={
            <Button onClick={() => setModalMember("new")}>
              <UserPlus className="size-4" />
              {TEAM_TEXT.addMember}
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl bg-white ring-1 ring-slate-100">
          <div className="hidden border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-bold text-slate-500 md:grid md:grid-cols-[1.4fr_1.4fr_0.8fr_0.9fr_7rem_5rem] md:items-center md:gap-3">
            <span>{TEAM_TEXT.columns.name}</span>
            <span>{TEAM_TEXT.columns.email}</span>
            <span>{TEAM_TEXT.columns.role}</span>
            <span>{TEAM_TEXT.columns.area}</span>
            <span>{TEAM_TEXT.columns.joined}</span>
            <span>{TEAM_TEXT.columns.actions}</span>
          </div>

          {members.map((member) => {
            const isSelf = member.id === currentUser?.id;
            return (
              <div
                key={member.id}
                className="border-b border-slate-100 px-4 py-3 last:border-b-0 md:grid md:grid-cols-[1.4fr_1.4fr_0.8fr_0.9fr_7rem_5rem] md:items-center md:gap-3 md:py-2.5"
              >
                <div className="flex items-center justify-between gap-2 md:contents">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">
                      {member.name}
                      {isSelf && (
                        <span className="ms-1.5 text-xs font-normal text-slate-400">
                          {TEAM_TEXT.you}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs tabular-nums text-slate-500 md:hidden">
                      {member.email}
                    </p>
                  </div>
                  <span
                    className="hidden truncate text-sm tabular-nums text-slate-600 md:block"
                    dir="ltr"
                  >
                    {member.email}
                  </span>
                  <span className="hidden text-sm text-slate-600 md:block">
                    {member.role ? ROLE_LABELS[member.role] : "-"}
                  </span>
                  <span className="hidden truncate text-sm text-slate-600 md:block">
                    {member.area || "-"}
                  </span>
                  <span className="hidden text-xs text-slate-400 md:block">
                    {fmtDate(member.joinedAt)}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => setModalMember(member)}
                      className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      aria-label={TEAM_TEXT.editAriaLabel(member.name)}
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      onClick={() => setRemoveTarget(member)}
                      disabled={isSelf}
                      className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent disabled:pointer-events-none disabled:opacity-30"
                      aria-label={TEAM_TEXT.removeAriaLabel(member.name)}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500 md:hidden">
                  <span>{member.role ? ROLE_LABELS[member.role] : "-"}</span>
                  {member.area && <span>· {member.area}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <TeamMemberModal
        open={modalMember !== null}
        initial={modalMember === "new" ? null : modalMember}
        currentUserId={currentUser?.id ?? ""}
        onClose={() => setModalMember(null)}
        onSaved={reload}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        title={TEAM_TEXT.removeTitle}
        message={removeTarget ? TEAM_TEXT.removeConfirm(removeTarget.name) : ""}
        confirmLabel={TEAM_TEXT.removeAction}
        danger
        busy={removing}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />
    </>
  );
}
