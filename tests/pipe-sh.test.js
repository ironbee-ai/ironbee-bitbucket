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

// ─── The pipe, its tools stood in for ────────────────────────────────────────

/**
 * Stand-ins for what the pipe installs and calls. npm and npx install nothing;
 * `ironbee install` writes the files the real one does; `claude` keeps its
 * prompt in STUB_PROMPT, writes its session as the CLI does (the main agent's
 * `agents/main/` directory), submits the verdict STUB_VERDICT names (after
 * those STUB_VERDICTS lists, when set), stages STUB_GIT_ADD as an agent might
 * and, given
 * STUB_EDIT, edits that file as a fix would; `curl` keeps its arguments and the
 * headers it was handed, and answers 200 only with the header STUB_PASS names.
 */
function stubBin() {
  const bin = tempDir();
  const stub = (name, lines) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${lines.join('\n')}\n`, { mode: 0o755 });
  };
  stub('npm', ['if [ "$1" = view ]; then echo 0.0.0; fi']);
  stub('npx', [':']);
  stub('jq', ['cat >/dev/null']);
  stub('ironbee', [
    'case "$1" in',
    '  --version) echo 0.0.0 ;;',
    '  install) mkdir -p .claude && echo "{}" > .mcp.json && echo "{}" > .claude/settings.json ;;',
    'esac',
  ]);
  stub('claude', [
    'if [ "$1" = --version ]; then echo 0.0.0; exit 0; fi',
    'cat > "$STUB_PROMPT"',
    'mkdir -p .ironbee/sessions/s1/agents/main',
    'printf \'{"status":"%s"}\' "$STUB_VERDICT" > .ironbee/sessions/s1/agents/main/verdict.json',
    'n=0; for status in ${STUB_VERDICTS:-$STUB_VERDICT}; do n=$((n + 1)); printf \'{"type":"verdict_write","timestamp":%s,"verdict":{"status":"%s"}}\\n\' "$n" "$status" >> .ironbee/sessions/s1/agents/main/actions.jsonl; done',
    'if [ -n "${STUB_GIT_ADD:-}" ]; then git add -- "$STUB_GIT_ADD"; fi',
    'if [ -n "${STUB_EDIT:-}" ]; then echo fixed >> "$STUB_EDIT"; fi',
  ]);
  stub('curl', [
    'printf "%s\\n" "$*" > "$STUB_CURL_ARGS"',
    ': > "$STUB_CURL_HEADERS"',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = -H ]; then',
    '    shift',
    '    case "$1" in @*) cat "${1#@}" >> "$STUB_CURL_HEADERS" ;; *) echo "$1" >> "$STUB_CURL_HEADERS" ;; esac',
    '  fi',
    '  shift',
    'done',
    'if [ -n "${STUB_REDIRECT:-}" ]; then printf "302 %s" "$STUB_REDIRECT"; exit 0; fi',
    'if grep -qxF "$STUB_PASS" "$STUB_CURL_HEADERS"; then printf 200; else printf 403; fi',
  ]);
  return bin;
}

function commitFile(dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file], { cwd: dir });
  return head(dir);
}

/** A local-mode push, with the agent's prompt as it was handed over. */
function localPipe(dir, env, home) {
  const prompt = path.join(tempDir(), 'prompt.md');
  const result = runPipe(dir, {
    PATH: `${stubBin()}${path.delimiter}${process.env.PATH}`,
    VERIFICATION_MODE: 'local',
    IRONBEE_API_KEY: 'ib-key',
    ANTHROPIC_API_KEY: 'sk-test',
    APP_START_COMMAND: 'npm start',
    APP_PORT: '4000',
    STUB_PROMPT: prompt,
    STUB_VERDICT: 'pass',
    ...env,
  }, home);
  return { result, prompt: fs.existsSync(prompt) ? fs.readFileSync(prompt, 'utf8') : '' };
}

/**
 * The repository on "bitbucket.org", as a local bare one: `main` (its default
 * branch) moved on after `feature` left it, by `mainAhead` more commits when
 * set, and `feature` carries two commits.
 * Returns a home whose git sends the repository's URL there.
 */
function upstreamWithFeature(mainAhead = 0) {
  const upstream = gitRepo();
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(upstream, 'branch', '-M', 'main');
  const forkPoint = commitFile(upstream, 'main-1.txt', 'm\n');
  git(upstream, 'checkout', '-q', '-b', 'feature');
  const featureParent = commitFile(upstream, 'feature-1.txt', 'f\n');
  commitFile(upstream, 'feature-2.txt', 'f\n');
  git(upstream, 'checkout', '-q', 'main');
  const mainParent = forkPoint;
  commitFile(upstream, 'main-2.txt', 'm\n');
  if (mainAhead > 0) {
    execFileSync('bash', ['-c', `for i in $(seq ${String(mainAhead)}); do git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "main $i"; done`], { cwd: upstream });
  }
  const bare = path.join(tempDir(), 'shop.git');
  git(upstream, 'clone', '-q', '--bare', upstream, bare);
  const home = tempDir();
  execFileSync('git', ['config', '--global', `url.file://${bare}.insteadOf`, 'https://bitbucket.org/ironbee/shop.git'], {
    env: { ...baseEnv(home) },
  });
  const clone = (branch) => {
    const dir = path.join(tempDir(), 'build');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', branch, `file://${bare}`, dir]);
    return dir;
  };
  return { home, clone, forkPoint, featureParent, mainParent };
}

