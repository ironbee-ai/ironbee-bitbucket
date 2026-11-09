'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// run.sh is the action's steps as one bash script. Sourcing it defines its
// helpers and stops, so the translation of GitHub's machinery — step outputs,
// `success()`, the event — is tested here; the decisions themselves live in
// the Node scripts and are tested beside them, and the pipe end to end in
// pipe-sh.test.js.

const ROOT = path.join(__dirname, '..');
const RUN_SH = path.join(ROOT, 'scripts', 'run.sh');

function bash(snippet, env) {
  return execFileSync('bash', ['-c', `source "${RUN_SH}"; ${snippet}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-sh-'));
}

// ─── Step outputs ────────────────────────────────────────────────────────────

test('outputs: key=value lines come back as PREFIX_key', () => {
  const dir = tempDir();
  const file = path.join(dir, 'out');
  fs.writeFileSync(file, 'mode=platform\nconsole_url=console.ironbee.dev\nempty=\nwith_equals=a=b\n');
  const printed = bash(`read_outputs PLAN "${file}"; printf '%s|%s|%s|%s' "$PLAN_mode" "$PLAN_console_url" "$PLAN_empty" "$PLAN_with_equals"`);
  assert.equal(printed, 'platform|console.ironbee.dev||a=b');
});

test('outputs: the delimiter form keeps every line, and only those', () => {
  const dir = tempDir();
  const file = path.join(dir, 'out');
  fs.writeFileSync(file, 'before=1\ncli_args<<IRONBEE_EOF\n--project\nmy shop\n\nIRONBEE_EOF\nafter=2\n');
  const printed = bash(`read_outputs PLAN "${file}"; printf '[%s]|%s|%s' "$PLAN_cli_args" "$PLAN_before" "$PLAN_after"`);
  assert.equal(printed, '[--project\nmy shop\n]|1|2');
});

test('outputs: an empty delimited value is empty', () => {
  const dir = tempDir();
  const file = path.join(dir, 'out');
  fs.writeFileSync(file, 'cli_args<<IRONBEE_EOF\n\nIRONBEE_EOF\n');
  assert.equal(bash(`read_outputs PLAN "${file}"; printf '[%s]' "$PLAN_cli_args"`), '[]');
});

// The action's own step writes `ironbee-version`; a hyphen cannot be in a bash
// name, so it reads back with an underscore.
test('outputs: a hyphenated key reads back with an underscore', () => {
  const dir = tempDir();
  const file = path.join(dir, 'out');
  fs.writeFileSync(file, 'ironbee-version=2.1.0\n');
  assert.equal(bash(`read_outputs INSTALL_CLI "${file}"; printf '%s' "$INSTALL_CLI_ironbee_version"`), '2.1.0');
});

// A value is data a step wrote — a prompt, a title — and is never run as shell.
test('outputs: a value is read, never evaluated', () => {
  const dir = tempDir();
  const file = path.join(dir, 'out');
  const marker = path.join(dir, 'ran');
  fs.writeFileSync(file, `title=$(touch ${marker})\nprompt<<D\n\`touch ${marker}\`\nD\nbad key=x\n`);
  const printed = bash(`read_outputs X "${file}"; printf '%s' "$X_title"`);
  assert.equal(printed, `$(touch ${marker})`);
  assert.equal(fs.existsSync(marker), false);
});

test('outputs: a missing file reads as no outputs', () => {
  assert.equal(bash('read_outputs PLAN /nonexistent/file; printf "[%s]" "$PLAN_mode"'), '[]');
});

// ─── Steps ───────────────────────────────────────────────────────────────────

// GitHub's model: a failing step does not end the job; it stops the steps after
// it that are not `always()`, and the job ends red.
test('steps: a failure is recorded, and success() turns false', () => {
  const dir = tempDir();
  const printed = bash(`
    IRONBEE_STATE="${dir}"; STEP_FAILED=''
    ok() { echo "key=value" >> "$IRONBEE_OUTPUT"; }
    broken() { false; echo "never reached"; }
    run_step first "First" ok >/dev/null
    if success; then echo "after first: success"; fi
    run_step second "Second" broken >/dev/null
    if success; then echo "after second: success"; else echo "after second: failed ($STEP_FAILED)"; fi
    printf '%s|%s|%s\\n' "$FIRST_key" "$FIRST_conclusion" "$SECOND_conclusion"
  `);
  assert.match(printed, /after first: success/);
  assert.match(printed, /after second: failed \(Second\)/);
  assert.match(printed, /value\|success\|failure/);
  assert.doesNotMatch(printed, /never reached/);
});

// Each step runs as GitHub runs a `shell: bash` step: `set -eo pipefail`.
test('steps: a step body runs with errexit and pipefail', () => {
  const dir = tempDir();
  const printed = bash(`
    IRONBEE_STATE="${dir}"; STEP_FAILED=''
    piped() { false | true; echo "not reached"; }
    run_step piped "Piped" piped
    printf '[%s]' "$PIPED_conclusion"
  `);
  assert.match(printed, /\[failure\]$/);
  assert.doesNotMatch(printed, /not reached/);
});

test('steps: an `exit 0` ends the step, not the job', () => {
  const dir = tempDir();
  const printed = bash(`
    IRONBEE_STATE="${dir}"; STEP_FAILED=''
    early() { echo "done=yes" >> "$IRONBEE_OUTPUT"; exit 0; }
    run_step early "Early" early >/dev/null
    echo "still running: $EARLY_done $EARLY_conclusion"
  `);
  assert.match(printed, /still running: yes success/);
});

