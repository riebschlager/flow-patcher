// PreToolUse (Edit|Write): golden/ and vendor/ are never edited by hand, and the
// Flow repo next door is read-only. Golden files change only through
// `pnpm golden:update`; vendor files are copied in verbatim with their notices.
// A human can lift the block for one session: FP_ALLOW_PROTECTED=golden,vendor claude
//
// Paths are checked from the git worktree the file belongs to, so the agents'
// worktrees under .claude/worktrees/ are guarded too. When git can't answer,
// the hook falls back to the project dir and still treats .claude/worktrees/<name>/
// as a root: it fails closed, never open.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// A crash would let the edit through (a non-zero exit other than 2 doesn't block), so block instead.
process.on('uncaughtException', (error) => {
  process.stderr.write(`protect-paths: ${error.message}; blocking the edit to be safe.\n`);
  process.exit(2);
});

const input = JSON.parse(readFileSync(0, 'utf8'));
const project = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!file) process.exit(0);

const allowed = new Set((process.env.FP_ALLOW_PROTECTED ?? '').split(',').map((s) => s.trim()));

// Inherited GIT_* variables (a git hook, an exported GIT_DIR) would make git ignore cwd.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** The real path, in the filesystem's own letter case (macOS ignores case, so VENDOR/x lands in vendor/),
 *  through symlinks. A path that doesn't exist yet is resolved from its nearest existing ancestor. */
function real(path) {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  try {
    return resolve(realpathSync.native(dir), relative(dir, path));
  } catch {
    return path;
  }
}

const isDirectory = (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

const below = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : null;
};

const path = real(resolve(project, file));
const projectReal = real(resolve(project));
// git is asked from the nearest existing directory: a new file's directory may not exist yet.
let startDir = path;
while (!isDirectory(startDir) && dirname(startDir) !== startDir) startDir = dirname(startDir);

// The file's own worktree, then the project's .claude/worktrees/<name>/ as a backstop.
const top = git(startDir, 'rev-parse', '--show-toplevel');
const roots = [top && real(top), projectReal].filter(Boolean);
const rels = roots.map((root) => below(root, path)).filter((rel) => rel !== null);
const inProject = below(projectReal, path);
const worktree = inProject?.match(/^\.claude\/worktrees\/[^/]+\/(.*)$/);
if (worktree) rels.push(worktree[1]);

// ../flow sits beside the main checkout, which a worktree session finds through git's common dir.
const common = git(projectReal, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const main = common ? real(dirname(common)) : projectReal;
const flows = [...new Set([main, projectReal].map((root) => real(resolve(root, '..', 'flow'))))];

let reason = null;
if (flows.some((flow) => path === flow || below(flow, path) !== null)) {
  reason = '../flow is the Flow repo and is read-only. Copy what you need into this repo instead.';
} else if (rels.some((rel) => rel.startsWith('golden/')) && !allowed.has('golden')) {
  reason = 'golden/ is never edited by hand. If the output is meant to change, run `pnpm golden:update` and say why in the PR.';
} else if (rels.some((rel) => rel.startsWith('vendor/')) && !allowed.has('vendor')) {
  reason = 'vendor/ holds third-party files copied verbatim with their notices. Don\'t edit them; wrap or adapt them outside vendor/.';
}
if (!reason) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
}));
