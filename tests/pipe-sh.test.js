'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// pipe.sh is what Bitbucket starts: it moves the pipe's variables to the
// INPUT_<NAME>s run.sh reads, checks what the pipe cannot run without, gives
// git the credential, resolves the commit, and hands over to run.sh. Sourcing
// it defines its helpers and stops; running it runs the pipe end to end.
//
// Every run here has its own HOME, because pipe.sh writes git's global
// configuration, and allows git the file protocol alone, so nothing reaches
// bitbucket.org: a fetch the test does not point at a local repository fails
// at once, as it would without credentials.

const ROOT = path.join(__dirname, '..');
const PIPE_SH = path.join(ROOT, 'pipe.sh');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-sh-'));
}

function baseEnv(home) {
  return { PATH: process.env.PATH, HOME: home, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1' };
}

function bash(snippet, env, cwd) {
  const home = tempDir();
  return execFileSync('bash', ['-c', `source "${PIPE_SH}"; ${snippet}`], {
    encoding: 'utf8',
    cwd: cwd || home,
    env: { ...baseEnv(home), ...env },
  });
}

function gitRepo() {
  const dir = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function runPipe(dir, env, home) {
  const own = home || tempDir();
  return spawnSync('bash', [PIPE_SH], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...baseEnv(own),
      BITBUCKET_CLONE_DIR: dir,
      BITBUCKET_REPO_FULL_NAME: 'ironbee/shop',
      BITBUCKET_REPO_IS_PRIVATE: 'false',
      BITBUCKET_BRANCH: 'main',
      BITBUCKET_BUILD_NUMBER: '7',
      BITBUCKET_COMMIT: head(dir),
      ...env,
    },
  });
}

// ─── The variables ───────────────────────────────────────────────────────────

// A component input given an empty value is empty; one not given takes its
// default. A pipe variable is the same: passed empty is a value.
test('variables: each arrives as INPUT_<NAME>, with its default where the step passed none', () => {
  const printed = bash(
    'map_variables; printf "%s|%s|%s|%s" "$INPUT_VERIFICATION_MODE" "$INPUT_CLAUDE_CODE_MAX_TURNS" "[$INPUT_IRONBEE_CLI_VERSION]" "$INPUT_WORKING_DIRECTORY"',
    { VERIFICATION_MODE: 'platform', IRONBEE_CLI_VERSION: '' },
  );
  assert.equal(printed, 'platform|100|[]|.');
});

// The variables reach every process the pipe starts. Under their own names
// they are gone; as INPUT_* they reach run.sh, which takes them back out.
test('variables: the variables themselves leave the environment', () => {
  const printed = bash(
    'map_variables; bash -c \'printf "%s|%s|%s" "${IRONBEE_API_KEY:-unset}" "${BITBUCKET_OAUTH_TOKEN:-unset}" "$INPUT_IRONBEE_API_KEY"\'',
    { IRONBEE_API_KEY: 'ib-secret', BITBUCKET_OAUTH_TOKEN: 'bb-secret' },
  );
  assert.equal(printed, 'unset|unset|ib-secret');
});