test('steps: each step is a header under its own name', () => {
  const dir = tempDir();
  const printed = bash(`IRONBEE_STATE="${dir}"; STEP_FAILED=''; noop() { :; }; run_step job-reverified "Read the re-verification job" noop`);
  assert.equal(printed, '\x1b[1m▶ Read the re-verification job\x1b[0m\n');
});

// A pipe's variables reach every process it starts; the action handed each step
// only what its `env:` named.
test('inputs: taken out of the environment, kept in the shell', () => {
  const printed = bash('unexport_inputs; printf "%s|" "$INPUT_BITBUCKET_OAUTH_TOKEN"; bash -c \'printf "%s" "${INPUT_BITBUCKET_OAUTH_TOKEN:-unset}"\'', {
    INPUT_BITBUCKET_OAUTH_TOKEN: 'bb-secret',
  });
  assert.equal(printed, 'bb-secret|unset');
});

// ─── The Bitbucket context ───────────────────────────────────────────────────

// Bitbucket names no event. A pull request pipeline has its pull request, and
// a `custom:` or scheduled one says what it is through EVENT_NAME.
test('context: the event is the one EVENT_NAME names, else a pull request or a push', () => {
  assert.equal(bash('bitbucket_event_name "" 12').trim(), 'merge_request');
  assert.equal(bash('bitbucket_event_name "" ""').trim(), 'push');
  assert.equal(bash('bitbucket_event_name manual ""').trim(), 'manual');
  assert.equal(bash('bitbucket_event_name schedule ""').trim(), 'schedule');
  assert.equal(bash('bitbucket_event_name push 12').trim(), 'push');
});

test('context: only a repository Bitbucket calls public is not private', () => {
  assert.equal(bash('bitbucket_repository_private false').trim(), 'false');
  assert.equal(bash('bitbucket_repository_private true').trim(), 'true');
  assert.equal(bash('bitbucket_repository_private ""').trim(), 'true');
});

// The step's uuid carries braces, which the link escapes.
test('context: the artifacts link is the step\'s page', () => {
  assert.equal(
    bash('bitbucket_step_url https://bitbucket.org ironbee/shop 41 "{8f1c-22}"').trim(),
    'https://bitbucket.org/ironbee/shop/pipelines/results/41/steps/%7B8f1c-22%7D',
  );
});

// ─── The outputs report ──────────────────────────────────────────────────────

function outputsEnv(assignments) {
  const dir = tempDir();
  bash(`IRONBEE_STATE="${dir}"; ${assignments} write_outputs_env`);
  return Object.fromEntries(
    fs.readFileSync(path.join(dir, 'outputs.env'), 'utf8').trim().split('\n').map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
}

test('outputs.env: written with every name even before anything ran', () => {
  assert.deepEqual(outputsEnv(''), {
    IRONBEE_VERDICT: '',
    IRONBEE_MODE: '',
    IRONBEE_JOB_ID: '',
    IRONBEE_JOB_URL: '',
    IRONBEE_ARTIFACTS_URL: '',
    IRONBEE_PLATFORM_PUBLISHES: 'false',
  });
});

// The action's expressions: the re-verified job's answer first, then the first.
test('outputs.env: the re-verified job wins over the first', () => {
  const env = outputsEnv(`PLAN_mode=platform JOB_verdict=fail JOB_job_id=j1 JOB_job_url=u1 JOB_platform_publishes=false
    JOB_REVERIFIED_verdict=pass JOB_REVERIFIED_job_id=j2 JOB_REVERIFIED_job_url=u2 JOB_REVERIFIED_platform_publishes=true`);
  assert.equal(env.IRONBEE_VERDICT, 'pass');
  assert.equal(env.IRONBEE_MODE, 'platform');
  assert.equal(env.IRONBEE_JOB_ID, 'j2');
  assert.equal(env.IRONBEE_JOB_URL, 'u2');
  assert.equal(env.IRONBEE_PLATFORM_PUBLISHES, 'true');
});

test('outputs.env: local mode reads the agent\'s verdict and the artifacts link', () => {
  const env = outputsEnv('PLAN_mode=local VERDICT_status=fail UPLOAD_ARTIFACTS_artifact_url=https://bitbucket.org/ironbee/shop/pipelines/results/1/steps/%7Bs%7D');
  assert.equal(env.IRONBEE_VERDICT, 'fail');
  assert.equal(env.IRONBEE_ARTIFACTS_URL, 'https://bitbucket.org/ironbee/shop/pipelines/results/1/steps/%7Bs%7D');
  assert.equal(env.IRONBEE_PLATFORM_PUBLISHES, 'false');
});

// The step's `output-variables:` are read from a file Bitbucket names; the
// lines are added to what the step wrote there itself.
test('output variables: the outputs are appended to the step\'s variables file', () => {
  const dir = tempDir();
  const variables = path.join(dir, 'pipelines-variables');
  fs.writeFileSync(variables, 'MINE=1\n');
  bash(`IRONBEE_STATE="${dir}"; PLAN_mode=platform JOB_verdict=pass write_outputs_env; write_output_variables`, {
    BITBUCKET_PIPELINES_VARIABLES_PATH: variables,
  });
  const lines = fs.readFileSync(variables, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'MINE=1');
  assert.ok(lines.includes('IRONBEE_VERDICT=pass'));
  assert.ok(lines.includes('IRONBEE_MODE=platform'));
});

test('output variables: a file the pipe cannot reach is left alone', () => {
  const dir = tempDir();
  bash(`IRONBEE_STATE="${dir}"; write_outputs_env; write_output_variables`, {
    BITBUCKET_PIPELINES_VARIABLES_PATH: path.join(dir, 'missing', 'variables'),
  });
  assert.equal(fs.existsSync(path.join(dir, 'missing')), false);
});
