import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../test-support/golden';

const HOOK = join(ROOT, '.claude/hooks/protect-paths.mjs');

/** The environment less anything git would follow instead of cwd or the test's own settings. */
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'FP_ALLOW_PROTECTED'));
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
};

/** The hook's decision for an Edit of `file`: 'deny' or 'allow'. */
function decide(project: string, file: string, env: NodeJS.ProcessEnv = {}): 'deny' | 'allow' {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } }),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: project, ...env },
    encoding: 'utf8',
  });
  return out ? (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: 'deny' } }).hookSpecificOutput.permissionDecision : 'allow';
}

describe('protect-paths hook', () => {
  // A main checkout with a worktree under .claude/worktrees/, like the agents' worktrees, and a Flow checkout beside it.
  let dir: string, main: string, worktree: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'protect-paths-'));
    main = join(dir, 'flow-patcher');
    worktree = join(main, '.claude/worktrees/wt');
    mkdirSync(join(dir, 'flow'));
    mkdirSync(join(dir, 'elsewhere'));
    mkdirSync(main);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: main, env: cleanEnv(), stdio: 'ignore' });
    git('init', '-q');
    for (const sub of ['vendor', 'golden', 'src']) {
      mkdirSync(join(main, sub));
      writeFileSync(join(main, sub, 'x'), '');
    }
    symlinkSync('../vendor/x', join(main, 'src/link'));
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'init');
    git('worktree', 'add', '-q', worktree);
    // A repository nested in vendor/ must not make its files look like they're at a root.
    mkdirSync(join(main, 'vendor/nested'));
    execFileSync('git', ['init', '-q'], { cwd: join(main, 'vendor/nested'), env: cleanEnv(), stdio: 'ignore' });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('denies vendor/ and golden/ in the main checkout, by absolute or relative path', () => {
    expect(decide(main, join(main, 'vendor/x'))).toBe('deny');
    expect(decide(main, 'golden/x')).toBe('deny');
    expect(decide(main, join(main, 'src/x'))).toBe('allow');
  });

  it("denies a worktree's own vendor/ and golden/, new files in new directories included", () => {
    expect(decide(main, join(worktree, 'vendor/x'))).toBe('deny');
    expect(decide(main, join(worktree, 'golden/x'))).toBe('deny');
    expect(decide(main, join(worktree, 'vendor/new/dir/file.txt'))).toBe('deny');
    expect(decide(main, join(worktree, 'src/x'))).toBe('allow');
  });

  it('allows them when FP_ALLOW_PROTECTED names them', () => {
    expect(decide(main, join(worktree, 'vendor/x'), { FP_ALLOW_PROTECTED: 'vendor' })).toBe('allow');
    expect(decide(main, join(worktree, 'golden/x'), { FP_ALLOW_PROTECTED: 'vendor' })).toBe('deny');
    expect(decide(main, join(worktree, 'golden/x'), { FP_ALLOW_PROTECTED: 'golden,vendor' })).toBe('allow');
  });

  it("still denies a worktree's vendor/ when git can't answer or follows an inherited GIT_DIR", () => {
    expect(decide(main, join(worktree, 'vendor/x'), { PATH: '/nonexistent' })).toBe('deny');
    expect(decide(main, join(worktree, 'vendor/x'), { GIT_DIR: join(main, '.git') })).toBe('deny');
  });

  it('follows symlinked files, and nested repositories stay inside vendor/', () => {
    expect(decide(main, join(main, 'src/link'))).toBe('deny');
    expect(decide(main, join(main, 'vendor/nested/x'))).toBe('deny');
  });

  it.runIf(process.platform === 'darwin')('sees through letter case on a case-insensitive filesystem', () => {
    expect(decide(main, join(main, 'VENDOR/x'))).toBe('deny');
    expect(decide(main, join(main, 'Golden/new/x'))).toBe('deny');
  });

  it('allows files outside any repository', () => {
    expect(decide(main, join(dir, 'elsewhere/x'))).toBe('allow');
  });

  it('keeps ../flow read-only, from the main checkout even when the session runs in a worktree', () => {
    expect(decide(main, join(dir, 'flow/x'), { FP_ALLOW_PROTECTED: 'golden,vendor' })).toBe('deny');
    expect(decide(worktree, join(dir, 'flow/x'))).toBe('deny');
  });
});
