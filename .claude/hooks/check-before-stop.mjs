// Stop: when code changed, run `pnpm check` and don't let the agent finish while
// it fails. After three blocked attempts in a row it lets the agent stop and
// tells the user, so a check the agent can't fix never traps the session.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BLOCKS = 3;
const input = JSON.parse(readFileSync(0, 'utf8'));
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const counter = join(tmpdir(), `flow-patcher-stop-${input.session_id ?? 'unknown'}`);

// Only code changes need the check; a docs-only or read-only turn stops freely.
const changed = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.slice(3).trim())
  .filter((path) => path && !path.endsWith('.md'));
if (changed.length === 0) process.exit(0);

const result = spawnSync('pnpm', ['check'], { cwd: root, encoding: 'utf8' });
if (result.status === 0) {
  rmSync(counter, { force: true });
  process.exit(0);
}

const blocks = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) || 0 : 0) + 1;
if (blocks > MAX_BLOCKS) {
  rmSync(counter, { force: true });
  process.stdout.write(JSON.stringify({ systemMessage: `pnpm check is still failing after ${MAX_BLOCKS} attempts; the agent stopped anyway. Run it yourself before merging.` }));
  process.exit(0);
}
writeFileSync(counter, String(blocks));

const lines = `${result.stdout}${result.stderr}`.trim().split('\n');
process.stderr.write(`pnpm check fails (attempt ${blocks} of ${MAX_BLOCKS}). Fix it before finishing, or explain why you can't:\n${lines.slice(-60).join('\n')}\n`);
process.exit(2);
