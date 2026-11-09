'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The seams between `pipe.yml`, `pipe.sh`, `scripts/run.sh` and
// `scripts/resolve-plan.js`, which no unit test can see. In the action each one
// has already broken once: a rename left an input behind in a step that still
// resolved to an empty string, and a defaulted input whose `fallback` did not
// match its declared default put itself in the unused-input warning on every
// single run.
//
// The files are read as text rather than parsed. This repository has no
// dependencies and will not grow a YAML parser for these assertions — and the
// shapes below are fixed by the files' own conventions, not guessed.

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const PIPE_YML = read('pipe.yml');
const PIPE_SH = read('pipe.sh');
const RUN_SH = read('scripts', 'run.sh');
const SCRIPT = read('scripts', 'resolve-plan.js');
const DOCKERFILE = read('Dockerfile');
const RELEASE = read('.github', 'workflows', 'release.yml');

/** `- name:` at two-space indent under `variables:`, with its `default:`. */
function declaredVariables() {
  const variables = new Map();
  const block = PIPE_YML.slice(PIPE_YML.indexOf('\nvariables:\n'));
  let current = null;
  for (const line of block.split('\n')) {
    const declaration = line.match(/^ {2}- name: ([A-Z][A-Z0-9_]*)\s*$/);
    if (declaration) {
      current = { name: declaration[1], default: null };
      variables.set(current.name, current);
      continue;
    }
    const field = line.match(/^ {4}default: '(.*)'\s*$/);
    if (current !== null && field) {
      current.default = field[1];
    }
  }
  return variables;
}

const VARIABLES = declaredVariables();
const defaultOf = (name) => (VARIABLES.has(name) ? VARIABLES.get(name).default : undefined);

/** A default that names the pipeline variable of the variable's own name. */
const selfReference = (name) => `\${${name}}`;

/** pipe.sh's table: `'NAME=default'` per line. */
function mappedVariables() {
  const start = PIPE_SH.indexOf('PIPE_VARIABLES=(');
  assert.notEqual(start, -1, 'PIPE_VARIABLES not found in pipe.sh');
  const body = PIPE_SH.slice(start, PIPE_SH.indexOf('\n)', start));
  return [...body.matchAll(/^ {2}'([A-Z][A-Z0-9_]*)=([^']*)'$/gm)].map((match) => ({ name: match[1], fallback: match[2] }));
}

const MAPPED = mappedVariables();

test('pipe.yml: the variables block parses into something recognisable', () => {
  assert.ok(VARIABLES.size > 30, `only ${String(VARIABLES.size)} variables found — the block shape changed`);
  assert.equal(defaultOf('VERIFICATION_MODE'), 'auto');
});

// There is no `required` in pipe.yml: every variable says what it is when the
// step leaves it out.
test('pipe.yml: every variable declares a default', () => {
  for (const variable of VARIABLES.values()) {
    assert.notEqual(variable.default, null, `${variable.name} has no default`);
  }
});

