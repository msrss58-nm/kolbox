/** Dynamic Non-Voting Reasons - API-boundary validation smoke test, mirroring
 * `smoke-role-normalization.ts`'s precedent for `normalizeRoleRecord`.
 *
 * `normalizeNonVotingReasonRecord` (`src/services/api/nonVotingReasonMapper.ts`)
 * is the only place a raw `election_day_list_non_voting_reasons()` row
 * becomes a trusted `NonVotingReason` - never a blind cast. This suite
 * proves every untrusted field fails safe independently: a non-boolean
 * `is_active` normalizes to `false` (never guessed at as "probably active"),
 * a non-finite/non-number `sort_order` sinks to the end of the display
 * order instead of crashing a sort, and id/name/description are safely
 * coerced rather than thrown on.
 *
 * Run via: npx esbuild scripts/smoke-non-voting-reason-normalization.ts --bundle --format=cjs --outfile=scripts/smoke-non-voting-reason-normalization.cjs && node scripts/smoke-non-voting-reason-normalization.cjs
 */
import {
  normalizeNonVotingReasonRecord,
  type RawNonVotingReasonRow,
} from "../src/services/api/nonVotingReasonMapper";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// ---- a well-formed row round-trips exactly ------------------------------
const wellFormedRow: RawNonVotingReasonRow = {
  id: "r-1",
  name: "לא עונה",
  description: "לא ענה לטלפון",
  is_active: true,
  sort_order: 2,
};
const roundTripped = normalizeNonVotingReasonRecord(wellFormedRow);
assert(roundTripped.id === "r-1", "a well-formed row's id round-trips exactly");
assert(roundTripped.name === "לא עונה", "a well-formed row's name round-trips exactly");
assert(
  roundTripped.description === "לא ענה לטלפון",
  "a well-formed row's description round-trips exactly",
);
assert(roundTripped.isActive === true, "a well-formed row's is_active round-trips exactly");
assert(roundTripped.sortOrder === 2, "a well-formed row's sort_order round-trips exactly");

// ---- is_active: only a real boolean survives, everything else -> false --
for (const badValue of [null, undefined, "true", 1, 0] as const) {
  const normalized = normalizeNonVotingReasonRecord({
    ...wellFormedRow,
    is_active: badValue,
  });
  assert(
    normalized.isActive === false,
    `is_active=${JSON.stringify(badValue)} normalizes to false (fail-safe, never guessed at as active)`,
  );
}

// ---- sort_order: only a finite number survives, everything else sinks to -
// the end (Number.MAX_SAFE_INTEGER), never crashes a sort or jumps to top --
for (const badValue of [null, undefined, "2", NaN, Infinity] as const) {
  const normalized = normalizeNonVotingReasonRecord({
    ...wellFormedRow,
    sort_order: badValue,
  });
  assert(
    normalized.sortOrder === Number.MAX_SAFE_INTEGER,
    `sort_order=${JSON.stringify(badValue)} normalizes to Number.MAX_SAFE_INTEGER (sinks to the end, never crashes)`,
  );
}

// ---- id/name/description are safely coerced, never thrown on -----------
const weirdShapeRow = {
  id: 12345, // not a string - should never happen per the RPC's uuid column, but never trusted blindly
  name: null,
  description: undefined,
  is_active: "yes",
  sort_order: "3",
};
const normalizedWeird = normalizeNonVotingReasonRecord(weirdShapeRow as never);
assert(
  typeof normalizedWeird.id === "string",
  "a non-string id is coerced to a string, never thrown on",
);
assert(normalizedWeird.name === "", "a non-string name safely normalizes to an empty string");
assert(
  normalizedWeird.description === "",
  "a non-string description safely normalizes to an empty string",
);
assert(normalizedWeird.isActive === false, "a non-boolean is_active fails safe to false");
assert(
  normalizedWeird.sortOrder === Number.MAX_SAFE_INTEGER,
  "a non-number sort_order sinks to the end",
);

// ---- a completely empty row still yields a usable, safe record ---------
const emptyRow = normalizeNonVotingReasonRecord({} as RawNonVotingReasonRow);
assert(emptyRow.id === "", "an empty row's id defaults to an empty string, not a throw");
assert(emptyRow.isActive === false, "an empty row's is_active defaults to false");
assert(
  emptyRow.sortOrder === Number.MAX_SAFE_INTEGER,
  "an empty row's sort_order sinks to the end",
);

if (process.exitCode) {
  console.error("\nsmoke-non-voting-reason-normalization: FAILED");
} else {
  console.log("\nsmoke-non-voting-reason-normalization: all checks passed");
}
