// ARCHITECTURE A§16.3 is the one source of the agent deny list in
// `.claude/settings.json`. A change to that list there changes REQUIRED here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Settings = { permissions: { deny: string[]; allow: string[] } };

const settings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8')) as Settings;
const { deny, allow } = settings.permissions;

const REQUIRED: Record<string, string[]> = {
  'secret and key reads': [
    'Read(**/.env*)',
    'Read(**/secrets/**)',
    'Read(**/*.secret)',
    'Read(//etc/mjk/secrets/**)',
    'Read(//etc/rws/secrets/**)',
    'Read(//etc/f1/secrets/**)',
    'Read(**/*.pem)',
    'Read(**/*.key)',
    'Read(**/.npmrc)',
    'Read(~/.ssh/**)',
    'Read(~/.config/gh/**)',
  ],
  'GitHub MCP tools that merge or write commits': [
    'mcp__github__merge_pull_request',
    'mcp__github__enable_pr_auto_merge',
    'mcp__github__push_files',
    'mcp__github__create_or_update_file',
    'mcp__github__delete_file',
  ],
  'force, mirror and delete pushes': [
    'Bash(git push -f*)',
    'Bash(git push * -f*)',
    'Bash(git push -uf*)',
    'Bash(git push * -uf*)',
    'Bash(git push --force*)',
    'Bash(git push * --force*)',
    'Bash(git push +*)',
    'Bash(git push * +*)',
    'Bash(git push --mirror*)',
    'Bash(git push * --mirror*)',
    'Bash(git push --delete*)',
    'Bash(git push * --delete*)',
    'Bash(git push -d *)',
    'Bash(git push * -d *)',
    'Bash(git push * -d)',
    'Bash(git push * :*)',
    'Bash(git * push -f*)',
    'Bash(git * push * -f*)',
    'Bash(git * push --force*)',
    'Bash(git * push * --force*)',
    'Bash(git * push +*)',
    'Bash(git * push * +*)',
    'Bash(git * push *--mirror*)',
    'Bash(git * push *--delete*)',
    'Bash(git send-pack*)',
    'Bash(git * send-pack*)',
  ],
  'any push that names main, and a bare git push': [
    'Bash(git push * main)',
    'Bash(git push * *:main)',
    'Bash(git push * *:refs/heads/main*)',
    'Bash(git push)',
    'Bash(git push origin)',
    'Bash(git push * main *)',
    'Bash(git push *refs/heads/main*)',
    "Bash(git push * 'main'*)",
    'Bash(git push * "main"*)',
    'Bash(git * push * main)',
    'Bash(git * push * main *)',
    'Bash(git * push *:main*)',
  ],
  'git --output= (writes any file)': ['Bash(git *--output*)'],
  'gh pr merge': ['Bash(gh pr merge*)', 'Bash(gh * pr merge*)'],
  'gh api, gh auth and gh alias outright': [
    'Bash(gh api*)',
    'Bash(gh * api*)',
    'Bash(gh auth*)',
    'Bash(gh * auth*)',
    'Bash(gh alias*)',
    'Bash(gh * alias*)',
  ],
  'gh repo edit and delete': ['Bash(gh repo edit*)', 'Bash(gh repo delete*)'],
  'gh secret': ['Bash(gh secret*)'],
  'pnpm dlx and exec, pnpx, npx': [
    'Bash(pnpm dlx*)',
    'Bash(pnpm exec*)',
    'Bash(pnpm * dlx*)',
    'Bash(pnpm * exec*)',
    'Bash(pnpx*)',
    'Bash(npx*)',
  ],
  'npm, yarn, bun and bunx': [
    'Bash(npm)',
    'Bash(npm *)',
    'Bash(yarn)',
    'Bash(yarn *)',
    'Bash(bun)',
    'Bash(bun *)',
    'Bash(bunx *)',
  ],
};

// `*` is a glob, everything else literal, anchored.
function bashRuleMatches(rule: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return false;
  const inner = m[1] as string;
  const source = inner
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's').test(command);
}

const FORBIDDEN = [
  'git push origin main',
  'git push origin HEAD:main',
  'git push origin HEAD:refs/heads/main',
  'git push --force origin x',
  'git push origin x --force',
  'git push -f origin x',
  'git push origin +x',
  'git push --mirror origin',
  'git push --delete origin x',
  'git push origin :x',
  'git -C . push --force origin x',
  'git push',
  'git push origin',
  'git push origin main -u',
  'git push origin main --no-verify',
  'git push origin refs/heads/main',
  "git push origin 'main'",
  'git push origin "main"',
  'git -C . push origin main',
  'git -c k=v push origin HEAD:main',
  'git push origin x -d',
  'git log -1 --format=x --output=.git/config',
  'git diff --output=/tmp/x',
  'gh pr merge 1',
  'gh pr merge --merge 1',
  'gh api repos/o/r/pulls/1/merge -X PUT',
  'gh api graphql -f query=x',
  'gh api repos/o/r/branches/main/protection',
  'gh api repos/o/r/rulesets',
  'gh api repos/o/r/git/refs/heads/x -X DELETE',
  'gh auth token',
  'gh auth status --show-token',
  'gh auth status -t',
  'gh api -X PUT repos/o/r/contents/f -f branch=main',
  'gh api -X PATCH repos/o/r',
  'gh api repos/o/r/actions/secrets',
  'gh api repos/o/r/environments',
  "gh alias set m 'pr merge'",
  'gh repo edit --visibility public',
  'gh repo delete o/r --yes',
  'gh secret list',
  'pnpm dlx x',
  'pnpm exec x',
  'pnpm --filter a exec x',
  'pnpx x',
  'npx x',
  'npm install x',
  'yarn add x',
  'bun x',
  'bunx x',
];

const PERMITTED = [
  'git push -u origin claude/p0-foundation',
  'git push origin claude/p1a-museum-sources',
  'git push origin claude/p0-foundation',
  'gh search code x',
  'pnpm check',
  'pnpm install --frozen-lockfile',
  'pnpm test',
  'git status',
  'git log --oneline',
];

describe('.claude/settings.json deny list (A§16.3)', () => {
  describe.each(Object.entries(REQUIRED))('%s', (_category, patterns) => {
    it.each(patterns)('denies %s', (pattern) => {
      expect(deny).toContain(pattern);
    });
  });

  it.each(FORBIDDEN)('a deny rule matches: %s', (command) => {
    expect(deny.some((rule) => bashRuleMatches(rule, command))).toBe(true);
  });

  it.each(PERMITTED)('no deny rule matches: %s', (command) => {
    expect(deny.filter((rule) => bashRuleMatches(rule, command))).toEqual([]);
  });

  it('has no duplicate deny entries', () => {
    expect(new Set(deny).size).toBe(deny.length);
  });

  it('has no allow entry equal to a deny entry', () => {
    expect(allow.filter((rule) => deny.includes(rule))).toEqual([]);
  });

  it.each(FORBIDDEN)('no allow rule can match: %s', (command) => {
    expect(allow.filter((rule) => bashRuleMatches(rule, command))).toEqual([]);
  });
});
