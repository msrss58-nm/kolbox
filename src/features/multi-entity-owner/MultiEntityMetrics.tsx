import { fmtNum } from "../../lib/utils";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { formatVotedShare } from "./multiEntityAggregateFormat";
import type { MultiEntityAggregateMetrics } from "./multiEntityOwnerClient";

const text = MULTI_ENTITY_OWNER_TEXT.metrics;

type MetricKey = keyof MultiEntityAggregateMetrics | "votedPct";

/**
 * Platform Stage 7: the approved Stage 6 counts, grouped as the Election Day
 * dashboard groups them (turnout, follow-up, rides). Rendered ONLY for a
 * `reported` row or for server totals - the caller never passes withheld
 * data, and this component has no way to render a missing value as 0.
 */
export function MultiEntityMetrics({
  metrics,
  headingLevel,
}: {
  metrics: MultiEntityAggregateMetrics;
  headingLevel: "h2" | "h3" | "h4";
}) {
  const Heading = headingLevel;
  const groups: { key: string; title: string; items: [MetricKey, string][] }[] = [
    {
      key: "turnout",
      title: text.groups.turnout,
      items: [
        ["contactsTotal", fmtNum(metrics.contactsTotal)],
        ["voted", fmtNum(metrics.voted)],
        ["votedPct", formatVotedShare(metrics) ?? "—"],
      ],
    },
    {
      key: "followUp",
      title: text.groups.followUp,
      items: [
        ["followUpRemaining", fmtNum(metrics.followUpRemaining)],
        ["followUpClosed", fmtNum(metrics.followUpClosed)],
      ],
    },
    {
      key: "rides",
      title: text.groups.rides,
      items: [
        ["rideNeeded", fmtNum(metrics.rideNeeded)],
        ["rideArranged", fmtNum(metrics.rideArranged)],
        ["rideCompleted", fmtNum(metrics.rideCompleted)],
      ],
    },
  ];

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <section key={group.key} className="space-y-1.5">
          <Heading className="text-xs font-bold text-slate-500">{group.title}</Heading>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {group.items.map(([key, value]) => (
              <div key={key} className="min-w-0 rounded-xl bg-slate-50 px-3 py-2">
                <dt className="text-xs leading-snug text-slate-500">{text[key]}</dt>
                <dd
                  className="text-lg font-extrabold tabular-nums text-slate-800"
                  data-metric={key}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
