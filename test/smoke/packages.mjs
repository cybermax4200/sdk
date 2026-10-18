// Smoke-tests every companion workspace package as an independently
// publishable tarball.
//
// For each package it:
//   1. Builds the package (tsup) so dist/ is fresh.
//   2. Runs `pnpm pack --dry-run --json` and verifies the published file list:
//      every packed path is covered by `files`, nothing on the deny list is
//      shipped, and every documented entry-point target is present.
//   3. Unpacks a real tarball into a clean fixture's node_modules (the same
//      layout a consumer gets after `npm install`), installing only the
//      package's third-party (non-`@wraith-protocol/*`) dependencies from npm
//      so framework entry points can load.
//   4. Verifies ESM imports of every entry point from the installed package.
//   5. Verifies TypeScript declarations resolve when each entry point is
//      imported by its package specifier.
//   6. Verifies documented exports (the exports-map targets exist on disk).
//
// A package FAILS if any of its workspace-only imports (e.g.
// `@wraith-protocol/sdk: workspace:*`) cannot resolve from npm in the clean
// fixture — that is the signal that the package is not yet independently
// publishable. Because the fixture never installs `@wraith-protocol/*`
// workspace packages, those imports surface as "cannot find module" errors.
//
// Run with:
//
//   pnpm test:packages

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const require = createRequire(import.meta.url);

// Metadata npm and pnpm include whether or not `files` mentions it.
const ALWAYS_INCLUDED = [
  /^package\.json$/i,
  /^(readme|license|licence|notice|copying|authors|changelog|changes|history)(\.[^/]*)?$/i,
];

// Path patterns that must never reach the registry, with the reason to report.
const NEVER_PUBLISH = [
  [/(^|\/)node_modules(\/|$)/, 'dependency tree'],
  [/(^|\/)(test|tests|__tests__)(\/|$)/, 'tests'],
  [/(^|\/)src(\/|$)/, 'TypeScript sources'],
  [/(^|\/)(scripts|examples|docs|audits|packages)(\/|$)/, 'repository-only files'],
  [/(^|\/)\.github(\/|$)/, 'GitHub configuration'],
  [/(^|\/)(coverage|tmp|temp|\.cache)(\/|$)/, 'build or test leftovers'],
  [/\.map$/, 'source maps'],
  [/(^|\/)\.[^/]/, 'dotfiles that can carry local configuration'],
  [/(^|\/)(\.env[^/]*|[^/]*\.(pem|key|p12|pfx|tgz))$/, 'secrets or packaged artifacts'],
];

// Every companion workspace package published independently of the core SDK.
// Kept in sync with pnpm-workspace.yaml (`packages/*`).
const PACKAGES = [
  { name: '@wraith-protocol/sdk-agent', dir: 'packages/sdk-agent' },
  { name: '@wraith-protocol/sdk-react', dir: 'packages/sdk-react' },
  { name: '@wraith-protocol/sdk-vue', dir: 'packages/sdk-vue' },
  { name: '@wraith-protocol/sdk-solid', dir: 'packages/sdk-solid' },
  { name: '@wraith-protocol/sdk-svelte', dir: 'packages/sdk-svelte' },
  { name: '@wraith-protocol/codemod', dir: 'packages/codemod' },
  { name: '@wraith-protocol/test-vectors', dir: 'packages/test-vectors' },
];

let failed = 0;
const results = [];

function spawn(command, args, opts = {}) {
  try {
    const result = execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout: String(result), stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message),
    };
  }
}

