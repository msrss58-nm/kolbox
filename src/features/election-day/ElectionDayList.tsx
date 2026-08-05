import { useMemo } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, SearchX, Users } from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { cn } from "../../lib/utils";
import { usePermissions } from "../../permissions/usePermissions";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayRow } from "./ElectionDayRow";
import {
  ELECTION_DAY_ROW_COLUMNS,
  type ElectionDayColumnDef,
} from "./electionDayRowColumns";
import type { ElectionDaySortKey, SortDir } from "./useElectionDay";

const COLUMN_LABELS = {
  masad: ELECTION_DAY_TEXT.list.columns.masad,
  name: ELECTION_DAY_TEXT.list.columns.name,
  street: ELECTION_DAY_TEXT.list.columns.street,
  houseNumber: ELECTION_DAY_TEXT.list.columns.houseNumber,
  city: ELECTION_DAY_TEXT.list.columns.city,
  phone: ELECTION_DAY_TEXT.list.columns.phone,
  coordinator: ELECTION_DAY_TEXT.list.columns.coordinator,
  notes: ELECTION_DAY_TEXT.list.columns.notes,
  status: ELECTION_DAY_TEXT.list.columns.status,
} as const;

function SortableHeader({
  label,
  active,
  dir,
  onClick,
  centered,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  centered?: boolean;
}) {
  const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-w-0 items-center gap-1 truncate text-xs font-bold",
        centered && "justify-center",
        active ? "text-primary-600" : "text-slate-400 hover:text-slate-600",
      )}
    >
      <span className="truncate">{label}</span>
      <Icon className="size-3 shrink-0" />
    </button>
  );
}

function ListHeader({
  columns,
  sortBy,
  sortDir,
  onSort,
}: {
  columns: readonly ElectionDayColumnDef[];
  sortBy: ElectionDaySortKey | null;
  sortDir: SortDir;
  onSort: (key: ElectionDaySortKey) => void;
}) {
  return (
    <div
      className="hidden border-b border-slate-100 px-4 py-2.5 text-center md:grid md:items-center md:gap-3"
      style={{ gridTemplateColumns: columns.map((c) => c.width).join(" ") }}
    >
      {columns.map((col) => {
        if (col.key === "city") {
          return (
            <SortableHeader
              key={col.key}
              label={COLUMN_LABELS.city}
              active={sortBy === "city"}
              dir={sortDir}
              onClick={() => onSort("city")}
              centered
            />
          );
        }
        if (col.key === "status") {
          return (
            <SortableHeader
              key={col.key}
              label={COLUMN_LABELS.status}
              active={sortBy === "status"}
              dir={sortDir}
              onClick={() => onSort("status")}
              centered
            />
          );
        }
        return (
          <span
            key={col.key}
            className="min-w-0 truncate text-xs font-bold text-slate-400"
          >
            {COLUMN_LABELS[col.key]}
          </span>
        );
      })}
    </div>
  );
}

/** Kept the same across the loading/empty/no-matches/list states so
 * switching between them (e.g. a filter that matches nothing) doesn't
 * collapse the section's height - it just swaps what's shown inside it.
 * A full screen's worth, so it reads the same as a normal registry page. */
const MIN_HEIGHT = "min-h-[70vh]";

export function ElectionDayList({
  contacts,
  hasActiveFilters,
  sortBy,
  sortDir,
  onSort,
  onOpen,
}: {
  contacts: ElectionDayVoter[] | null;
  hasActiveFilters: boolean;
  sortBy: ElectionDaySortKey | null;
  sortDir: SortDir;
  onSort: (key: ElectionDaySortKey) => void;
  onOpen: (id: string) => void;
}) {
  const { can } = usePermissions();
  const visibleColumns = useMemo(
    () => ELECTION_DAY_ROW_COLUMNS.filter((col) => can(col.permission)),
    [can],
  );

  if (contacts === null) {
    return (
      <div className={cn("space-y-2 bg-white p-4", MIN_HEIGHT)}>
        {[...Array(10)].map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  }

  if (contacts.length === 0) {
    return (
      <div className={cn("flex items-center justify-center bg-white", MIN_HEIGHT)}>
        {hasActiveFilters ? (
          <EmptyState
            icon={SearchX}
            title={ELECTION_DAY_TEXT.list.noMatches.title}
            hint={ELECTION_DAY_TEXT.list.noMatches.hint}
          />
        ) : (
          <EmptyState
            icon={Users}
            title={ELECTION_DAY_TEXT.list.empty.title}
            hint={ELECTION_DAY_TEXT.list.empty.hint}
          />
        )}
      </div>
    );
  }

  return (
    <div className={cn("bg-white", MIN_HEIGHT)}>
      <ListHeader
        columns={visibleColumns}
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={onSort}
      />
      {contacts.map((contact) => (
        <ElectionDayRow
          key={contact.id}
          contact={contact}
          columns={visibleColumns}
          onOpen={() => onOpen(contact.id)}
        />
      ))}
    </div>
  );
}
