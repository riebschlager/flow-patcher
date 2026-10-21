// PreToolUse (Edit|Write): golden/ and vendor/ are never edited by hand, and the
// Flow repo next door is read-only. Golden files change only through
// `pnpm golden:update`; vendor files are copied in verbatim with their notices.
// A human can lift the block for one session: FP_ALLOW_PROTECTED=golden,vendor claude
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!file) process.exit(0);

const path = resolve(root, file);
const allowed = new Set((process.env.FP_ALLOW_PROTECTED ?? '').split(',').map((s) => s.trim()));
const flow = resolve(root, '..', 'flow');
const rel = relative(root, path).split(sep).join('/');

let reason = null;
if (path === flow || path.startsWith(flow + sep)) {
  reason = '../flow is the Flow repo and is read-only. Copy what you need into this repo instead.';
} else if (rel.startsWith('golden/') && !allowed.has('golden')) {
  reason = 'golden/ is never edited by hand. If the output is meant to change, run `pnpm golden:update` and say why in the PR.';
} else if (rel.startsWith('vendor/') && !allowed.has('vendor')) {
  reason = 'vendor/ holds third-party files copied verbatim with their notices. Don\'t edit them; wrap or adapt them outside vendor/.';
}
if (!reason) process.exit(0);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
}));
