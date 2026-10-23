import { execSync } from 'node:child_process';
import { accessSync, readFileSync } from 'node:fs';

/**
 * security-audit.mjs
 *
 * Runs `pnpm audit --json` and fails with a non-zero exit code when any
 * advisory of severity `critical` is present in the workspace dependency graph
 * that is NOT listed in the tracked-criticals allowlist.
 *
 * Tracked criticals are advisories that are known, have a remediation path, and
 * are intentionally not blocking this release (e.g. they live in private,
 * unpublished example workspaces, or in dev tooling coupled to a dependency
 * that cannot be upgraded yet). Any critical advisory NOT in the allowlist
 * fails the run so that regressions are caught immediately.
 *
 * Moderate/high/low findings are always reported but never fail the run.
 *
 * Usage: node scripts/security-audit.mjs
 */

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const ALLOWLIST_PATH = new URL('../security-audit.allowlist.json', import.meta.url).pathname;

// Resolve a pnpm binary that can read this repo's pnpm 10 lockfile. In CI,
// `pnpm/action-setup@v4` (version 10) puts pnpm 10 on `PATH`; locally and after
// any workspace install, `node_modules/.bin/pnpm` is pnpm 10 as well.
function resolvePnpm() {
  const local = new URL('../node_modules/.bin/pnpm', import.meta.url).pathname;
  try {
    accessSync(local);
    return local;
  } catch {
    return 'pnpm';
  }
}

const PNPM = resolvePnpm();

// `pnpm audit` exits non-zero whenever *any* advisory exists, so we capture its
// JSON output regardless of exit code and evaluate only critical findings here.
let auditJson;
try {
  execSync(`${PNPM} audit --json`, {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
} catch (err) {
  const stderr = err.stderr ? err.stderr.toString() : '';
  const stdout = err.stdout ? err.stdout.toString() : '';
  const candidate = stdout || stderr;
  try {
    auditJson = JSON.parse(candidate);
  } catch {
    process.stderr.write(
      `security-audit: pnpm audit failed and produced no parseable JSON:\n${candidate.slice(0, 2000)}\n`,
    );
    process.exit(2);
  }
}

if (!auditJson || !auditJson.advisories) {
  console.log('security-audit: no advisories returned by pnpm audit.');
  process.exit(0);
}

let allowlist = [];
try {
  allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')).entries || [];
} catch {
  // No allowlist file: every critical is unapproved.
  allowlist = [];
}
const allowlistedIds = new Set(allowlist.map((e) => e.id));

const advisories = Object.values(auditJson.advisories);
const bySeverity = {};
for (const a of advisories) {
  bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
}

console.log('security-audit: advisory summary by severity:');
for (const [sev, count] of Object.entries(bySeverity).sort()) {
  console.log(`  ${sev}: ${count}`);
}

const critical = advisories.filter((a) => a.severity === 'critical');
const unapproved = critical.filter((a) => !allowlistedIds.has(ghsaId(a)));

if (critical.length) {
  console.log(`\nsecurity-audit: ${critical.length} critical advisory(ies) detected.`);
  for (const a of critical) {
    const tracked = allowlistedIds.has(ghsaId(a));
    const paths = (a.findings || []).map((f) => f.paths?.[0] ?? '(unknown path)').join(', ');
    const marker = tracked ? '[tracked]' : '[UNTRACKED]';
    console.error(
      `  ${marker} ${ghsaId(a)} ${a.title} (module: ${a.module_name}, ` +
        `installed: ${a.findings?.[0]?.version ?? '?'}, patched: ${a.patched_versions})\n` +
        `    path: ${paths}`,
    );
  }
}

if (unapproved.length) {
  console.error(
    `\nsecurity-audit: FAILED — ${unapproved.length} unapproved critical advisory(ies):`,
  );
  for (const a of unapproved) {
    console.error(`  - ${ghsaId(a)} ${a.title}`);
  }
  console.error(
    'Upgrade or replace the affected dependency paths where patched versions exist, or add the advisory to security-audit.allowlist.json with a remediation plan, then re-run `pnpm audit:ci`.',
  );
  process.exit(1);
}

if (critical.length) {
  console.log(
    '\nsecurity-audit: OK — all critical advisories are tracked in the allowlist with remediation plans.',
  );
} else {
  console.log('\nsecurity-audit: OK — no critical advisories in the workspace graph.');
}

function ghsaId(a) {
  const id = a.github_advisory_id || a.id || '';
  return id.startsWith('GHSA-') ? id : `GHSA-${id}`;
}
