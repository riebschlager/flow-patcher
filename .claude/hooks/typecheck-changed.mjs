// PostToolUse (Edit|Write): typecheck the project the edited file belongs to and
// hand the errors back to the agent. Packages typecheck in about a second.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const file = input.tool_input?.file_path;
if (!file || !/\.(ts|tsx)$/.test(file)) process.exit(0);

const rel = relative(root, resolve(root, file)).split(sep).join('/');
const pkg = rel.match(/^packages\/(engine|nodes|editor)\/src\//)?.[1];
// The root tsconfig covers tools, e2e, test-support, package tests and configs.
const rootProject = /^(tools|e2e|test-support)\/|^packages\/[^/]+\/test\/|^[^/]+\.config\.ts$/.test(rel);
const project = pkg ? `packages/${pkg}/tsconfig.json` : rootProject ? 'tsconfig.json' : null;
if (!project) process.exit(0);

const result = spawnSync('pnpm', ['exec', 'tsc', '--noEmit', '-p', project], { cwd: root, encoding: 'utf8' });
if (result.status === 0) process.exit(0);

const lines = `${result.stdout}${result.stderr}`.trim().split('\n');
const shown = lines.slice(0, 40).join('\n');
process.stderr.write(`Typecheck failed for ${project} after editing ${rel}:\n${shown}${lines.length > 40 ? `\n… ${lines.length - 40} more lines` : ''}\n`);
process.exit(2);
