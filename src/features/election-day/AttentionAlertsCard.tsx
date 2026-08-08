import { TriangleAlert, Bell, PhoneMissed, Users as UsersIcon, Car } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardTitle } from "../../components/ui/Card";
import { cn } from "../../lib/utils";
import { usePermissions } from "../../permissions/usePermissions";
import type { AttentionAlertRow } from "./attentionAlerts";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

const text = ELECTION_DAY_TEXT.dashboard.attention;

const ROW_STYLE: Record<
  AttentionAlertRow["type"],
  { icon: LucideIcon; bg: string; text: string }
> = {
  callAttempts: { icon: PhoneMissed, bg: "bg-rose-50", text: "text-rose-700" },
  ridesUnmatched: { icon: Car, bg: "bg-amber-50", text: "text-amber-700" },
  coordinatorOverload: { icon: UsersIcon, bg: "bg-orange-50", text: "text-orange-700" },
  remindersOverdue: { icon: Bell, bg: "bg-blue-50", text: "text-blue-700" },
};

function rowText(row: AttentionAlertRow): { label: string; hint: string } {
  switch (row.type) {
    case "callAttempts":
      return { label: text.callAttempts(row.count), hint: text.callAttemptsHint };
    case "ridesUnmatched":
      return { label: text.ridesUnmatched(row.count), hint: text.ridesUnmatchedHint };
    case "coordinatorOverload":
      return {
        label: text.coordinatorOverload(row.count, row.coordinator),
        hint: text.coordinatorOverloadHint,
      };
    case "remindersOverdue":
      return { label: text.remindersOverdue(row.count), hint: text.remindersOverdueHint };
  }
}

/** Dashboard "מוקדי תשומת לב" - each row filtered by the viewing session's
 * own permission for the underlying signal (e.g. a `voting`-role session
 * that can't see ride status never sees the rides-unmatched row), so this
 * card never leaks a count the rest of the dashboard already hides. Hides
 * itself entirely once nothing survives the filter. */
export function AttentionAlertsCard({ rows }: { rows: AttentionAlertRow[] }) {
  const { can } = usePermissions();
  const visible = rows.filter((row) => can(row.permission));

  if (visible.length === 0) return null;

  return (
    <Card>
      <CardTitle className="flex items-center gap-1.5">
        <TriangleAlert className="size-4 text-amber-500" />
        {text.title}
      </CardTitle>
      <ul className="mt-2 space-y-2">
        {visible.map((row) => {
          const style = ROW_STYLE[row.type];
          const { label, hint } = rowText(row);
          const Icon = style.icon;
          return (
            <li
              key={row.type}
              className={cn("flex items-center gap-3 rounded-xl p-3", style.bg)}
            >
              <span className={cn("text-2xl font-extrabold tabular-nums", style.text)}>
                {row.count}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-800">{label}</p>
                <p className="truncate text-xs text-slate-500">{hint}</p>
              </div>
              <Icon className={cn("size-5 shrink-0", style.text)} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