// Credentials default to the pipeline variable of their own name, so a
// consumer keeps them as secured variables and writes none of them in YAML.
test('pipe.yml: the credentials default to their pipeline variables', () => {
  for (const name of ['IRONBEE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'BITBUCKET_OAUTH_TOKEN']) {
    assert.equal(defaultOf(name), selfReference(name), name);
  }
});

// pipe.sh applies what pipe.yml declares: the same variables, in the same
// order, with the same defaults. A self-reference is empty in pipe.sh: the
// variable reaches the pipe under that name or not at all.
test('pipe.sh: maps exactly the variables pipe.yml declares, with their defaults', () => {
  assert.deepEqual(MAPPED.map((entry) => entry.name), [...VARIABLES.keys()]);
  for (const { name, fallback } of MAPPED) {
    const declared = defaultOf(name) === selfReference(name) ? '' : defaultOf(name);
    assert.equal(fallback, declared, `${name}: pipe.sh's default disagrees with pipe.yml`);
  }
});

// The run reads its configuration from the environment and nothing else. A
// variable pipe.sh forgets to map reads as unset, which for a boolean means
// "the default" and for a target field means "not configured".
test('pipe.sh: every INPUT_* run.sh and resolve-plan.js read is one it maps', () => {
  const mapped = new Set(MAPPED.map((entry) => `INPUT_${entry.name}`));
  const readNames = new Set([
    ...[...RUN_SH.matchAll(/INPUT_[A-Z0-9_]+/g)].map((match) => match[0]),
    ...[...SCRIPT.matchAll(/process\.env\.(INPUT_[A-Z0-9_]+)/g)].map((match) => match[1]),
  ]);
  const missing = [...readNames].filter((name) => !mapped.has(name)).sort();
  assert.deepEqual(missing, []);

  const spare = [...mapped].filter((name) => !readNames.has(name)).sort();
  assert.deepEqual(spare, [], 'mapped by pipe.sh, never read');
});

// The plan step is the script's whole world. Every variable it reads has to be
// exported in that step — the inputs are taken out of the environment at the
// top of run.sh and handed back step by step, as the action's `env:` did.
test('run.sh: the plan step exports every variable resolve-plan.js reads', () => {
  const start = RUN_SH.indexOf('step_plan() {');
  const planStep = RUN_SH.slice(start, RUN_SH.indexOf('scripts/resolve-plan.js', start));
  const exported = new Set(
    [...planStep.matchAll(/^\s+export ((?:[A-Z][A-Z0-9_]*\s*)+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/)),
  );
  // IRONBEE_OUTPUT comes from the step runner, not from this step.
  const readNames = [...SCRIPT.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)]
    .map((m) => m[1])
    .filter((name) => name !== 'IRONBEE_OUTPUT');

  const missing = [...new Set(readNames)].filter((name) => !exported.has(name)).sort();
  assert.deepEqual(missing, [], 'read by resolve-plan.js, never exported to it');

  const readSet = new Set(readNames);
  const spareInputs = [...exported].filter((name) => name.startsWith('INPUT_') && !readSet.has(name)).sort();
  assert.deepEqual(spareInputs, [], 'exported to resolve-plan.js, never read');
});

/** The tables' entries, read off the source so the test cannot hold a stale copy. */
function tableEntries(name) {
  const start = SCRIPT.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} not found`);
  const body = SCRIPT.slice(start, SCRIPT.indexOf('\n];', start));
  return [...body.matchAll(/name: '([A-Z0-9_]+)', key: '([A-Za-z0-9]+)', fallback: '([^']*)'/g)]
    .map((match) => ({ name: match[1], key: match[2], fallback: match[3] }));
}

// The whole point of `fallback` is that it equals the declared default, so
// "the author chose this" can be told from "the default arrived".
for (const table of ['LOCAL_ONLY_INPUTS', 'PLATFORM_ONLY_INPUTS']) {
  test(`${table}: every entry names a real variable, with its declared default`, () => {
    const entries = tableEntries(table);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.ok(VARIABLES.has(entry.name), `${entry.name} is not a declared variable`);
      assert.equal(entry.fallback, defaultOf(entry.name), `${entry.name}: fallback disagrees with pipe.yml`);
    }
  });
}

test('BOOLEAN_INPUTS: covers exactly the variables whose default is a boolean', () => {
  const start = SCRIPT.indexOf('const BOOLEAN_INPUTS = [');
  const body = SCRIPT.slice(start, SCRIPT.indexOf('\n];', start));
  const declared = new Set([...body.matchAll(/\['([A-Z0-9_]+)',/g)].map((match) => match[1]));

  const booleanByDefault = [...VARIABLES.values()]
    .filter((variable) => variable.default === 'true' || variable.default === 'false')
    .map((variable) => variable.name);

  for (const name of booleanByDefault) {
    assert.ok(declared.has(name), `${name} defaults to a boolean but is never parsed as one`);
  }
  for (const name of declared) {
    assert.ok(VARIABLES.has(name), `${name} is parsed as a boolean but is not a declared variable`);
  }
});

test('BOOLEAN_INPUTS: every fallback equals the declared default', () => {
  const start = SCRIPT.indexOf('const BOOLEAN_INPUTS = [');
  const body = SCRIPT.slice(start, SCRIPT.indexOf('\n];', start));
  const entries = [...body.matchAll(/\['([A-Z0-9_]+)', '[A-Za-z0-9]+', (true|false)\]/g)];
  assert.ok(entries.length > 0);
  for (const [, name, fallback] of entries) {
    assert.equal(fallback, defaultOf(name), `${name}: fallback disagrees with pipe.yml`);
  }
});

// A port default is indistinguishable from a port someone typed.
test('pipe.yml: APP_PORT declares no default', () => {
  assert.equal(defaultOf('APP_PORT'), '');
});

// Bitbucket Pipelines has no trigger for a pull request comment.
test('pipe.yml: there is no comment command', () => {
  assert.equal(VARIABLES.has('VERIFICATION_COMMAND'), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'parse-command.js')), false);
});

// ─── The image and its version ───────────────────────────────────────────────

// The short form (`pipe: <workspace>/<repository>:<tag>`) reads the image from
// pipe.yml, so it names a release; the examples pin the release's line.
test('pipe.yml: the image is a release, and the examples pin its line', () => {
  const version = (PIPE_YML.match(/^image: ghcr\.io\/ironbee-ai\/ironbee-bitbucket:(v(\d+)\.\d+\.\d+)$/m) || []);
  assert.ok(version[1], 'pipe.yml names no release image');
  const line = `v${version[2]}`;
  for (const doc of ['README.md', 'CLAUDE.md']) {
    const named = [...read(doc).matchAll(/pipe: docker:\/\/ghcr\.io\/ironbee-ai\/ironbee-bitbucket:([\w.]+)/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `${doc} has no pipe example`);
    for (const tag of named) {
      assert.equal(tag, line, `${doc} pins :${tag}, the release line is ${line}`);
    }
  }
});

// The release refuses a tag that differs from what pipe.yml names, by reading
// the same line this test reads.
test('release: the tag check reads pipe.yml\'s image line', () => {
  assert.ok(RELEASE.includes("s/^image: *ghcr\\.io\\/ironbee-ai\\/ironbee-bitbucket:\\(.*\\)$/\\1/p"));
  assert.match(RELEASE, /tags: \['v\*'\]/);
  assert.match(RELEASE, /contents: write/);
  assert.match(RELEASE, /packages: write/);
  assert.ok(RELEASE.includes(`ghcr.io/\${{ github.repository_owner }}/ironbee-bitbucket`));
});

// What a run needs from its image, which is ours rather than the consumer's.
test('Dockerfile: Node 22, git, jq, curl, and the Docker CLI with Compose and Buildx', () => {
  assert.match(DOCKERFILE, /^FROM node:22-bookworm$/m);
  for (const pkg of ['git', 'jq', 'curl', 'docker-ce-cli', 'docker-buildx-plugin', 'docker-compose-plugin']) {
    assert.match(DOCKERFILE, new RegExp(`install -y --no-install-recommends[^\\n]*\\b${pkg}\\b`), pkg);
  }
  assert.match(DOCKERFILE, /^ENTRYPOINT \["\/pipe\.sh"\]$/m);
  assert.match(DOCKERFILE, /^COPY scripts\/ \/ironbee-bitbucket\/scripts\/$/m);
  assert.match(DOCKERFILE, /^ENV IRONBEE_BITBUCKET_HOME=\/ironbee-bitbucket$/m);
});

test('pipe.sh: hands over to scripts/run.sh', () => {
  assert.match(PIPE_SH, /^exec bash "\$IRONBEE_BITBUCKET_HOME\/scripts\/run\.sh"$/m);
});

// The step's `artifacts:` keeps what run.sh copies at the action's upload
// steps, and the directory exists before the first step.
test('run.sh: .ironbee/upload/ exists before the first step', () => {
  const created = RUN_SH.indexOf('mkdir -p "$IRONBEE_STATE" "$IRONBEE_STATE/upload"');
  assert.notEqual(created, -1);
  assert.ok(created < RUN_SH.indexOf('\n  run_step '));
});

// ─── run.sh mirrors the action's guards ──────────────────────────────────────

/** The condition run.sh guards a step with: the `if` above its `run_step`. */
function conditionOf(id) {
  const at = RUN_SH.indexOf(`run_step ${id} `);
  assert.notEqual(at, -1, `run_step ${id} not found`);
  const start = RUN_SH.lastIndexOf('\nif ', at);
  return RUN_SH.slice(start, at);
}

/** A step function's body, up to its closing brace. */
function stepBody(name) {
  const start = RUN_SH.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} not found`);
  return RUN_SH.slice(start, RUN_SH.indexOf('\n}\n', start));
}

