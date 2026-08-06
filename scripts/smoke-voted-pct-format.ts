/** Voting-turnout percentage display formatting - smoke test. Run via: npx esbuild scripts/smoke-voted-pct-format.ts --bundle --format=cjs --outfile=scripts/smoke-voted-pct-format.cjs && node scripts/smoke-voted-pct-format.cjs
 *
 * Pins `fmtVotedPct` (src/lib/utils.ts) against the exact product-spec
 * examples: below 10% shows one decimal, 10%+ shows a whole number, and the
 * true-zero case always shows a plain "0%" rather than "0.0%".
 */
import { fmtVotedPct } from "../src/lib/utils";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// ---- the real bug report's numbers: 8/1928 = 0.4149...% -------------------
assert(
  fmtVotedPct((8 / 1928) * 100) === "0.4%",
  "8/1928 renders as 0.4%, not 0% (the reported bug)",
);

// ---- below 10%: one decimal digit ------------------------------------------
assert(fmtVotedPct(0.1) === "0.1%", "0.1 -> 0.1%");
assert(fmtVotedPct(0.4) === "0.4%", "0.4 -> 0.4%");
assert(fmtVotedPct(1.7) === "1.7%", "1.7 -> 1.7%");
assert(fmtVotedPct(9.8) === "9.8%", "9.8 -> 9.8%");
assert(fmtVotedPct(9.96) === "10.0%", "9.96 rounds to 10.0% at one decimal (still under-10 branch)");

// ---- 10% and above: whole number -------------------------------------------
assert(fmtVotedPct(10) === "10%", "10 -> 10%");
assert(fmtVotedPct(18) === "18%", "18 -> 18%");
assert(fmtVotedPct(42) === "42%", "42 -> 42%");
assert(fmtVotedPct(76) === "76%", "76 -> 76%");
assert(fmtVotedPct(100) === "100%", "100 -> 100%");

// ---- true zero: plain "0%", never "0.0%" -----------------------------------
assert(fmtVotedPct(0) === "0%", "0 -> 0% (not 0.0%)");

if (process.exitCode) {
  console.error("\nsmoke-voted-pct-format: FAILED");
} else {
  console.log("\nsmoke-voted-pct-format: all checks passed");
}
