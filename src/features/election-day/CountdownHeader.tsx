import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { DateTimePicker } from "../../components/ui/DateTimePicker";
import { Field } from "../../components/ui/Field";
import { cn } from "../../lib/utils";
import { PermissionGuard } from "../../permissions/PermissionGuard";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { CountdownParts } from "./useCountdown";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function TimeBox({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center rounded-xl bg-white/10 px-2 py-1.5 md:min-w-20 md:px-4 md:py-3">
      <span className="text-2xl font-extrabold tabular-nums text-white md:text-4xl">
        {pad(value)}
      </span>
      <span className="text-[11px] font-semibold text-white/70 md:text-xs">{label}</span>
    </div>
  );
}

export function CountdownHeader({
  deadline,
  parts,
  onSetDeadline,
}: {
  deadline: string | null;
  parts: CountdownParts;
  onSetDeadline: (iso: string | null) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Date | null>(deadline ? new Date(deadline) : null);
  const [trackedDeadline, setTrackedDeadline] = useState(deadline);
  if (trackedDeadline !== deadline) {
    setTrackedDeadline(deadline);
    setDraft(deadline ? new Date(deadline) : null);
  }
  return (
    <div className="relative mb-6 rounded-2xl bg-gradient-to-l from-[#1877f2] to-[#1565c0] p-5 text-center text-white shadow-lg md:p-6">
      <PermissionGuard permission="electionDay.manageSettings">
        <button
          type="button"
          onClick={() => setSettingsOpen((o) => !o)}
          aria-label={ELECTION_DAY_TEXT.countdown.setDeadline}
          className="absolute start-4 top-4 grid size-9 place-items-center rounded-full bg-white/15 text-lg transition hover:bg-white/25"
        >
          ⚙️
        </button>
      </PermissionGuard>

      <p className="text-sm font-semibold text-white/70">
        ⏱️{" "}
        {deadline
          ? parts.expired
            ? ELECTION_DAY_TEXT.countdown.expired
            : ELECTION_DAY_TEXT.countdown.label
          : ELECTION_DAY_TEXT.countdown.noDeadline}
      </p>

      <div
        dir="ltr"
        className={cn(
          "mt-3 flex items-center justify-center gap-1.5 md:gap-2",
          !deadline && "pointer-events-none opacity-40",
        )}
      >
        <TimeBox value={parts.days} label={ELECTION_DAY_TEXT.countdown.days} />
        <span className="text-xl font-bold text-white/40">:</span>
        <TimeBox value={parts.hours} label={ELECTION_DAY_TEXT.countdown.hours} />
        <span className="text-xl font-bold text-white/40">:</span>
        <TimeBox value={parts.minutes} label={ELECTION_DAY_TEXT.countdown.minutes} />
        <span className="text-xl font-bold text-white/40">:</span>
        <TimeBox value={parts.seconds} label={ELECTION_DAY_TEXT.countdown.seconds} />
      </div>

      <PermissionGuard permission="electionDay.manageSettings">
        {settingsOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSetDeadline(draft ? draft.toISOString() : null);
              setSettingsOpen(false);
            }}
            className="mt-5 flex flex-wrap items-end justify-center gap-2 rounded-xl bg-white/15 p-3"
          >
            <div className="[&_label>span]:text-white/80 [&_input]:bg-white/10 [&_input]:text-white [&_input]:ring-white/20 [&_input]:placeholder:text-white/40">
              <Field label={ELECTION_DAY_TEXT.countdown.deadlineFieldLabel}>
                <DateTimePicker value={draft} onChange={setDraft} />
              </Field>
            </div>
            <Button type="submit" variant="secondary" size="md">
              {ELECTION_DAY_TEXT.countdown.setDeadline}
            </Button>
          </form>
        )}
      </PermissionGuard>
    </div>
  );
}
