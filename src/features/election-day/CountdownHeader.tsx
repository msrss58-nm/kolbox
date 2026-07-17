import { useState } from "react";
import { Timer } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { cn } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { CountdownParts } from "./useCountdown";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoToLocalInputValue(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TimeBox({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex min-w-14 flex-col items-center rounded-xl bg-white/10 px-3 py-2 md:min-w-20 md:px-4 md:py-3">
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
  const [draft, setDraft] = useState(deadline ? isoToLocalInputValue(deadline) : "");
  const [trackedDeadline, setTrackedDeadline] = useState(deadline);
  if (trackedDeadline !== deadline) {
    setTrackedDeadline(deadline);
    setDraft(deadline ? isoToLocalInputValue(deadline) : "");
  }

  return (
    <div className="mb-6 flex flex-col gap-5 rounded-2xl bg-gradient-to-l from-primary-700 to-primary-950 p-5 text-white shadow-lg md:flex-row md:items-center md:justify-between md:p-6">
      <div className="flex items-center gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-white/10">
          <Timer className="size-6" />
        </span>
        <div>
          <p className="text-sm font-semibold text-white/70">
            {deadline
              ? parts.expired
                ? ELECTION_DAY_TEXT.countdown.expired
                : ELECTION_DAY_TEXT.countdown.label
              : ELECTION_DAY_TEXT.countdown.noDeadline}
          </p>
          <div
            dir="ltr"
            className={cn(
              "mt-1.5 flex items-center gap-2",
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
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSetDeadline(draft ? new Date(draft).toISOString() : null);
        }}
        className="flex items-end gap-2"
      >
        <div className="[&_label>span]:text-white/80 [&_input]:bg-white/10 [&_input]:text-white [&_input]:ring-white/20 [&_input]:placeholder:text-white/40">
          <Field label={ELECTION_DAY_TEXT.countdown.deadlineFieldLabel}>
            <Input
              type="datetime-local"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" size="md">
          {ELECTION_DAY_TEXT.countdown.setDeadline}
        </Button>
      </form>
    </div>
  );
}