test('variables: a step outside Bitbucket Pipelines is refused', () => {
  const result = spawnSync('bash', ['-c', `source "${PIPE_SH}"; map_variables; validate_variables`], {
    encoding: 'utf8',
    env: baseEnv(tempDir()),
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR:.*BITBUCKET_REPO_FULL_NAME and BITBUCKET_COMMIT are not set/);
});

// EVENT_NAME is typed by a person, where GitLab's pipeline source is not: a
// typo would quietly run a pipeline as some other event.
test('variables: EVENT_NAME takes the four events and nothing else', () => {
  const context = { BITBUCKET_REPO_FULL_NAME: 'ironbee/shop', BITBUCKET_COMMIT: 'a'.repeat(40) };
  for (const event of ['', 'merge_request', 'push', 'manual', 'schedule']) {
    assert.equal(bash('map_variables; validate_variables && echo ok', { ...context, EVENT_NAME: event }).trim(), 'ok', event);
  }
  const result = spawnSync('bash', ['-c', `source "${PIPE_SH}"; map_variables; validate_variables`], {
    encoding: 'utf8',
    env: { ...baseEnv(tempDir()), ...context, EVENT_NAME: 'nightly' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /EVENT_NAME must be one of merge_request, push, manual, schedule \(got 'nightly'\)/);
});

// ─── Git ─────────────────────────────────────────────────────────────────────

// The helper answers with the step's token when the git it serves has it in
// its environment, and with nothing when it does not: the agent's never does.
test('git: the credential for bitbucket.org is x-token-auth with the step token', () => {
  const query = (token) => 'printf "protocol=https\\nhost=bitbucket.org\\npath=ironbee/shop.git\\n\\n" | '
    + `${token} git credential fill`;
  const filled = bash(`configure_git; ${query('BITBUCKET_OAUTH_TOKEN=bb-secret')}`, { GIT_TERMINAL_PROMPT: '0' });
  assert.match(filled, /^username=x-token-auth$/m);
  assert.match(filled, /^password=bb-secret$/m);

  const bare = bash(`configure_git; ${query('')}`, { GIT_TERMINAL_PROMPT: '0' });
  assert.match(bare, /^password=$/m);
});

// The clone is mounted from the build container, owned by whoever cloned it.
test('git: the clone is a safe directory', () => {
  const printed = bash('configure_git; git config --global --get-all safe.directory', {
    BITBUCKET_CLONE_DIR: '/opt/atlassian/pipelines/agent/build',
  });
  assert.equal(printed.trim(), '/opt/atlassian/pipelines/agent/build');
});

// A pull request pipeline names its commit by 12 characters.
test('git: a short commit is resolved to the full hash, an unknown one left alone', () => {
  const dir = gitRepo();
  const full = head(dir);
  assert.equal(bash('resolve_commit; printf "%s" "$BITBUCKET_COMMIT"', { BITBUCKET_COMMIT: full.slice(0, 12) }, dir), full);
  assert.equal(bash('resolve_commit; printf "%s" "$BITBUCKET_COMMIT"', { BITBUCKET_COMMIT: 'abcdef123456' }, dir), 'abcdef123456');
});

// ─── The pipe, end to end ────────────────────────────────────────────────────

// The build workflow's smoke path: verification switched off on a push. The
// plan says "nothing to do", every step after it is skipped, and the pipe ends
// green.
test('pipe: VERIFICATION_AUTO off on a push ends green having done nothing', () => {
  const dir = gitRepo();
  const result = runPipe(dir, { VERIFICATION_AUTO: 'false' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NOTICE:.*IronBee verification skipped — VERIFICATION_AUTO is off, and push/);
  assert.doesNotMatch(result.stdout, /Install IronBee CLI/);
  assert.doesNotMatch(result.stdout, /Fail the job when the verification did/);
  const env = fs.readFileSync(path.join(dir, '.ironbee', 'outputs.env'), 'utf8');
  assert.match(env, /^IRONBEE_MODE=$/m);
  assert.match(env, /^IRONBEE_PLATFORM_PUBLISHES=false$/m);
  // What the step's `artifacts:` keeps exists even when nothing ran.
  assert.ok(fs.statSync(path.join(dir, '.ironbee', 'upload')).isDirectory());
});

// A pull request pipeline is the pull request's event without anyone saying so.
test('pipe: a pull request pipeline is a merge_request event', () => {
  const dir = gitRepo();
  const result = runPipe(dir, { VERIFICATION_AUTO: 'false', BITBUCKET_PR_ID: '12' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /VERIFICATION_AUTO is off, and merge_request is not a run anyone asked for by name/);
});

// A `custom:` pipeline run by hand says so, and a manual run is never switched
// off: the plan runs, and refuses here only for the missing key.
test('pipe: EVENT_NAME manual is a run somebody asked for by name', () => {
  const dir = gitRepo();
  const result = runPipe(dir, { VERIFICATION_AUTO: 'false', EVENT_NAME: 'manual' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /verification skipped/);
  assert.match(result.stdout, /ERROR:.*IRONBEE_API_KEY is required/);
});

// A plan that refuses ends the pipe red before anything is installed, and with
// no mode there is no gate to run.
test('pipe: a refused plan ends red, before any install', () => {
  const dir = gitRepo();
  const result = runPipe(dir, { VERIFICATION_AUTO: 'true', IRONBEE_API_KEY: '' });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR:.*IRONBEE_API_KEY is required/);
  assert.match(result.stdout, /ERROR:.*Resolve the verification plan: process completed with exit code 1/);
  assert.doesNotMatch(result.stdout, /Install IronBee CLI/);
  assert.doesNotMatch(result.stdout, /Fail the job when the verification did/);
});

test('pipe: a mistyped EVENT_NAME ends red before any step', () => {
  const dir = gitRepo();
  const result = runPipe(dir, { VERIFICATION_AUTO: 'false', EVENT_NAME: 'nightly' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /EVENT_NAME must be one of/);
  assert.doesNotMatch(result.stdout, /Fetch git history for diff/);
});

// The cache lives in the clone, and the fix detection reads `git status` — so a
// restored cache must not look like a change.
test('pipe: the Playwright cache in the clone is invisible to git', () => {
  const dir = gitRepo();
  fs.mkdirSync(path.join(dir, '.cache', 'ms-playwright', 'chromium-1'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cache', 'ms-playwright', 'chromium-1', 'chrome'), 'binary');
  runPipe(dir, { VERIFICATION_AUTO: 'false' });

  const status = execFileSync('git', ['status', '--porcelain', '--', ':(exclude).ironbee'], { cwd: dir, encoding: 'utf8' });
  assert.equal(status, '');
});

// The clone's `origin` is the Pipelines proxy, out of a pipe's reach: the
// history comes from the repository's own URL, and lands where a fetch from
// `origin` would put it.
test('pipe: the history is fetched from the repository URL into origin/<branch>', () => {
  const upstream = gitRepo();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(upstream, 'branch', '-M', 'main');
  git(upstream, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(upstream, 'feature.txt'), 'f\n');
  git(upstream, 'add', '.');
  git(upstream, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'feature');
  const bare = path.join(tempDir(), 'shop.git');
  git(upstream, 'clone', '-q', '--bare', upstream, bare);

  const clone = path.join(tempDir(), 'build');
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${bare}`, clone]);
  const home = tempDir();
  execFileSync('git', ['config', '--global', `url.file://${bare}.insteadOf`, 'https://bitbucket.org/ironbee/shop.git'], {
    env: { ...baseEnv(home) },
  });

  const result = runPipe(clone, {
    VERIFICATION_AUTO: 'false',
    BITBUCKET_PR_ID: '3',
    BITBUCKET_BRANCH: 'feature',
    BITBUCKET_PR_DESTINATION_BRANCH: 'main',
  }, home);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(git(clone, 'rev-parse', 'origin/main'), git(bare, 'rev-parse', 'main'));
});
