import { useCallback, useState } from "react";
import { CalendarDays, History, Home, MapPin, Phone, UsersRound } from "lucide-react";
import { ClassificationBadge } from "../../components/ui/Badge";
import { Drawer } from "../../components/ui/Drawer";
import { Skeleton } from "../../components/ui/Skeleton";
import { CLASSIFICATION_LABELS } from "../../constants/labels";
import { useAsyncData } from "../../hooks/useAsyncData";
import { fmtRelative } from "../../lib/utils";
import { api } from "../../services/api";
import type { Activist, Classification, PollingStation, Voter } from "../../types";
import { ClassifySegment } from "./ClassifySegment";
import { VOTER_DRAWER_TEXT } from "./voters.constants";

export function VoterDrawer(props: {
  voter: Voter | null;
  station: PollingStation | null;
  activistById: Map<string, Activist>;
  onClose: () => void;
  onClassify: (c: Classification, includeFamily: boolean) => void;
}) {
  if (!props.voter) return null;
  // key remounts the content when the voter or their classification changes,
  // resetting local state (history, checkbox) without setState-in-effect
  return (
    <VoterDrawerContent
      key={`${props.voter.id}:${props.voter.classifiedAt ?? ""}`}
      {...props}
      voter={props.voter}
    />
  );
}

function VoterDrawerContent({
  voter,
  station,
  activistById,
  onClose,
  onClassify,
}: {
  voter: Voter;
  station: PollingStation | null;
  activistById: Map<string, Activist>;
  onClose: () => void;
  onClassify: (c: Classification, includeFamily: boolean) => void;
}) {
  const [includeFamily, setIncludeFamily] = useState(false);
  const fetchHistory = useCallback(() => api.getVoterHistory(voter.id), [voter.id]);
  const { data: history } = useAsyncData(fetchHistory);

  const classifiedByName = voter.classifiedBy
    ? (activistById.get(voter.classifiedBy)?.firstName ?? "") +
      " " +
      (activistById.get(voter.classifiedBy)?.lastName ?? "")
    : null;

  const details = [
    {
      icon: Home,
      label: VOTER_DRAWER_TEXT.fields.address,
      value: `${voter.street} ${voter.houseNumber}, ${voter.city}`,
    },
    {
      icon: Phone,
      label: VOTER_DRAWER_TEXT.fields.phone,
      value: voter.phone ?? VOTER_DRAWER_TEXT.fields.unknownPhone,
      ltr: voter.phone !== null,
    },
    {
      icon: CalendarDays,
      label: VOTER_DRAWER_TEXT.fields.birthYear,
      value: String(voter.birthYear),
    },
    {
      icon: MapPin,
      label: VOTER_DRAWER_TEXT.fields.station,
      value: station
        ? `קלפי ${station.number} · ${station.address}`
        : VOTER_DRAWER_TEXT.fields.noStation,
    },
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${voter.firstName} ${voter.lastName}`}
      subtitle={
        <span className="tabular-nums" dir="ltr">
          {voter.nationalId}
        </span>
      }
      footer={
        <div className="space-y-2.5">
          {voter.familyId && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={includeFamily}
                onChange={(e) => setIncludeFamily(e.target.checked)}
                className="size-4 accent-primary-600"
              />
              <UsersRound className="size-4 text-slate-400" />
              {VOTER_DRAWER_TEXT.includeFamily}
            </label>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-slate-700">
              {VOTER_DRAWER_TEXT.classifyLabel}
            </span>
            <ClassifySegment
              value={voter.classification}
              onChange={(c) => onClassify(c, includeFamily)}
            />
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Current status */}
        <div className="flex items-center justify-between rounded-xl bg-slate-50 p-4">
          <div>
            <p className="text-xs font-semibold text-slate-500">
              {VOTER_DRAWER_TEXT.currentStatus}
            </p>
            <div className="mt-1">
              <ClassificationBadge classification={voter.classification} />
            </div>
          </div>
          {voter.classifiedAt && (
            <div className="text-end text-xs text-slate-500">
              {classifiedByName && (
                <p>{VOTER_DRAWER_TEXT.classifiedBy(classifiedByName)}</p>
              )}
              <p>{fmtRelative(voter.classifiedAt)}</p>
            </div>
          )}
        </div>

        {/* Details */}
        <dl className="space-y-3">
          {details.map(({ icon: Icon, label, value, ltr }) => (
            <div key={label} className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-50">
                <Icon className="size-4 text-primary-600" />
              </span>
              <div className="min-w-0">
                <dt className="text-xs font-semibold text-slate-400">{label}</dt>
                <dd
                  className="truncate text-sm font-medium text-slate-700 tabular-nums"
                  dir={ltr ? "ltr" : undefined}
                >
                  {value}
                </dd>
              </div>
            </div>
          ))}
        </dl>

        {/* History */}
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold text-slate-700">
            <History className="size-4 text-slate-400" />
            {VOTER_DRAWER_TEXT.historyTitle}
          </h3>
          {history === null ? (
            <div className="space-y-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : history.length === 0 ? (
            <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-400">
              {VOTER_DRAWER_TEXT.historyEmpty}
            </p>
          ) : (
            <ol className="space-y-2">
              {history.map((e) => {
                const a = activistById.get(e.activistId);
                return (
                  <li
                    key={e.id}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm"
                  >
                    <span className="text-slate-600">
                      {CLASSIFICATION_LABELS[e.classification]}
                      {a && (
                        <span className="text-slate-400">
                          {" "}
                          · {a.firstName} {a.lastName}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-slate-400">{fmtRelative(e.at)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </Drawer>
  );
}
