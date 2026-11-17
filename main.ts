// HORIZON — a token launch radar for make.fun's token-radar-01 bounty.
//
// Node 22, standard library only, no network. The program reads the sealed snapshot
// (/input/snapshot.json by default, or --input <file|dir>), scores every pre-token protocol with
// horizon-1 in lib/model.ts, and writes a 200-row board to /output/board.json. It writes the page's
// dataset to /output/data.js, copies dashboard/ and screenshots/ into /output, and finally writes
// /output/dossier.json with the house's buildDossier so the gate can rebuild those bytes exactly.
//
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';
import type { Snapshot } from './lib/model.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// The scorer's reference caps. Only text_max_bytes shapes the dossier; the rest just refuse.
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read --name <value> or --name=<value> from argv, else a fallback. */
function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const joined = process.argv.find((a) => a.startsWith(`${flag}=`));
  return joined === undefined ? fallback : joined.slice(flag.length + 1);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`horizon: no snapshot at ${inputFile}; pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot: Snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`horizon: the model produced a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy a directory's plain files into `to`, skipping dot-names and subdirectories. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const page = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));

if (page.length < 3) {
  process.stderr.write(`horizon: dashboard/ holds ${page.length} files; index.html, a .css and a .js are required\n`);
  process.exit(1);
}
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`horizon: screenshots/ holds ${shots.length} images; hand in three (board, detail, filtered)\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`horizon: screenshots/${name} is not a dossier-legal file name\n`);
    process.exit(1);
  }
}

// Written last: the scorer rebuilds this from /output and compares bytes.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

process.stdout.write(
  `horizon: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} board rows ` +
    `(${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `horizon: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, dashboard/ (${page.length} files), ` +
    `screenshots/ (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
