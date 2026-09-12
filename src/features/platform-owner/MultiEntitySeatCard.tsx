import { UserCog, UserPlus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { LtrValue } from "./MultiEntityLtrValue";
import type { MultiEntitySeat } from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.multiEntity.seat;

/** Label/value row. Stacks on phones and splits label-start/value-end from
 * `sm:` up - the same shape the console's Settings identity rows use, so the
 * sections read as one console. */
function Row({
  label,
  value,
  ltr = false,
}: {
  label: string;
  value: string;
  ltr?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      {ltr ? (
        <LtrValue
          value={value}
          className="text-sm font-semibold text-slate-800 sm:text-end"
        />
      ) : (
        <span className="text-sm font-semibold break-words text-slate-800 sm:text-end">
          {value}
        </span>
      )}
    </div>
  );
}

/**
 * The Multi-Entity Owner seat: unprovisioned, or the current holder.
 *
 * The replace action deliberately does NOT live next to a delete control of
 * any kind. Replacing the seat and purging the previous Auth account are two
 * separate operations with two separate approvals (D-1), and the purge is
 * surfaced by its own card, from durable server state.
 */
export function MultiEntitySeatCard({
  seat,
  loading,
  disabled,
  onProvision,
  onReplace,
}: {
  seat: MultiEntitySeat | null;
  loading: boolean;
  disabled: boolean;
  onProvision: () => void;
  onReplace: () => void;
}) {
  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <UserCog className="size-5 text-slate-700" />
        <CardTitle>{text.title}</CardTitle>
      </div>

      {loading && (
        <div className="space-y-2" aria-hidden>
          <Skeleton className="w-2/3" />
          <Skeleton className="w-1/2" />
          <Skeleton className="w-3/5" />
        </div>
      )}

      {!loading && !seat && (
        <EmptyState
          dense
          icon={UserPlus}
          title={text.emptyTitle}
          hint={text.emptyHint}
          action={
            <Button onClick={onProvision} disabled={disabled}>
              {text.provision}
            </Button>
          }
        />
      )}

      {!loading && seat && (
        <>
          <div>
            <Row label={text.nameLabel} value={seat.name} />
            <Row label={text.emailLabel} value={seat.email} ltr />
            <Row
              label={text.phoneLabel}
              value={seat.phone ?? text.noPhone}
              ltr={!!seat.phone}
            />
            <Row label={text.authIdLabel} value={seat.authUserId} ltr />
            <Row label={text.createdAtLabel} value={formatDateTime(seat.createdAt)} />
            <Row label={text.updatedAtLabel} value={formatDateTime(seat.updatedAt)} />
          </div>
          <Button
            variant="secondary"
            onClick={onReplace}
            disabled={disabled}
            className="w-full sm:w-auto"
          >
            {text.replace}
          </Button>
        </>
      )}
    </Card>
  );
}