// Both outcome paths carry the same refusal, and they must keep carrying it.
test('run.sh: neither outcome path ships a fix the re-verification rejected', () => {
  for (const id of ['commit-fixes', 'create-fix-pr']) {
    const condition = conditionOf(id);
    assert.match(condition, /\[ "\$JOB_REVERIFIED_verdict" != fail \]/, id);
    assert.match(condition, /\[ "\$VERDICT_status" != fail \]/, id);
  }
});

// VERIFICATION_APPLY_FIX off lands nothing, in either mode: what the run
// changed then is not a fix.
test('run.sh: neither outcome path runs with fixing off', () => {
  for (const id of ['commit-fixes', 'create-fix-pr']) {
    assert.match(conditionOf(id), /\[ "\$PLAN_can_fix" = true \]/, id);
  }
});

// What an install or a build left in the tree is not a fix: neither path runs
// unless a fix step changed files, and then it stages only the paths it touched.
test('run.sh: neither outcome path stages anything but what the fix touched', () => {
  for (const id of ['commit-fixes', 'create-fix-pr']) {
    assert.match(conditionOf(id), /\{ \[ "\$PLATFORM_FIX_fixed" = true \] \|\| \[ "\$CLAUDE_VERIFY_fixed" = true \]; \}/, id);
  }
  for (const fn of ['step_commit_fixes', 'step_create_fix_pr']) {
    const body = stepBody(fn);
    assert.doesNotMatch(body, /git add/, fn);
    assert.match(body, /scripts\/fix-paths\.js" stage \.ironbee\/fix-paths/, fn);
    assert.match(body, /git reset HEAD -- \.ironbee\//, fn);
  }
});

// Each fix step measures its own changes from a snapshot taken before it.
test('run.sh: both fix steps snapshot the tree before the fix and list what changed after it', () => {
  for (const fn of ['step_claude_verify', 'step_platform_fix']) {
    const body = stepBody(fn);
    const snapshot = body.indexOf('fix-paths.js" snapshot .ironbee/pre-fix-tree');
    const agent = body.indexOf('| claude --output-format');
    const changed = body.indexOf('fix-paths.js" changed .ironbee/pre-fix-tree .ironbee/fix-paths');
    assert.ok(snapshot !== -1 && snapshot < agent && agent < changed, fn);
    assert.match(body, /echo "fixed=true" >> "\$IRONBEE_OUTPUT"/, fn);
    assert.doesNotMatch(body, /git status --porcelain/, fn);
  }
});

// The application this pipe started is started and stopped as a process group.
test('run.sh: the application is started and stopped through the process-group helpers', () => {
  assert.match(stepBody('step_start_app'), /\n\s+start_app_process(\n|$)/);
  assert.match(stepBody('restart_app'), /\n\s+start_app_process(\n|$)/);
  assert.match(stepBody('step_stop_app'), /stop_app_process "\$\(cat \.ironbee\/app\.pid\)"/);
  // Neither the stop nor the default restart kills the process alone.
  assert.doesNotMatch(stepBody('step_stop_app'), /^\s+kill [^\n]*app\.pid/m);
  const restart = stepBody('restart_app');
  assert.doesNotMatch(restart.slice(restart.indexOf('# Whether this action\'s own restart can work at all.')), /^\s+kill "\$pid"/m);
  assert.equal((RUN_SH.match(/nohup bash -c "\$APP_START_COMMAND"/g) || []).length, 1);
});

// A push measures from where it left its destination branch, read in the plan
// step from the branch the fetch step found.
test('run.sh: a push binds to the merge base with its destination branch', () => {
  const plan = stepBody('step_plan');
  assert.ok(plan.includes('DESTINATION="${BITBUCKET_PR_DESTINATION_BRANCH:-$FETCH_HISTORY_main_branch}"'));
  const base = plan.indexOf('BEFORE_SHA="$(bitbucket_push_base "$COMMIT_SHA" "$DESTINATION")"');
  assert.notEqual(base, -1);
  assert.ok(base < plan.indexOf('git cat-file -e "${BEFORE_SHA}^{commit}"'));
  assert.match(stepBody('step_fetch_history'), /git ls-remote --symref "\$REPOSITORY_URL" HEAD/);
  assert.match(stepBody('step_fetch_history'), /echo "main_branch=\$\{MAIN_BRANCH\}" >> "\$IRONBEE_OUTPUT"/);
  // The depth only on a clone the unshallow left shallow: on a complete one it
  // would cut the history the merge base is found in.
  assert.match(
    stepBody('step_fetch_history'),
    /if \[ "\$\(git rev-parse --is-shallow-repository 2>\/dev\/null\)" = true \]; then\n\s+git fetch "\$REPOSITORY_URL" "\$refspec" --depth=50 2>\/dev\/null \|\| true\n\s+else\n\s+git fetch "\$REPOSITORY_URL" "\$refspec" 2>\/dev\/null \|\| true\n\s+fi/,
  );
});

// From an emptied index, so what the agent staged itself stays out; and the
// IronBee setup, written before the snapshot, only when the caller keeps it.
test('run.sh: both outcome steps stage the fix from an emptied index, with the setup when it is kept', () => {
  const body = stepBody;
  for (const fn of ['step_commit_fixes', 'step_create_fix_pr']) {
    const steps = body(fn);
    assert.match(steps, /git reset -q \|\| true\n\s+node "\$IRONBEE_[A-Z]+_HOME\/scripts\/fix-paths\.js" stage \.ironbee\/fix-paths\n/, fn);
    assert.match(steps, /if \[ "\$PLAN_exclude_files" != "true" \]; then\n\s+stage_setup_paths\n\s+fi/, fn);
  }
  assert.match(body('stage_setup_paths'), /for setup_path in \.mcp\.json \.gitignore \.claude; do/);
});

// Neither call may fail a step; a broken one leaves a list of nothing. In
// local mode a changed tree is a fix only after a failing cycle.
test('run.sh: the fix steps never fail on the snapshot, and a local fix needs a fix cycle', () => {
  const body = stepBody;
  for (const fn of ['step_claude_verify', 'step_platform_fix']) {
    const steps = body(fn);
    assert.match(steps, /fix-paths\.js" snapshot \.ironbee\/pre-fix-tree \|\| \{\n\s+annotate_warning "[^"]+"\n\s+: > \.ironbee\/pre-fix-tree\n\s+\}/, fn);
    assert.match(steps, /fix-paths\.js" changed \.ironbee\/pre-fix-tree \.ironbee\/fix-paths \|\| \{\n\s+annotate_warning "[^"]+"\n\s+: > \.ironbee\/fix-paths\n\s+\}/, fn);
  }
  assert.match(body('step_claude_verify'), /FIX_CYCLE="\$\(node "\$IRONBEE_[A-Z]+_HOME\/scripts\/build-report\.js" --fix-cycle \.ironbee \|\| echo false\)"\n\s+if \[ -s \.ironbee\/fix-paths \] && \[ "\$FIX_CYCLE" = "true" \]; then/);
});

// The CLI keeps sessions outside the project by default, where nothing here
// reads them: every local step that runs it keeps them in .ironbee/.
test('run.sh: the local steps that run the CLI keep its sessions in the working directory', () => {
  const body = stepBody;
  for (const fn of ['step_setup_ironbee', 'step_claude_verify']) {
    assert.match(body(fn), /\n\s+export IRONBEE_RUNTIME_LOCATION=in-project\n/, fn);
  }
  // The setup paths are added with an ignored one tolerated, never forced.
  assert.match(body('stage_setup_paths'), /git add -A -- "\$setup_path" 2>\/dev\/null \|\| true/);
  assert.doesNotMatch(body('stage_setup_paths'), /git add [^\n]*-f\b/);
});

// The trap is set as soon as the state directory is known, before any step.
test('run.sh: the job traps the signals that end it, before the first step', () => {
  const at = RUN_SH.indexOf('\nIRONBEE_STATE="$PWD/.ironbee"\ntrap_signals\n');
  assert.notEqual(at, -1);
  assert.ok(at < RUN_SH.indexOf('\n  run_step '));
  assert.match(RUN_SH, /trap 'stop_on_signal 129' HUP\n\s+trap 'stop_on_signal 130' INT\n\s+trap 'stop_on_signal 143' TERM/);
});

// The routing rule: on a pull request the fix lands on its branch; anywhere
// else it opens a pull request.
test('run.sh: a pull request lands its fixes on the branch, anything else opens a PR', () => {
  assert.match(conditionOf('commit-fixes'), /\[ "\$EVENT_NAME" = merge_request \]/);
  assert.match(conditionOf('commit-fixes'), /\[ "\$IS_FORK" != true \]/);
  assert.match(conditionOf('create-fix-pr'), /\[ "\$EVENT_NAME" != merge_request \]/);
});

const CODE_LINES = RUN_SH.split('\n').filter((line) => !line.trim().startsWith('#'));

// Bitbucket starts a pipeline for every push, and `[skip ci]` in the commit
// message is what skips it: without it the fix commit would verify itself
// forever.
test('run.sh: every fix commit skips the pipelines its push would start', () => {
  const commits = CODE_LINES.filter((line) => /\bgit commit\b/.test(line));
  assert.ok(commits.length >= 2);
  for (const line of commits) {
    assert.match(line, / \[skip ci\]"$/, line.trim());
  }
});

// The clone's `origin` is the Pipelines proxy on the build container's
// loopback, which a pipe cannot reach. Every fetch and push names the
// repository's URL, and Bitbucket takes no push option.
test('run.sh: every fetch and push goes to the repository URL, with no push option', () => {
  const transfers = CODE_LINES.filter((line) => /\bgit (fetch|push|ls-remote)\b/.test(line));
  assert.ok(transfers.length >= 5);
  for (const line of transfers) {
    assert.match(line, /\bgit (fetch|push|ls-remote)\b.*"\$REPOSITORY_URL"/, line.trim());
    assert.doesNotMatch(line, /\borigin\b(?!\/)/, line.trim());
    assert.doesNotMatch(line, / -o /, line.trim());
  }
  assert.match(RUN_SH, /^REPOSITORY_URL="https:\/\/bitbucket\.org\/\$\{BITBUCKET_REPO_FULL_NAME:-\}\.git"$/m);
});

// The token reaches git through the helper pipe.sh set, which reads it from
// the environment of the git it serves: each step that fetches or pushes
// exports it from its input, and no other step does.
test('run.sh: the token is exported by the steps that fetch, push or call the API, and no other', () => {
  const exporting = [...RUN_SH.matchAll(/^(step_[a-z_]+)\(\) \{[\s\S]*?^\}$/gm)]
    .filter((match) => /export BITBUCKET_OAUTH_TOKEN="\$INPUT_BITBUCKET_OAUTH_TOKEN"/.test(match[0]))
    .map((match) => match[1])
    .sort();
  assert.deepEqual(exporting, ['step_commit_fixes', 'step_create_fix_pr', 'step_fetch_history', 'step_post_report']);
  assert.match(PIPE_SH, /credential\.https:\/\/bitbucket\.org\.helper[\s\S]*username=x-token-auth; echo "password=\$BITBUCKET_OAUTH_TOKEN"/);
  assert.equal(CODE_LINES.some((line) => /credential\.helper/.test(line)), false, 'run.sh sets no helper of its own');
});

// The credentials under their own names are taken out of the environment, and
// each step that needs one exports it from its input.
test('run.sh: the credentials leave the environment', () => {
  const line = CODE_LINES.find((text) => /^export -n /.test(text));
  assert.ok(line, 'no export -n in run.sh');
  assert.ok(RUN_SH.indexOf('\nunexport_inputs\n') < RUN_SH.indexOf(line));
  for (const name of ['IRONBEE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'BITBUCKET_OAUTH_TOKEN']) {
    assert.match(line, new RegExp(`\\b${name}\\b`), name);
  }
});

// The comment is left out when the platform publishes the run itself, judged on
// the job the report was built from: the re-verified one when it ran.
test('run.sh: the report comment reads the publication of the job the report shows', () => {
  const step = stepBody('step_post_report');
  assert.match(step, /PLATFORM_PUBLISHES="\$\{JOB_REVERIFIED_platform_publishes:-\$JOB_platform_publishes\}"/);
  // Before the API call, so an older report comment is not updated either.
  const guard = step.indexOf('"$PLATFORM_PUBLISHES" = "true"');
  assert.notEqual(guard, -1);
  assert.ok(guard < step.indexOf('bitbucket-api.js'));
});

test('run.sh: every PR_NUMBER is the pull request id', () => {
  const uses = RUN_SH.split('\n').filter((line) => /^\s*(export )?PR_NUMBER=/.test(line));
  assert.ok(uses.length > 0);
  for (const line of uses) {
    assert.match(line, /BITBUCKET_PR_ID/, line.trim());
  }
});

test('run.sh: every USER_PROMPT is the configured VERIFICATION_PROMPT', () => {
  const uses = RUN_SH.split('\n').filter((line) => /^\s*export USER_PROMPT=/.test(line));
  assert.ok(uses.length >= 3);
  for (const line of uses) {
    assert.match(line, /"\$INPUT_VERIFICATION_PROMPT"/, line.trim());
  }
});

// The gate is the last step: nothing may run after it but the exit.
test('run.sh: the gate is the last step', () => {
  const steps = [...RUN_SH.matchAll(/^\s+run_step ([a-z-]+) /gm)].map((match) => match[1]);
  assert.equal(steps[steps.length - 1], 'gate');
});