function globToRegExp(pattern) {
  let source = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches this directory and everything beneath it; a trailing
        // `**` matches anything beneath it.
        if (pattern[i + 2] === '/') {
          source += '(?:/.*)?';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      source += '[^/]';
      i += 1;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function allowPatterns(pkgDir, files) {
  const allow = [];
  const deny = [];
  for (const entry of Array.isArray(files) ? files : []) {
    const raw = String(entry).trim();
    if (!raw) continue;
    const negated = raw.startsWith('!');
    const target = (negated ? raw.slice(1) : raw).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!target) continue;
    const absolute = join(pkgDir, target);
    const directory = existsSync(absolute) && statSync(absolute).isDirectory();
    (negated ? deny : allow).push(globToRegExp(directory ? `${target}/**` : target));
  }
  return { allow, deny };
}

/** Every path the package's entry points point at (exports + main/module/types/bin). */
function entryPointTargets(pkgJson) {
  const targets = new Set();
  const visit = (value) => {
    if (typeof value === 'string') {
      if (!value.includes('*')) targets.add(value.replace(/^\.\//, '').replace(/^\//, ''));
      return;
    }
    if (value && typeof value === 'object')
      for (const nested of Object.values(value)) visit(nested);
  };
  if (pkgJson.exports && typeof pkgJson.exports === 'object') visit(pkgJson.exports);
  for (const field of ['main', 'module', 'types', 'typings', 'browser', 'bin'])
    visit(pkgJson[field]);
  return targets;
}

function entrypointsOf(pkgJson) {
  const entrypoints = [];
  const add = (subpath, conditions) => {
    const clean = subpath === '.' ? '' : subpath.replace(/^\.\//, '');
    const specifier = clean ? `${pkgJson.name}/${clean}` : pkgJson.name;
    entrypoints.push({
      subpath,
      specifier,
      typesRel: conditions.types ?? null,
      importRel: conditions.import ?? null,
      requireRel: conditions.require ?? null,
    });
  };
  if (pkgJson.exports && typeof pkgJson.exports === 'object') {
    for (const [subpath, conditions] of Object.entries(pkgJson.exports)) add(subpath, conditions);
  } else {
    add('.', {
      types: (pkgJson.types || pkgJson.typings) ?? null,
      import: (pkgJson.module || pkgJson.main) ?? null,
      require: pkgJson.main ?? null,
    });
  }
  return entrypoints;
}

function readPkgJson(pkgDir) {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
}

function dryRunPack(pkgDir) {
  const result = spawn('pnpm', ['pack', '--dry-run', '--json'], { cwd: pkgDir });
  if (!result.ok) {
    return {
      error: `pnpm pack --dry-run --json failed: ${(result.stderr || result.stdout).trim().split('\n')[0]}`,
    };
  }
  const stdout = result.stdout;
  const start = stdout.indexOf('{');
  if (start === -1) return { error: 'pnpm pack --dry-run --json printed no JSON' };
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (err) {
    return { error: `could not parse pnpm pack output: ${err.message}` };
  }
  if (!Array.isArray(parsed.files)) return { error: 'pnpm pack JSON has no files array' };
  return { packed: parsed.files };
}

function packTarball(pkgDir, dest) {
  const result = spawn('pnpm', ['pack', '--pack-destination', dest], { cwd: pkgDir });
  if (!result.ok) {
    return { error: `pnpm pack failed: ${(result.stderr || result.stdout).trim().split('\n')[0]}` };
  }
  let tarball;
  try {
    for (const entry of require('fs').readdirSync(dest)) {
      if (entry.endsWith('.tgz')) tarball = join(dest, entry);
    }
  } catch {
    /* no tarball */
  }
  if (!tarball) return { error: `could not locate packed tarball in ${dest}` };
  return { tarball };
}

function checkFileList(pkgDir, pkgJson, packed) {
  const problems = [];
  const packedPaths = new Set(packed.map((f) => String(f.path ?? f.name)));

  console.log(`  tarball contents (${packed.length} files):`);
  for (const file of packed) console.log(`    ${String(file.path ?? file.name)}`);

  const { allow, deny } = allowPatterns(pkgDir, pkgJson.files);
  const isAllowed = (path) =>
    allow.some((pattern) => pattern.test(path)) && !deny.some((pattern) => pattern.test(path));
  const isAlwaysIncluded = (path) => ALWAYS_INCLUDED.some((pattern) => pattern.test(path));

  const forbidden = [];
  const unexpected = [];
  for (const file of packed) {
    const path = String(file.path ?? file.name);
    const never = NEVER_PUBLISH.find(([pattern]) => pattern.test(path));
    if (never) forbidden.push(`${path} (${never[1]})`);
    else if (!isAlwaysIncluded(path) && !isAllowed(path)) unexpected.push(path);
  }

  if (forbidden.length > 0) {
    problems.push(`denied files in tarball: ${forbidden.slice(0, 20).join(', ')}`);
  }
  if (allow.length === 0) {
    console.log(`  warn: package.json has no \`files\` field`);
  } else if (unexpected.length > 0) {
    problems.push(`files not covered by \`files\` field: ${unexpected.slice(0, 20).join(', ')}`);
  }

  const missing = [...entryPointTargets(pkgJson)].filter((t) => !packedPaths.has(t));
  if (missing.length > 0)
    problems.push(`entry-point target missing from tarball: ${missing.join(', ')}`);

  return problems;
}

function scopeDir(fixture, packageName) {
  return join(fixture, 'node_modules', ...packageName.split('/'));
}

function unpackTarball(tarball, fixture, packageName) {
  const target = scopeDir(fixture, packageName);
  mkdirSync(target, { recursive: true });
  const result = spawn('tar', ['-xzf', tarball, '--strip-components=1', '-C', target]);
  if (!result.ok) {
    return {
      error: `tar extract failed: ${(result.stderr || result.stdout).trim().split('\n')[0]}`,
    };
  }
  return { target };
}

function installThirdPartyDeps(fixture, pkgJson) {
  const deps = new Set();
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pkgJson[field] || {})) {
      if (dep.startsWith('@wraith-protocol/')) continue;
      deps.add(dep);
    }
  }
  const depList = [...deps];
  if (depList.length === 0) return { ok: true };
  // Install third-party deps from npm. `@wraith-protocol/*` workspace deps are
  // deliberately absent — their absence is the "workspace-only import cannot
  // resolve from npm" signal under test.
  const result = spawn('pnpm', ['install', ...depList], { cwd: fixture });
  if (!result.ok) {
    return {
      ok: false,
      error: `pnpm install third-party deps failed:\n${(result.stderr || result.stdout).trim().slice(0, 1200)}`,
    };
  }
  return { ok: true };
}

async function esmImportsOk(fixture, entrypoints) {
  const failures = [];
  const checks = entrypoints.map(
    (ep, i) =>
      `try { const ns${i} = await import('${ep.specifier}'); console.log('OK-${i} ' + Object.keys(ns${i}).join(',')); } catch (err) { console.log('ERR-${i} ' + String(err).split('\\n')[0]); }`,
  );
  const script = `${checks.join('\n')}\n`;
  const scriptPath = join(fixture, 'check-esm.mjs');
  writeFileSync(scriptPath, script);
  const result = spawn(process.execPath, [scriptPath], { cwd: fixture });
  const lines = (result.stdout + result.stderr).trim().split('\n').filter(Boolean);
  for (let i = 0; i < entrypoints.length; i += 1) {
    const line = lines.find((l) => l.startsWith(`OK-${i} `) || l.startsWith(`ERR-${i} `));
    if (!line) {
      failures.push({ ep: entrypoints[i], error: 'no output from ESM check' });
      continue;
    }
    if (line.startsWith('ERR-')) {
      failures.push({ ep: entrypoints[i], error: line.slice(`ERR-${i} `.length) });
    } else {
      console.log(
        `    ok   esm ${entrypoints[i].subpath} (${line.slice(`OK-${i} `.length)} exports)`,
      );
    }
  }
  return failures;
}

function typesOk(fixture, packageName, entrypoints) {
  const failures = [];
  const tmp = mkdtempSync(join(tmpdir(), 'wraith-pkg-types-'));
  try {
    const toPosix = (p) => p.split(sep).join('/');
    const importLines = entrypoints.map((ep, i) => `import * as ns${i} from '${ep.specifier}';`);
    const useLine = `export const used = [${entrypoints.map((_, i) => `ns${i}`).join(', ')}];`;
    writeFileSync(join(tmp, 'consume.ts'), `${importLines.join('\n')}\n${useLine}\n`);
    const paths = {};
    const root = scopeDir(fixture, packageName);
    for (const ep of entrypoints) {
      const rel = ep.typesRel;
      if (rel && existsSync(resolve(root, rel)))
        paths[ep.specifier] = [toPosix(resolve(root, rel))];
    }
    const tsconfig = {
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'es2020',
        lib: ['es2020', 'dom'],
        noEmit: true,
        strict: false,
        skipLibCheck: true,
        types: [],
        baseUrl: toPosix(fixture),
        paths,
      },
      include: [toPosix(join(tmp, 'consume.ts'))],
    };
    writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
    const result = spawn('pnpm', ['exec', 'tsc', '-p', join(tmp, 'tsconfig.json')], {
      cwd: repoRoot,
    });
    if (!result.ok) {
      const text = (result.stderr || result.stdout).trim();
      for (const ep of entrypoints) failures.push({ ep, error: text.split('\n')[0] });
      console.log(`    types: tsc reported errors:\n${text.slice(0, 1200)}`);
    } else {
      for (const ep of entrypoints) console.log(`    ok   types ${ep.subpath}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return failures;
}

function documentedExportsOk(pkgDir, entrypoints) {
  const failures = [];
  for (const ep of entrypoints) {
    for (const [field, rel] of Object.entries({
      types: ep.typesRel,
      import: ep.importRel,
      require: ep.requireRel,
    })) {
      if (!rel) continue;
      if (!existsSync(resolve(pkgDir, rel)))
        failures.push({ ep, error: `documented ${field} target missing on disk: ${rel}` });
    }
  }
  for (const f of failures) console.log(`    FAIL exports ${f.ep.subpath}: ${f.error}`);
  return failures;
}

function record(name, problems) {
  const status = problems.length === 0 ? 'pass' : 'fail';
  if (status === 'fail') failed += 1;
  results.push({ name, status, problems });
  console.log(
    `  ${status === 'pass' ? 'ok   ' : 'FAIL'} ${name}: ${
      status === 'pass' ? 'all checks passed' : problems.join('; ')
    }`,
  );
}

async function checkPackage(pkg) {
  const pkgDir = resolve(repoRoot, pkg.dir);
  const pkgJson = readPkgJson(pkgDir);
  console.log(`\n=== ${pkg.name} ===`);
  const problems = [];
  const entrypoints = entrypointsOf(pkgJson);

  // 0. Build the package so dist/ reflects current source (skip data-only pkgs).
  if (pkgJson.scripts?.build) {
    const build = spawn('pnpm', ['--filter', pkg.name, 'build'], { cwd: repoRoot });
    if (!build.ok) {
      problems.push(`build failed: ${(build.stderr || build.stdout).trim().split('\n')[0]}`);
      record(pkg.name, problems);
      return;
    }
  }

  // 1. Published file list (dry-run pack).
  const listing = dryRunPack(pkgDir);
  if (listing.error) {
    problems.push(`pack dry run: ${listing.error}`);
    record(pkg.name, problems);
    return;
  }
  problems.push(...checkFileList(pkgDir, pkgJson, listing.packed));

  // 2. Pack a real tarball and place it in a clean fixture.
  const tmp = mkdtempSync(join(tmpdir(), 'wraith-pkg-pack-'));
  const packed = packTarball(pkgDir, tmp);
  if (packed.error) {
    problems.push(`pack: ${packed.error}`);
    rmSync(tmp, { recursive: true, force: true });
    record(pkg.name, problems);
    return;
  }

  const fixture = mkdtempSync(join(tmpdir(), 'wraith-pkg-smoke-'));
  const fixturePkg = join(fixture, 'package.json');
  writeFileSync(
    fixturePkg,
    JSON.stringify({ name: 'wraith-pkg-smoke-fixture', private: true, type: 'module' }, null, 2),
  );

  const deps = installThirdPartyDeps(fixture, pkgJson);
  if (!deps.ok) {
    // Non-fatal: the import check will still surface the missing-module signal.
    console.log(`  note: ${deps.error}`);
  }

  const unpacked = unpackTarball(packed.tarball, fixture, pkgJson.name);
  if (unpacked.error) {
    problems.push(`unpack tarball: ${unpacked.error}`);
    rmSync(tmp, { recursive: true, force: true });
    try {
      rmSync(fixture, { recursive: true, force: true });
    } catch {
      /* fixture already removed or locked */
    }
    record(pkg.name, problems);
    return;
  }

  // Only packages with JS entry points get ESM/types/export checks.
  const hasEntryPoints = entrypoints.some((e) => e.importRel);

  let importFailures = [];
  let typeFailures = [];
  if (hasEntryPoints) {
    // 3. Documented exports exist on disk in the built package.
    problems.push(
      ...documentedExportsOk(pkgDir, entrypoints).map((f) => `exports ${f.ep.subpath}: ${f.error}`),
    );

    // 4. ESM imports from the installed package.
    importFailures = await esmImportsOk(fixture, entrypoints);

    // 5. Type declarations resolve when imported by package specifier.
    typeFailures = typesOk(fixture, pkgJson.name, entrypoints);

    for (const f of importFailures) problems.push(`esm ${f.ep.subpath}: ${f.error}`);
    for (const f of typeFailures) problems.push(`types ${f.ep.subpath}: ${f.error}`);
  } else {
    console.log(`  no JS entry points (data-only package); skipping ESM/types/exports checks`);
  }

  rmSync(tmp, { recursive: true, force: true });
  try {
    rmSync(fixture, { recursive: true, force: true });
  } catch {
    /* fixture already removed or locked */
  }

  record(pkg.name, problems);
}

async function main() {
  for (const pkg of PACKAGES) {
    if (!existsSync(resolve(repoRoot, pkg.dir, 'package.json'))) {
      console.error(`FAIL: package directory missing: ${pkg.dir}`);
      failed += 1;
      continue;
    }
    await checkPackage(pkg);
  }

  console.log(`\nCompanion package smoke tests: ${results.length} packages, ${failed} failed`);
  for (const r of results) {
    console.log(`  ${r.status === 'pass' ? 'ok   ' : 'FAIL'} ${r.name}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
