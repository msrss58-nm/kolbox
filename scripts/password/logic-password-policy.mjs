// KOLBOX PASSWORD POLICY - the pure-logic half.
//
// KOLBOX imposes NO application-level password policy: no minimum length, no
// maximum, no character-class requirement, and nothing is trimmed or
// normalised. The only two refusals left are an EMPTY password and a
// confirmation that does not match EXACTLY. The auth provider is the sole
// authority on what it accepts (its own configuration is
// `minimum_password_length = 6`, `password_requirements = ""`, plus bcrypt's
// hard 72-BYTE ceiling, which is reported when the provider refuses).
//
// This suite bundles the two real validators with esbuild - the same tool the
// handler harness uses - and exercises them directly, so it tests the shipped
// code rather than a copy of its rules. Server-side and end-to-end coverage of
// the same flows lives in the api-*/ui-* suites.
//
// Run: node scripts/password/logic-password-policy.mjs
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { check, section, tally } from "../stage5/lib.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");
const out = mkdtempSync(path.join(tmpdir(), "kb-pwpolicy-"));
const bundle = path.join(out, "policies.mjs");

await build({
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "neutral",
  stdin: {
    contents: [
      'export { validatePlatformOwnerPassword } from "' +
        path
          .join(repo, "src/features/platform-owner/platformOwnerPasswordPolicy.ts")
          .replaceAll("\\", "/") +
        '";',
      'export { validateMultiEntityOwnerPassword } from "' +
        path
          .join(repo, "src/features/multi-entity-owner/multiEntityOwnerPasswordPolicy.ts")
          .replaceAll("\\", "/") +
        '";',
    ].join("\n"),
    resolveDir: repo,
    loader: "ts",
  },
});

const { validatePlatformOwnerPassword: platform, validateMultiEntityOwnerPassword: meo } =
  await import(pathToFileURL(bundle).href);

/** Every validator, so no rule can survive in one realm and not the other. */
const VALIDATORS = [
  ["platform-owner", platform],
  ["multi-entity-owner", meo],
];

// Deliberately awful by the OLD rules: 1 char, no upper, no digit, no symbol,
// Hebrew only, spaces, emoji, and a 200-character passphrase.
const ACCEPTED = [
  ["single character", "a"],
  ["two characters", "ab"],
  ["short digits only", "1234"],
  ["lowercase only, under the old 12-char floor", "abcdef"],
  ["uppercase only", "ABCDEF"],
  ["digits only", "12345678"],
  ["symbols only", "!!!???"],
  ["Hebrew only", "סיסמה"],
  ["one Hebrew letter", "א"],
  ["Hebrew with spaces", "סיסמה שלי כאן"],
  ["English words with spaces", "correct horse battery staple"],
  ["leading and trailing spaces preserved", "  spaced  "],
  ["a single space", " "],
  ["tab and newline inside", "a\tb\nc"],
  ["mixed Hebrew, English, digits, symbols", "סיסמה-Abc123!"],
  ["Unicode astral (emoji)", "🔐🔐"],
  ["combining marks", "é́x"],
  ["RTL mark and zero-width joiner", "a‏b‍c"],
  ["Cyrillic only", "пароль"],
  ["CJK only", "密码密码"],
  ["200 characters", "x".repeat(200)],
  ["over bcrypt's 72 BYTES in Hebrew (the provider, not KOLBOX, may refuse)", "ס".repeat(40)],
];

for (const [realm, validate] of VALIDATORS) {
  section(`${realm}: every password KOLBOX used to refuse is now accepted`);
  for (const [label, pw] of ACCEPTED) {
    const v = validate(pw, pw);
    check(`${realm} accepts ${label}`, v === null, v === null ? "" : `violation=${v}`);
  }

  section(`${realm}: the only two refusals that remain`);
  check(
    `${realm} empty password is refused`,
    validate("", "") === "empty",
    `violation=${validate("", "")}`,
  );
  check(
    `${realm} empty password is refused even when the confirmation differs`,
    validate("", "x") === "empty",
    `violation=${validate("", "x")}`,
  );
  check(
    `${realm} confirmation must match EXACTLY - one character apart`,
    validate("abc", "abd") === "mismatch",
  );
  check(
    `${realm} confirmation must match EXACTLY - case differs`,
    validate("Abc", "abc") === "mismatch",
  );
  check(
    `${realm} confirmation must match EXACTLY - trailing space differs (nothing is trimmed)`,
    validate("abc ", "abc") === "mismatch",
  );
  check(
    `${realm} confirmation must match EXACTLY - leading space differs (nothing is trimmed)`,
    validate(" abc", "abc") === "mismatch",
  );
  check(
    `${realm} confirmation must match EXACTLY - Hebrew one letter apart`,
    validate("סיסמה", "סיסמח") === "mismatch",
  );
  check(
    `${realm} a whitespace-only password is NOT empty and is accepted when confirmed`,
    validate("   ", "   ") === null,
  );

  section(`${realm}: no length or character-class rule can be reached`);
  const violations = new Set();
  for (let n = 1; n <= 200; n++) {
    const v = validate("a".repeat(n), "a".repeat(n));
    if (v !== null) violations.add(`${n}:${v}`);
  }
  check(
    `${realm} lengths 1..200 of a single lowercase letter are all accepted`,
    violations.size === 0,
    violations.size ? [...violations].slice(0, 5).join(",") : "",
  );
  check(
    `${realm} the violation union is exactly {empty, mismatch}`,
    JSON.stringify(
      [
        ...new Set(
          [
            validate("", ""),
            validate("a", "b"),
            ...ACCEPTED.map(([, pw]) => validate(pw, pw)),
          ].filter((v) => v !== null),
        ),
      ].sort(),
    ) === JSON.stringify(["empty", "mismatch"]),
  );
}

rmSync(out, { recursive: true, force: true });
process.exit(tally("PASSWORD POLICY LOGIC") === 0 ? 0 : 1);