// Bitbucket names no commit a push started from: a push of a branch measures
// from where it left the repository's main branch, so every commit on it is read.
test('pipe: a local push of a branch diffs from where it left the main branch', () => {
  const { home, clone, forkPoint, featureParent } = upstreamWithFeature();
  const { result, prompt } = localPipe(clone('feature'), { BITBUCKET_BRANCH: 'feature' }, home);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(prompt, new RegExp(`^Diff target: ${forkPoint}$`, 'm'));
  assert.doesNotMatch(prompt, new RegExp(featureParent));
});

// A depth of 50 after the unshallow made the clone shallow again, and a main
// that moved further than that hid the merge base: the push then read only its
// last commit, and said nothing.
test('pipe: a branch whose main moved far ahead still diffs from where it left main', () => {
  const { home, clone, forkPoint } = upstreamWithFeature(60);
  const dir = clone('feature');
  const { result, prompt } = localPipe(dir, { BITBUCKET_BRANCH: 'feature' }, home);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(prompt, new RegExp(`^Diff target: ${forkPoint}$`, 'm'));
  assert.equal(execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: dir, encoding: 'utf8' }).trim(), 'false');
  assert.doesNotMatch(result.stdout, /measured from its commit's parent alone/);
});

// When the base cannot be found, a push off the main branch says it reads its
// last commit alone.
test('pipe: a branch push that falls back to the parent says so', () => {
  const dir = gitRepo();
  const { result } = localPipe(dir, { BITBUCKET_BRANCH: 'feature' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /WARNING:.*the repository's main branch could not be read, so this push of feature is measured from its commit's parent alone/);
});

// On the main branch itself the merge base is the commit, a changeset of
// nothing: the parent stands in.
test('pipe: a local push to the main branch diffs from the commit\'s parent', () => {
  const { home, clone, mainParent } = upstreamWithFeature();
  const { result, prompt } = localPipe(clone('main'), { BITBUCKET_BRANCH: 'main' }, home);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(prompt, new RegExp(`^Diff target: ${mainParent}$`, 'm'));
});

// The main branch unreadable — here, nothing answers at bitbucket.org — leaves
// the parent, as before.
test('pipe: a local push diffs from the base the binding measures from, and names the application\'s port', () => {
  const dir = gitRepo();
  commitFile(dir, 'a.txt', 'a\n');
  const parent = head(dir);
  commitFile(dir, 'b.txt', 'b\n');
  const { result, prompt } = localPipe(dir, {});

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(prompt, new RegExp(`^Diff target: ${parent}$`, 'm'));
  assert.match(prompt, /^- Application port: 4000$/m);
});

// Fixing off: the agent is not asked to fix, and what it changed anyway lands
// nowhere.
test('pipe: a local run with VERIFICATION_APPLY_FIX off asks for no fix and lands none', () => {
  const dir = gitRepo();
  const { result, prompt } = localPipe(dir, {
    VERIFICATION_APPLY_FIX: 'false',
    STUB_EDIT: path.join(dir, 'index.html'),
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(prompt, /^You are running in CI\. Verify the code changes and report any issues found\.$/m);
  assert.match(prompt, /If verification fails, do not change any files/);
  assert.doesNotMatch(prompt, /fix the issues/);
  assert.doesNotMatch(result.stdout, /Create fix PR/);
});

test('pipe: a local run with VERIFICATION_APPLY_FIX on asks for the fix and lands it', () => {
  const dir = gitRepo();
  // Left by something before the agent ran: not the fix.
  fs.writeFileSync(path.join(dir, 'build.log'), 'built\n');
  // A failing cycle, the fix, and a passing one.
  // The agent also staged that stray file itself: the emptied index drops it.
  const { result, prompt } = localPipe(dir, { STUB_EDIT: path.join(dir, 'index.html'), STUB_VERDICTS: 'fail pass', STUB_GIT_ADD: 'build.log' });

  assert.match(prompt, /^3\. If verification fails, fix the issues and re-verify$/m);
  // Landing it needs the step's token, which this run does not have.
  assert.equal(result.status, 1);
  assert.match(result.stdout, /there are fixes to open a pull request for, and no BITBUCKET_OAUTH_TOKEN/);
  // The commit on the fix branch carries the fix alone, not what was lying there.
  const branch = execFileSync('git', ['branch', '--list', 'ironbee/fix-*', '--format=%(refname:short)'], { cwd: dir, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['show', '--name-only', '--format=', branch], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(files, 'index.html');
  // The session is s1, read from its agent's directory, and its evidence is kept whole.
  assert.match(result.stdout, /\/sessions\/s1\)/);
  assert.ok(fs.existsSync(path.join(dir, '.ironbee', 'upload', 'sessions', 's1', 'agents', 'main', 'actions.jsonl')));
});

// The agent installs, builds and starts the application in its own run: what
// that wrote, on a run whose first cycle passed, is no fix.
test('pipe: a local run whose first cycle passes over a changed tree lands nothing', () => {
  const dir = gitRepo();
  const { result } = localPipe(dir, { STUB_EDIT: path.join(dir, 'index.html') });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Create fix PR/);
  assert.equal(execFileSync('git', ['branch', '--list', 'ironbee/fix-*'], { cwd: dir, encoding: 'utf8' }), '');
});

// A setup path the repository ignores is skipped, as a whole-tree add skipped
// it, and the fix still lands.
test('pipe: a local run with IRONBEE_EXCLUDE_FILES off and an ignored .mcp.json still lands the fix', () => {
  const dir = gitRepo();
  commitFile(dir, '.gitignore', '.mcp.json\n');
  const { result } = localPipe(dir, {
    STUB_EDIT: path.join(dir, 'index.html'),
    STUB_VERDICTS: 'fail pass',
    IRONBEE_EXCLUDE_FILES: 'false',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /there are fixes to open a pull request for, and no BITBUCKET_OAUTH_TOKEN/);
  const branch = execFileSync('git', ['branch', '--list', 'ironbee/fix-*', '--format=%(refname:short)'], { cwd: dir, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['show', '--name-only', '--format=', branch], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(files, '.claude/settings.json\nindex.html');
});

// With the IronBee setup kept in the commits, it lands with the fix, though
// `ironbee install` wrote it before the snapshot.
test('pipe: a local run with IRONBEE_EXCLUDE_FILES off lands the IronBee setup with the fix', () => {
  const dir = gitRepo();
  const { result } = localPipe(dir, {
    STUB_EDIT: path.join(dir, 'index.html'),
    STUB_VERDICTS: 'fail pass',
    IRONBEE_EXCLUDE_FILES: 'false',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /there are fixes to open a pull request for, and no BITBUCKET_OAUTH_TOKEN/);
  const branch = execFileSync('git', ['branch', '--list', 'ironbee/fix-*', '--format=%(refname:short)'], { cwd: dir, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['show', '--name-only', '--format=', branch], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(files, '.claude/settings.json\n.mcp.json\nindex.html');
});

// A run whose agent changed nothing stages nothing, whatever else is lying in
// the tree.
test('pipe: a local run whose agent changed nothing lands nothing', () => {
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, 'build.log'), 'built\n');
  const { result } = localPipe(dir, {});

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Create fix PR/);
  assert.equal(execFileSync('git', ['branch', '--list', 'ironbee/fix-*'], { cwd: dir, encoding: 'utf8' }), '');
});

// The exclude file and its patterns are the repository's, read from its root.
test('pipe: a working directory below the clone\'s root keeps the IronBee setup out of git', () => {
  const dir = gitRepo();
  commitFile(dir, 'web/index.html', '<h1>web</h1>\n');
  const { result } = localPipe(dir, { WORKING_DIRECTORY: 'web' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const file of ['web/.mcp.json', 'web/.claude/settings.json', 'web/.ironbee/config.json']) {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: dir });
  }
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
});

/** A run against a deployed URL that answers only with the bypass header. */
function protectedDeployment(env) {
  const scratch = tempDir();
  const result = runPipe(gitRepo(), {
    PATH: `${stubBin()}${path.delimiter}${process.env.PATH}`,
    IRONBEE_API_KEY: 'ib-key',
    APP_URL: 'https://preview.example.com',
    APP_HEADERS: 'X-Plain: 1',
    APP_SECRET_HEADERS: 'X-Bypass: s3cret',
    STUB_PASS: 'X-Bypass: s3cret',
    STUB_CURL_ARGS: path.join(scratch, 'args'),
    STUB_CURL_HEADERS: path.join(scratch, 'headers'),
    ...env,
  });
  return {
    result,
    args: fs.readFileSync(path.join(scratch, 'args'), 'utf8'),
    headers: fs.readFileSync(path.join(scratch, 'headers'), 'utf8'),
  };
}

// A protection the secret headers bypass is not refused, and the secret is
// never on curl's command line.
// A redirect is not followed, so its target is named: a sign-in redirect to an
// identity provider, or http to https, is then visible in the log.
test('pipe: the reachability check names a redirect it does not follow', () => {
  const { result, args } = protectedDeployment({ VERIFICATION_MODE: 'platform', STUB_REDIRECT: 'https://idp.example.com/login' });

  assert.match(result.stdout, /WARNING:.*https:\/\/preview\.example\.com answers 302, redirecting to https:\/\/idp\.example\.com\/login\./);
  assert.match(args, /%\{http_code\} %\{redirect_url\}/);
  assert.doesNotMatch(args, /(^| )(-L|--location)( |$)/);
});

test('pipe: the reachability check sends the headers the platform run sends', () => {
  const { result, args, headers } = protectedDeployment({ VERIFICATION_MODE: 'platform' });

  assert.match(result.stdout, /https:\/\/preview\.example\.com answers 200/);
  assert.doesNotMatch(result.stdout, /deployment protection/);
  assert.equal(headers, 'X-Plain: 1\nX-Bypass: s3cret\n');
  assert.doesNotMatch(args, /s3cret/);
  // A redirect would carry them to another host, so none is followed.
  assert.doesNotMatch(args, /(^| )(-L|--location)( |$)/);
});

// Local mode does not use the headers, so neither does its check.
test('pipe: a local run\'s reachability check sends no headers', () => {
  const { result, args, headers } = protectedDeployment({ VERIFICATION_MODE: 'local', ANTHROPIC_API_KEY: 'sk-test' });

  assert.equal(result.status, 1);
  assert.equal(headers, '');
  assert.match(result.stdout, /ERROR:.*https:\/\/preview\.example\.com answers 403 — it is behind deployment protection/);
  assert.doesNotMatch(args, /(^| )(-L|--location)( |$)/);
});
