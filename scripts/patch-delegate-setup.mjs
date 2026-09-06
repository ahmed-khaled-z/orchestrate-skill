#!/usr/bin/env node
// Adds optional `roles` metadata to delegate-setup lanes (backward-compatible).
// Idempotent: prints "already applied" when nothing is left to do.
// Usage: node scripts/patch-delegate-setup.mjs [<delegate-setup-dir>]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] || [join(homedir(), ".agents/skills/delegate-setup"), join(homedir(), ".claude/skills/delegate-setup")].find((d) => existsSync(join(d, "scripts/config.mjs")));
if (!dir || !existsSync(join(dir, "scripts/config.mjs"))) { console.error("delegate-setup not found; install it first (npx skills add amElnagdy/delegate-skills)"); process.exit(2); }

const edits = [
  {
    file: "scripts/config.mjs",
    from: `  const impl = IMPLEMENTER_BY_KEY[lane.implementer];
  for (const field of Object.keys(lane)) {
    if (field === "implementer") continue;
`,
    to: `  const impl = IMPLEMENTER_BY_KEY[lane.implementer];
  if (lane.roles !== undefined) {
    // Optional routing metadata (what kind of work the lane is for). Not a dial:
    // lane.mjs strips it before dials reach a relay.
    if (
      !Array.isArray(lane.roles) ||
      lane.roles.length === 0 ||
      !lane.roles.every((r) => typeof r === "string" && LANE_NAME.test(r))
    ) {
      return \`\${label}: lane \${name}.roles must be a non-empty array of tokens like ["feature", "ui"]\`;
    }
  }
  for (const field of Object.keys(lane)) {
    if (field === "implementer" || field === "roles") continue;
`,
    marker: 'field === "roles"',
  },
  {
    file: "scripts/lane.mjs",
    from: "  const { source, implementer, ...rest } = entry;\n",
    to: "  // `roles` is routing metadata for orchestrators, never a relay dial.\n  const { source, implementer, roles: _roles, ...rest } = entry;\n",
    marker: "roles: _roles",
  },
  {
    file: "references/schema.md",
    from: "- Other fields are dials; only dials listed for that implementer are allowed.\n",
    to: `- Other fields are dials; only dials listed for that implementer are allowed.
- \`roles\` (optional) is a non-empty array of tokens naming the work the lane is for, e.g.
  \`["feature", "quick"]\`, \`["ui"]\`, \`["review"]\`. It is routing metadata for orchestrators
  (\`lane.mjs\` strips it before dials reach a relay). Suggested vocabulary: \`quick\`, \`feature\`, \`ui\`,
  \`debug\`, \`tests\`, \`docs\`, \`plan\`, \`review\`. Lanes without \`roles\` are routed by their name.
`,
    marker: "`roles` (optional)",
  },
  // agy: optional boolean dial `skipPermissions` (headless print mode cannot prompt for writes).
  {
    file: "scripts/implementers.mjs",
    from: `      match: /\\.db$/,
    },
    supports: ["model", "timeout"],
    winShell: false,
  },`,
    to: `      match: /\\.db$/,
    },
    // skipPermissions: headless print mode cannot prompt; see lane.mjs for the relay mapping.
    supports: ["model", "timeout", "skipPermissions"],
    winShell: false,
  },`,
    marker: '"timeout", "skipPermissions"',
  },
  {
    file: "scripts/implementers.mjs",
    from: `  "force",
  "provider",
]);`,
    to: `  "force",
  "provider",
  "skipPermissions",
]);`,
    marker: '  "skipPermissions",\n]);',
  },
  {
    file: "scripts/config.mjs",
    from: `    if (field === "readOnly" || field === "force") {`,
    to: `    if (field === "readOnly" || field === "force" || field === "skipPermissions") {`,
    marker: 'field === "skipPermissions"',
  },
  {
    file: "scripts/lane.mjs",
    from: `  // claude / cursor / pi keep readOnly as a boolean on opts
  return dials;`,
    to: `  if (implementerKey === "agy" && dials.skipPermissions !== undefined) {
    // agy relay opts field for its permission-bypass flag
    dials.dangerouslySkipPermissions = dials.skipPermissions === true;
    delete dials.skipPermissions;
  }
  // claude / cursor / pi keep readOnly as a boolean on opts
  return dials;`,
    marker: "dials.skipPermissions",
  },
  {
    file: "references/schema.md",
    from: "| `agy` | agy-delegate | `agy` | model, timeout |",
    to: "| `agy` | agy-delegate | `agy` | model, timeout, skipPermissions |",
    marker: "model, timeout, skipPermissions",
  },
  {
    file: "references/schema.md",
    from: "Boolean dials: `readOnly`, `force`. All other dials are non-empty strings.",
    to: `Boolean dials: \`readOnly\`, \`force\`, \`skipPermissions\` (agy only: headless print mode cannot prompt,
so \`true\` lets the relay auto-approve tool requests; treat such runs as full access). All other
dials are non-empty strings.`,
    marker: "`force`, `skipPermissions`",
  },
];

let changed = 0;
for (const e of edits) {
  const p = join(dir, e.file);
  const s = readFileSync(p, "utf8");
  if (s.includes(e.marker)) continue;
  if (!s.includes(e.from)) { console.error(`cannot patch ${e.file}: expected text not found (delegate-setup version changed?)`); process.exit(1); }
  writeFileSync(p, s.replace(e.from, e.to));
  changed++;
  console.log(`patched ${e.file}`);
}
console.log(changed ? `done (${dir})` : `already applied (${dir})`);
