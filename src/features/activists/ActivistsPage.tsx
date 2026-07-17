import { useState } from "react";
import { Megaphone, Plus, UserPlus } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import type { Activist } from "../../types";
import { ACTIVISTS_TEXT } from "./activists.constants";
import { ActivistDrawer } from "./ActivistDrawer";
import { ActivistModal } from "./ActivistModal";
import { ActivistRow } from "./ActivistRow";
import { PodiumCard } from "./PodiumCard";
import { useActivists } from "./useActivists";

const PODIUM_SIZE = 3;

export function ActivistsPage() {
  const { activists, upsert } = useActivists();
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [modalActivist, setModalActivist] = useState<Activist | null | "new">(null);

  const top3 = activists?.slice(0, PODIUM_SIZE) ?? [];
  const rest = activists?.slice(PODIUM_SIZE) ?? [];
  const drawerActivist = activists?.find((a) => a.id === drawerId) ?? null;

  return (
    <>
      <PageHeader
        title={ACTIVISTS_TEXT.title}
        subtitle={
          activists
            ? ACTIVISTS_TEXT.subtitle(activists.length)
            : ACTIVISTS_TEXT.loadingSubtitle
        }
        actions={
          <Button onClick={() => setModalActivist("new")}>
            <Plus className="size-4" />
            {ACTIVISTS_TEXT.addActivist}
          </Button>
        }
      />

      {activists === null ? (
        <div className="grid gap-3 md:grid-cols-3">
          {[...Array(PODIUM_SIZE)].map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : activists.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={ACTIVISTS_TEXT.empty.title}
          hint={ACTIVISTS_TEXT.empty.hint}
          action={
            <Button onClick={() => setModalActivist("new")}>
              <UserPlus className="size-4" />
              {ACTIVISTS_TEXT.empty.action}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:items-start">
            {top3.map((a, i) => (
              <PodiumCard
                key={a.id}
                activist={a}
                place={i as 0 | 1 | 2}
                onOpen={() => setDrawerId(a.id)}
              />
            ))}
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-100">
            <div className="hidden border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-bold text-slate-500 md:grid md:grid-cols-[2.5rem_1.2fr_0.8fr_0.9fr_6rem_1fr_0.8fr] md:items-center md:gap-3">
              <span>{ACTIVISTS_TEXT.columns.rank}</span>
              <span>{ACTIVISTS_TEXT.columns.name}</span>
              <span>{ACTIVISTS_TEXT.columns.area}</span>
              <span>{ACTIVISTS_TEXT.columns.phone}</span>
              <span>{ACTIVISTS_TEXT.columns.rankBadge}</span>
              <span>{ACTIVISTS_TEXT.columns.progress}</span>
              <span>{ACTIVISTS_TEXT.columns.lastActive}</span>
            </div>
            {rest.map((a, i) => (
              <ActivistRow
                key={a.id}
                activist={a}
                rank={i + PODIUM_SIZE + 1}
                onOpen={() => setDrawerId(a.id)}
              />
            ))}
          </div>
        </>
      )}

      <ActivistDrawer
        activist={drawerActivist}
        onClose={() => setDrawerId(null)}
        onEdit={(a) => setModalActivist(a)}
      />

      <ActivistModal
        open={modalActivist !== null}
        initial={modalActivist === "new" ? null : modalActivist}
        onClose={() => setModalActivist(null)}
        onSaved={upsert}
      />
    </>
  );
}
