#!/usr/bin/env node
'use strict';
/**
 * figma-code-sync — keep a Figma library and a codebase one design.
 *
 *   init                guided setup: detect the adapter, scaffold, token, Library
 *                       key, generate tokens, snapshot, seed the map, hooks, status.
 *                       Re-run it any time to resume. Flags for non-interactive use:
 *                       --adapter css-tailwind4|swift  --library <url|key>  --product <url|key>
 *                       --seed | --no-seed  --no-token  --no-hooks  --yes  --force
 *   status [--json]     where the project stands (code-first, design-first, in step,
 *                       diverged, in sync) and the next step; exit 1 when diverged
 *   tokens [--check]    regenerate the token file (or exit 1 if it is stale)
 *   check [--json]      offline: tokens, component map and snapshot agree
 *   snapshot [--check [--block]] [--soft] [--message-file F]
 *                       refresh the published-Library snapshot, or gate on drift from it
 *   hooks               point git at the scaffolded hooks (core.hooksPath + executable bit)
 *
 * Config: figma-sync.config.js at the repo root (found by walking up from cwd,
 * stopping at the repository root). Docs: https://github.com/jasonchandesign/figma-code-sync
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { loadConfig } = require('../core/config');

function usage() {
  const src = fs.readFileSync(__filename, 'utf8');
  return src.slice(src.indexOf('/**') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, '');
}

function gitTopLevel() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('not inside a git repository');
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(usage());
    return 0;
  }
  if (cmd === 'init') {
    const setup = require('../core/setup');
    await setup.init({ argv: rest });
    return 0;
  }
  if (cmd === 'hooks') {
    require('../core/setup').enableHooks(gitTopLevel());
    console.log('figma-code-sync: git now runs scripts/githooks/ (pre-commit checks, commit-msg warns)');
    return 0;
  }
  const config = loadConfig();
  const relOut = (p) => path.relative(config.root, p).split(path.sep).join('/');
  if (cmd === 'status') {
    const setup = require('../core/setup');
    const s = setup.status(config);
    if (rest.includes('--json')) {
      const { toJson } = require('../core/check');
      console.log(JSON.stringify({ ...s, ...toJson({ errors: s.errors, warnings: s.warnings }) }, null, 2));
    } else setup.printStatus(s);
    return s.state === 'diverged' ? 1 : 0;
  }
  if (cmd === 'tokens') {
    const tokens = require('../core/tokens');
    if (rest.includes('--check')) {
      const t = tokens.check(config);
      t.errors.forEach((e) => console.error(`error ${e}`));
      if (!t.fresh) console.error(`figma-code-sync tokens: ${relOut(t.out)} is stale — run without --check`);
      return t.fresh && !t.errors.length ? 0 : 1;
    }
    const { out, errors } = tokens.write(config);
    errors.forEach((e) => console.error(`error ${e}`));
    console.log(`figma-code-sync tokens: wrote ${relOut(out)}`);
    return errors.length ? 1 : 0;
  }
  if (cmd === 'check') {
    const check = require('../core/check');
    const result = check.run(config);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(check.toJson(result), null, 2));
      return result.errors.length ? 1 : 0;
    }
    return check.print(result);
  }
  if (cmd === 'snapshot') return require('../core/snapshot').run(config, rest);
  console.error(`figma-code-sync: unknown command ${cmd}\n`);
  console.log(usage());
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`figma-code-sync: ${e.message}`);
      process.exit(2);
    }
  );
}

module.exports = { main, loadConfig };
