/** M0 smoke test - run via: npx esbuild scripts/smoke-m0.ts --bundle --format=cjs --outfile=scripts/smoke-m0.cjs && node scripts/smoke-m0.cjs */
import { generateDataset } from "../src/data/generator";
import { isValidIsraeliId } from "../src/lib/israeliId";
import { getRank } from "../src/lib/ranks";

const d = generateDataset();
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

assert(d.voters.length === 5000, `5000 voters (got ${d.voters.length})`);
assert(d.activists.length === 25, `25 activists (got ${d.activists.length})`);
assert(d.stations.length > 0, `${d.stations.length} polling stations`);
assert(
  d.voters.every((v) => isValidIsraeliId(v.nationalId)),
  "all national IDs pass checksum",
);
assert(
  new Set(d.voters.map((v) => v.nationalId)).size >= 4950,
  "national IDs are (nearly) unique",
);

const classified = d.voters.filter((v) => v.classification !== "unclassified");
assert(
  classified.length > 1500 && classified.length < 2000,
  `~35% classified (got ${classified.length})`,
);
assert(d.events.length === classified.length, "one event per classified voter");
assert(
  d.activists.reduce((s, a) => s + a.tagCount, 0) === d.events.length,
  "activist tagCounts sum to event count",
);

const top = [...d.activists].sort((a, b) => b.tagCount - a.tagCount)[0];
console.log(
  `top activist: ${top.firstName} ${top.lastName} - ${top.tagCount} tags, rank ${getRank(top.tagCount)}`,
);
const byC = { supporter: 0, potential: 0, opponent: 0 };
for (const v of classified) byC[v.classification as keyof typeof byC]++;
console.log("distribution:", byC);

// determinism
const d2 = generateDataset();
assert(
  JSON.stringify(d2.voters[1234]) === JSON.stringify(d.voters[1234]),
  "generator is deterministic (same seed → same data)",
);
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
