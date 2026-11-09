'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolvePlan,
  resolveMode,
  resolveTarget,
  resolveRepoBinding,
  isNonRoutableHost,
  timeoutFloorMinutes,
  writeOutputs,
  parseHeaders,
  emitSecretHeaderArgs,
  parseBoolean,
  resolveConsoleUrl,
  resolveCollectorUrl,
} = require('../scripts/resolve-plan.js');

/** A configuration that resolves cleanly, so each test changes one thing. */
function input(overrides) {
  return {
    ironbeeApiKey: 'ib-key',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    verificationMode: 'auto',
    repositoryPrivate: 'false',
    isFork: 'false',
    eventName: 'merge_request',
    prNumber: '42',
    sha: 'a'.repeat(40),
    beforeSha: '',
    baseUsable: 'false',
    appUrl: 'https://shop.example.com',
    appStartCommand: '',
    appPort: '3000',
    fix: 'true',
    ...overrides,
  };
}

// ─── Routability ─────────────────────────────────────────────────────────────
//
// The predicate decides whether a URL is verified directly or tunnelled, so a
// wrong answer either sends the platform at an address it cannot resolve or
// tunnels a deployment that did not need it.

test('routability: loopback and unspecified addresses are not routable', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', '0.0.0.0', '::1', '::', '[::1]']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

test('routability: private IPv4 ranges are not routable', () => {
  for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.1.1']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

test('routability: addresses just outside the private ranges are routable', () => {
  for (const host of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', '169.253.0.1']) {
    assert.equal(isNonRoutableHost(host), false, host);
  }
});

test('routability: IPv6 link-local and unique-local are not routable', () => {
  for (const host of ['fe80::1', 'fd00::1', 'fc00::1', 'FE80::1']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

test('routability: a global IPv6 address is routable', () => {
  assert.equal(isNonRoutableHost('2606:4700::1111'), false);
});

test('routability: localhost and any .localhost name are not routable', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

// The name a pipe reaches the step's Docker service by is the pipe container's
// own; the platform would resolve it to nothing.
test('routability: host.docker.internal is not routable', () => {
  for (const host of ['host.docker.internal', 'HOST.DOCKER.INTERNAL']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
  assert.equal(isNonRoutableHost('docker.internal.example.com'), false);
});

// A container name, a service alias, a bare host — all resolve only inside the
// runner's own network, and the platform is on a different one.
test('routability: a hostname with no dot is not routable', () => {
  for (const host of ['web', 'app-under-test']) {
    assert.equal(isNonRoutableHost(host), true, host);
  }
});

test('routability: an ordinary domain is routable', () => {
  for (const host of ['shop.example.com', 'preview-abc.vercel.app']) {
    assert.equal(isNonRoutableHost(host), false, host);
  }
});

test('routability: an empty host is treated as unreachable', () => {
  assert.equal(isNonRoutableHost(''), true);
  assert.equal(isNonRoutableHost(undefined), true);
});

// ─── The mode ladder ─────────────────────────────────────────────────────────

test('mode: an explicit choice wins over every signal', () => {
  for (const mode of ['local', 'platform']) {
    const resolved = resolveMode({
      verificationMode: mode,
      hasAnthropicCredential: false,
      repositoryPrivate: true,
    });
    assert.equal(resolved.mode, mode);
  }
});

test('mode: a public repository goes to the platform', () => {
  const resolved = resolveMode({
    verificationMode: 'auto',
    hasAnthropicCredential: true,
    repositoryPrivate: false,
  });
  assert.equal(resolved.mode, 'platform');
  assert.match(resolved.reason, /public/);
});

// The one case that cannot be checked for free: a private repository needs the
// IronBee app for Bitbucket, so auto prefers the engine it knows can run.
test('mode: a private repository with a credential goes local', () => {
  const resolved = resolveMode({
    verificationMode: 'auto',
    hasAnthropicCredential: true,
    repositoryPrivate: true,
  });
  assert.equal(resolved.mode, 'local');
  assert.match(resolved.reason, /VERIFICATION_MODE: platform/);
});

test('mode: a private repository with no credential goes to the platform anyway', () => {
  const resolved = resolveMode({
    verificationMode: 'auto',
    hasAnthropicCredential: false,
    repositoryPrivate: true,
  });
  assert.equal(resolved.mode, 'platform');
  assert.match(resolved.reason, /only engine/);
});

test('mode: an unknown value is an error, not a silent default', () => {
  const resolved = resolveMode({
    verificationMode: 'cloud',
    hasAnthropicCredential: true,
    repositoryPrivate: false,
  });
  assert.equal(resolved.mode, null);
  assert.match(resolved.error, /auto, local, platform/);
});

test('mode: an OAuth token counts as an Anthropic credential', () => {
  const plan = resolvePlan(input({
    repositoryPrivate: 'true',
    claudeCodeOauthToken: 'oat-token',
  }));
  assert.equal(plan.mode, 'local');
});

// ─── Targets ─────────────────────────────────────────────────────────────────

test('target: a routable APP_URL is verified directly', () => {
  const { target, errors } = resolveTarget({ appUrl: 'https://shop.example.com/', appPort: '3000' });
  assert.deepEqual(errors, []);
  assert.equal(target.kind, 'url');
  assert.equal(target.url, 'https://shop.example.com/');
});

test('target: a loopback APP_URL becomes a tunnel on the URL\'s port', () => {
  const { target } = resolveTarget({ appUrl: 'http://localhost:4000', appPort: '3000' });
  assert.equal(target.kind, 'tunnel');
  assert.equal(target.port, 4000);
  assert.equal(target.host, 'localhost');
});

// The step's Docker service publishes its ports on `host.docker.internal`, which
// the pipe bridges to its loopback — so the tunnel target carries where it answers.
test('target: host.docker.internal is a tunnel that names its host', () => {
  const { target, errors } = resolveTarget({ appUrl: 'http://host.docker.internal:4000', appPort: '' });
  assert.deepEqual(errors, []);
  assert.deepEqual(target, { kind: 'tunnel', port: 4000, host: 'host.docker.internal' });
});

test('target: a dotless APP_URL host is a tunnel that names its host', () => {
  const { target, errors } = resolveTarget({ appUrl: 'http://docker:4000', appPort: '' });
  assert.deepEqual(errors, []);
  assert.deepEqual(target, { kind: 'tunnel', port: 4000, host: 'docker' });
});

test('target: an IPv6 loopback host is named without its brackets', () => {
  const { target } = resolveTarget({ appUrl: 'http://[::1]:4000', appPort: '' });
  assert.equal(target.host, '::1');
});

test('target: a start command with no URL tunnels to localhost', () => {
  const { target } = resolveTarget({ appStartCommand: 'npm run dev', appPort: '3000' });
  assert.equal(target.host, 'localhost');
});

// Writing http://localhost means "the app", not "port 80" — starting the tunnel
// on 80 fails with a connection refused that points at nothing.
test('target: a portless loopback APP_URL falls back to APP_PORT and says so', () => {
  const { target, warnings } = resolveTarget({ appUrl: 'http://localhost', appPort: '3000' });
  assert.equal(target.kind, 'tunnel');
  assert.equal(target.port, 3000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /names no port/);
});

test('target: a start command with a port is a tunnel', () => {
  const { target } = resolveTarget({ appStartCommand: 'npm run dev', appPort: '3000' });
  assert.equal(target.kind, 'tunnel');
  assert.equal(target.port, 3000);
});

// `APP_PORT` carries a default, so "the user set it" and "nobody set it" are
// indistinguishable — refusing the pair would reject a URL written next to a
// default nobody typed. What the user did write is the URL.
test('target: when both name a port the URL wins, with a warning', () => {
  const { target, errors, warnings } = resolveTarget({
    appUrl: 'http://127.0.0.1:4000', appPort: '3001',
  });
  assert.deepEqual(errors, []);
  assert.equal(target.port, 4000);
  assert.match(warnings[0], /4000/);
  assert.match(warnings[0], /3001/);
});

test('target: two ports that agree is fine', () => {
  const { target, errors } = resolveTarget({ appUrl: 'http://localhost:3000', appPort: '3000' });
  assert.deepEqual(errors, []);
  assert.equal(target.port, 3000);
});

test('target: a portless loopback URL with no APP_PORT has nothing to tunnel to', () => {
  const { target, errors } = resolveTarget({ appUrl: 'http://localhost', appPort: '' });
  assert.equal(target, null);
  assert.match(errors[0], /nothing to tunnel to/);
});

test('target: a start command with no APP_PORT has nothing to tunnel to', () => {
  const { target, errors } = resolveTarget({ appStartCommand: 'npm run dev', appPort: '' });
  assert.equal(target, null);
  assert.match(errors[0], /nothing to tunnel to/);
});

test('target: neither input is an error that names both ways forward', () => {
  const { target, errors } = resolveTarget({ appUrl: '', appStartCommand: '', appPort: '3000' });
  assert.equal(target, null);
  assert.match(errors[0], /APP_URL/);
  assert.match(errors[0], /APP_START_COMMAND/);
});

test('target: a malformed URL is rejected as one', () => {
  const { target, errors } = resolveTarget({ appUrl: 'not a url', appPort: '3000' });
  assert.equal(target, null);
  assert.match(errors[0], /not a URL/);
});

test('target: a non-http scheme is rejected', () => {
  const { target, errors } = resolveTarget({ appUrl: 'ftp://shop.example.com', appPort: '3000' });
  assert.equal(target, null);
  assert.match(errors[0], /http or https/);
});

test('target: a non-numeric APP_PORT is rejected', () => {
  const { errors } = resolveTarget({ appStartCommand: 'npm run dev', appPort: 'three thousand' });
  assert.match(errors[0], /positive integer/);
});

// ─── Repository binding ──────────────────────────────────────────────────────

test('binding: a pull request binds by number', () => {
  assert.deepEqual(
    resolveRepoBinding({ eventName: 'merge_request', prNumber: '42', sha: 'a'.repeat(40) }),
    ['--pr', '42'],
  );
});

test('binding: a pull request with no number falls back rather than guessing', () => {
  assert.deepEqual(
    resolveRepoBinding({ eventName: 'merge_request', prNumber: '', sha: 'a'.repeat(40), parentSha: 'c'.repeat(40) }),
    ['--commit', 'a'.repeat(40), '--base', 'c'.repeat(40)],
  );
});

test('binding: a push with a usable base measures from it', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push', sha: 'a'.repeat(40), beforeSha: 'b'.repeat(40), baseUsable: true,
    }),
    ['--commit', 'a'.repeat(40), '--base', 'b'.repeat(40)],
  );
});

// The first push of a branch reports an all-zero SHA, and a force-push can name
// one this checkout does not have. Both are forty hex characters and would pass
// every shape check on the way to failing at the platform's own checkout.
test('binding: a push with an unusable base falls back to the commit parent', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: '0'.repeat(40),
      baseUsable: false,
      parentSha: 'c'.repeat(40),
    }),
    ['--commit', 'a'.repeat(40), '--base', 'c'.repeat(40)],
  );
});

// Only with nothing left to measure from — a repository's first commit.
test('binding: a push with no usable base and no parent declares no changeset', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push', sha: 'a'.repeat(40), beforeSha: '0'.repeat(40), baseUsable: false, parentSha: '',
    }),
    ['--commit', 'a'.repeat(40), '--no-diff'],
  );
});

// A push can carry several commits and only `before` spans all of them, so the
// parent must never win over a usable base — it would silently narrow the
// changeset to the last commit of the push.
test('binding: a usable base outranks the parent', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: 'b'.repeat(40),
      baseUsable: true,
      parentSha: 'c'.repeat(40),
    }),
    ['--commit', 'a'.repeat(40), '--base', 'b'.repeat(40)],
  );
});

// A dispatch is nearly always a push being re-run — with fixing off, in local
// mode, after a configuration change — and a run with no changeset answers a
// different question than the one it repeats, invisibly.
test('binding: a manual or scheduled run measures from the commit parent', () => {
  for (const eventName of ['manual', 'schedule']) {
    assert.deepEqual(
      resolveRepoBinding({ eventName, sha: 'a'.repeat(40), parentSha: 'c'.repeat(40) }),
      ['--commit', 'a'.repeat(40), '--base', 'c'.repeat(40)],
    );
  }
});

test('binding: a manual run with no parent still binds the commit', () => {
  assert.deepEqual(
    resolveRepoBinding({ eventName: 'manual', sha: 'a'.repeat(40), parentSha: '' }),
    ['--commit', 'a'.repeat(40), '--no-diff'],
  );
});

// A private repository the connection does not cover fails at the agent's front
// door with nothing verified; unbinding it verifies the application instead.
test('binding: turning it off declares no repository at all', () => {
  assert.deepEqual(
    resolveRepoBinding({ bind: false, eventName: 'merge_request', prNumber: '42', sha: 'a'.repeat(40) }),
    ['--no-repo'],
  );
});

test('plan: bind_repository=false reaches the CLI', () => {
  const plan = resolvePlan(input({ bindRepository: 'false' }));
  assert.equal(plan.ok, true);
  assert.ok(plan.cliArgs.includes('--no-repo'));
  assert.equal(plan.cliArgs.includes('--pr'), false);
});

test('plan: bind_repository defaults to binding', () => {
  assert.ok(resolvePlan(input()).cliArgs.includes('--pr'));
});

test('binding: nothing to bind produces no flags', () => {
  assert.deepEqual(resolveRepoBinding({ eventName: 'push', sha: '' }), []);
});

// ─── The whole plan ──────────────────────────────────────────────────────────

test('plan: a public repo with a URL resolves to a platform run', () => {
  const plan = resolvePlan(input());
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'platform');
  assert.equal(plan.needsApp, false);
  assert.deepEqual(plan.cliArgs.slice(0, 2), ['--url', 'https://shop.example.com/']);
  assert.ok(plan.cliArgs.includes('--json'));
  assert.deepEqual(plan.cliArgs.slice(-3, -1), ['--pr', '42']);
});

test('plan: a missing IronBee key is an error', () => {
  const plan = resolvePlan(input({ ironbeeApiKey: '' }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /IRONBEE_API_KEY is required/);
});

// A fork PR has no credential either engine may run with. Naming the fork is
// what stops it reading as a pipeline that forgot to set its key.
test('plan: a fork pull request is refused by its own cause', () => {
  const plan = resolvePlan(input({ isFork: 'true' }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /fork/);
});

// Both places a fork's pipeline can run, in one sentence: in this repository it
// would hold this repository's credentials, and in the fork it has none.
test('plan: the fork refusal names both reasons', () => {
  const plan = resolvePlan(input({ isFork: 'true' }));
  assert.match(plan.errors.join(' '), /must not run with this repository's credentials/);
  assert.match(plan.errors.join(' '), /fork's own pipeline has none to run with/);
});

test('plan: local mode without an Anthropic credential is an error', () => {
  const plan = resolvePlan(input({ verificationMode: 'local' }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/);
});

test('plan: local mode with a credential is fine and starts no CLI run', () => {
  const plan = resolvePlan(input({ verificationMode: 'local', anthropicApiKey: 'sk-ant' }));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.cliArgs, []);
});

test('plan: a tunnel target asks for the application to be started', () => {
  const plan = resolvePlan(input({ appUrl: '', appStartCommand: 'npm run dev', appPort: '3000' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.needsApp, true);
  assert.deepEqual(plan.cliArgs.slice(0, 2), ['--port', '3000']);
});

// In local mode the agent starts the application itself, from the start command
// in its prompt. Starting it here too would put two of them on one port.
test('plan: local mode never asks the action to start the application', () => {
  const plan = resolvePlan(input({
    verificationMode: 'local',
    anthropicApiKey: 'sk-ant',
    appUrl: 'http://localhost:3000',
    appStartCommand: 'npm run dev',
  }));
  assert.equal(plan.ok, true);
  assert.equal(plan.needsApp, false);
});

test('plan: APP_WAIT_SECONDS reaches the CLI only when set', () => {
  const withWait = resolvePlan(input({
    appUrl: '', appStartCommand: 'npm run dev', appPort: '3000', appWaitSeconds: '180',
  }));
  assert.ok(withWait.cliArgs.includes('--app-wait'));
  assert.equal(withWait.cliArgs[withWait.cliArgs.indexOf('--app-wait') + 1], '180');

  const withoutWait = resolvePlan(input({ appUrl: '', appStartCommand: 'npm run dev', appPort: '3000' }));
  assert.equal(withoutWait.cliArgs.includes('--app-wait'), false);
});

test('plan: headers are refused for a tunnel target', () => {
  const plan = resolvePlan(input({
    appUrl: '', appStartCommand: 'npm run dev', appPort: '3000', headers: 'X-E2E: 1',
  }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /deployed URL only/);
});

test('plan: the job timeout reaches the CLI in seconds', () => {
  const plan = resolvePlan(input({ jobTimeoutMinutes: '30' }));
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--timeout') + 1], '1800');
});

test('plan: an explicit project overrides the derived one', () => {
  const plan = resolvePlan(input({ project: 'shop' }));
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--project') + 1], 'shop');
});

test('plan: the environment reaches the CLI by name', () => {
  const plan = resolvePlan(input({ environment: 'staging' }));
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--environment') + 1], 'staging');
});

// No environment means the project-wide variables and secrets alone. The CLI
// must not be handed an empty name — the service would create one called "".
test('plan: no environment sends no --environment', () => {
  const plan = resolvePlan(input({ environment: '' }));
  assert.equal(plan.cliArgs.includes('--environment'), false);
});

// These configure the agent that runs on the runner. In platform mode it does
// not run, so a workflow carrying them is describing something that is not
// happening — and silence would let it keep believing so.
test('plan: local-only inputs warn in platform mode', () => {
  const plan = resolvePlan(input({ model: 'claude-sonnet-5', maxTurns: '50' }));
  assert.equal(plan.ok, true);
  assert.match(plan.warnings.join(' '), /CLAUDE_CODE_MODEL/);
  assert.match(plan.warnings.join(' '), /CLAUDE_CODE_MAX_TURNS/);
});

test('plan: local-only inputs are silent in local mode', () => {
  const plan = resolvePlan(input({
    verificationMode: 'local', anthropicApiKey: 'sk-ant', model: 'claude-sonnet-5',
  }));
  assert.deepEqual(plan.warnings, []);
});

// An input with a default is always present, so presence cannot mean "the
// author chose it". Testing presence put every defaulted input in the warning
// on every platform run, which trains the reader to skip the line the one time
// it names something they typed.
test('plan: an input left at its declared default warns about nothing', () => {
  const plan = resolvePlan(input({
    maxTurns: '100',
    browserDevtools: 'true',
    backendDevtools: 'false',
    nodeDevtools: 'false',
    pythonDevtools: 'false',
    terminalDevtools: 'false',
  }));
  assert.equal(plan.mode, 'platform');
  assert.equal(plan.warnings.join(' ').includes('do nothing in platform mode'), false);
});

test('plan: a devtools flag moved off its default warns in platform mode', () => {
  const plan = resolvePlan(input({ pythonDevtools: 'true', terminalDevtools: 'true' }));
  assert.match(plan.warnings.join(' '), /IRONBEE_PYTHON_DEVTOOLS/);
  assert.match(plan.warnings.join(' '), /IRONBEE_TERMINAL_DEVTOOLS/);
});

// The mirror image, and worth the same warning: "I set a job timeout and the
// run ignored it" is exactly as confusing as "I set a model and the run
// ignored it".
test('plan: platform-only inputs warn in local mode', () => {
  const plan = resolvePlan(input({
    verificationMode: 'local',
    anthropicApiKey: 'sk-ant',
    jobTimeoutMinutes: '30',
    project: 'shop',
    headers: 'X-Marker: one',
    bindRepository: 'false',
    appRestartCommand: 'docker compose up -d --build',
    appLogsCommand: 'docker compose logs',
  }));
  assert.equal(plan.ok, true);
  const text = plan.warnings.join(' ');
  assert.match(text, /do nothing in local mode/);
  assert.match(text, /IRONBEE_JOB_TIMEOUT_MINUTES/);
  assert.match(text, /IRONBEE_PROJECT/);
  assert.match(text, /APP_HEADERS/);
  assert.match(text, /IRONBEE_BIND_REPOSITORY/);
  assert.match(text, /APP_RESTART_COMMAND/);
  assert.match(text, /APP_LOGS_COMMAND/);
});

test('plan: platform-only inputs are silent in platform mode', () => {
  const plan = resolvePlan(input({ jobTimeoutMinutes: '30', project: 'shop' }));
  assert.equal(plan.warnings.join(' ').includes('do nothing in local mode'), false);
});

// ─── Booleans ────────────────────────────────────────────────────────────────
//
// A pipe variable has no type — Bitbucket validates nothing and hands the pipe a
// string — so an unrecognised one is named here or it is named nowhere.

test('boolean: the accepted spellings all resolve', () => {
  const errors = [];
  for (const yes of ['true', 'TRUE', ' 1 ', 'yes', 'on']) {
    assert.equal(parseBoolean('flag', yes, false, errors), true, yes);
  }
  for (const no of ['false', 'FALSE', '0', 'no', 'off']) {
    assert.equal(parseBoolean('flag', no, true, errors), false, no);
  }
  assert.deepEqual(errors, []);
});

// Empty is the declared default arriving through an expression that resolved to
// nothing, not a value someone chose.
test('boolean: empty takes the declared default without complaining', () => {
  const errors = [];
  assert.equal(parseBoolean('flag', '', true, errors), true);
  assert.equal(parseBoolean('flag', undefined, false, errors), false);
  assert.deepEqual(errors, []);
});

test('boolean: an unrecognised value is named, not read as false', () => {
  const errors = [];
  parseBoolean('fix', 'flase', true, errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /fix must be true or false/);
  assert.match(errors[0], /flase/);
  assert.match(errors[0], /yes/);
});

// The failure this exists to stop: fixing silently off on every run, with no
// symptom but a feature that never happens.
test('plan: a mistyped fix fails the run instead of disabling fixing', () => {
  const plan = resolvePlan(input({ anthropicApiKey: 'sk-ant', fix: 'flase' }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /VERIFICATION_APPLY_FIX must be true or false/);
});

test('plan: a mistyped boolean is named for every input that takes one', () => {
  const plan = resolvePlan(input({
    bindRepository: 'nope',
    nodeDevtools: 'enable',
    verbose: 'loud',
    excludeFiles: 'sure',
  }));
  assert.equal(plan.ok, false);
  const text = plan.errors.join(' ');
  for (const name of ['IRONBEE_BIND_REPOSITORY', 'IRONBEE_NODE_DEVTOOLS', 'VERBOSE', 'IRONBEE_EXCLUDE_FILES']) {
    assert.match(text, new RegExp(name));
  }
});

test('plan: a synonym reaches the decision it configures', () => {
  const off = resolvePlan(input({ verificationMode: 'platform', bindRepository: 'off' }));
  assert.equal(off.cliArgs.includes('--no-repo'), true);
  const on = resolvePlan(input({ verificationMode: 'platform', bindRepository: 'on' }));
  assert.equal(on.cliArgs.includes('--no-repo'), false);
});

// Normalised once here and read back as step outputs, so a step's own `if:`
// cannot apply a narrower vocabulary than the one this file accepts.
test('plan: verbose and exclude_files come back normalised', () => {
  const on = resolvePlan(input({ verbose: 'yes', excludeFiles: 'ON' }));
  assert.equal(on.verbose, true);
  assert.equal(on.excludeFiles, true);

  const off = resolvePlan(input({ verbose: 'NO', excludeFiles: 'off' }));
  assert.equal(off.verbose, false);
  assert.equal(off.excludeFiles, false);

  // Unset lands on each one's own declared default, which they do not share.
  const unset = resolvePlan(input({}));
  assert.equal(unset.verbose, false);
  assert.equal(unset.excludeFiles, true);
});

// Gate-only is a legitimate configuration: the verification still runs and
// still decides the merge. Saying so is what stops it reading as broken.
test('plan: fix without a credential degrades to gate-only with a warning', () => {
  const plan = resolvePlan(input({ fix: 'true' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.canFix, false);
  assert.match(plan.warnings.join(' '), /fix nothing/);
});

test('plan: fix with a credential is allowed in platform mode', () => {
  const plan = resolvePlan(input({ anthropicApiKey: 'sk-ant', repositoryPrivate: 'false' }));
  assert.equal(plan.mode, 'platform');
  assert.equal(plan.canFix, true);
});

test('plan: fix disabled turns the fix round off', () => {
  const plan = resolvePlan(input({ anthropicApiKey: 'sk-ant', fix: 'false' }));
  assert.equal(plan.canFix, false);
});

// ─── The budget floor ────────────────────────────────────────────────────────

test('floor: the default job timeout produces a floor above the queue wait', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '' }), 15 + 60 + 10);
});

// A fix round runs a second verification against the repaired application, and
// counting only the first understated the floor by a whole job timeout — on the
// one path that needs the most.
test('floor: a run that can fix budgets for both verifications', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '45', verifications: 1 }), 15 + 45 + 10);
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '45', verifications: 2 }), 15 + 90 + 10);
});

test('plan: the floor covers the re-verification when one can happen', () => {
  const canFix = resolvePlan(input({
    verificationMode: 'platform',
    anthropicApiKey: 'sk-ant',
    appUrl: '',
    appStartCommand: 'npm start',
    appPort: '4000',
    jobTimeoutMinutes: '45',
  }));
  assert.equal(canFix.needsApp, true);
  assert.equal(canFix.timeoutFloorMinutes, 15 + 90 + 10);

  // A deployed URL is never restarted, so no second verification is possible.
  const deployed = resolvePlan(input({
    verificationMode: 'platform',
    anthropicApiKey: 'sk-ant',
    jobTimeoutMinutes: '45',
  }));
  assert.equal(deployed.needsApp, false);
  assert.equal(deployed.timeoutFloorMinutes, 15 + 45 + 10);
});

test('floor: an explicit job timeout is what the floor is built from', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '30' }), 15 + 30 + 10);
});

test('floor: a nonsense timeout falls back rather than producing a nonsense floor', () => {
  assert.equal(timeoutFloorMinutes({ jobTimeoutMinutes: '-5' }), 15 + 60 + 10);
});

// ─── Headers ─────────────────────────────────────────────────────────────────

test('headers: one per line, in the shape the CLI takes', () => {
  assert.deepEqual(parseHeaders('X-E2E: 1\nX-Trace: abc'), ['X-E2E: 1', 'X-Trace: abc']);
});

test('headers: blank lines, comments and lines without a colon are dropped', () => {
  assert.deepEqual(
    parseHeaders('\n  \n# a comment\nnot-a-header\nX-E2E: 1\n'),
    ['X-E2E: 1'],
  );
});

test('headers: nothing configured produces nothing', () => {
  assert.deepEqual(parseHeaders(''), []);
  assert.deepEqual(parseHeaders(undefined), []);
});

test('plan: headers reach the CLI for a URL target', () => {
  const plan = resolvePlan(input({ headers: 'X-E2E: 1' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--header') + 1], 'X-E2E: 1');
});

// A step output is a file on the runner that outlives the step. The secret
// half is emitted on demand instead, straight into the step that runs the
// command — so it must not appear here.
test('plan: secret headers never reach the step output', () => {
  const plan = resolvePlan(input({ headers: 'X-E2E: 1', secretHeaders: 'X-Bypass: the-secret' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.cliArgs[plan.cliArgs.indexOf('--header') + 1], 'X-E2E: 1');
  assert.equal(plan.cliArgs.includes('--secret-header'), false);
  assert.equal(plan.cliArgs.join(' ').includes('the-secret'), false);
});

test('emitSecretHeaderArgs: one flag and value per configured header', () => {
  const written = [];
  const realWrite = process.stdout.write;
  process.env.INPUT_APP_SECRET_HEADERS = 'X-Bypass: the-secret\nX-Token: another';
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    emitSecretHeaderArgs();
  } finally {
    process.stdout.write = realWrite;
    delete process.env.INPUT_APP_SECRET_HEADERS;
  }

  assert.deepEqual(written.join('').trim().split('\n'), [
    '--secret-header', 'X-Bypass: the-secret',
    '--secret-header', 'X-Token: another',
  ]);
});

test('emitSecretHeaderArgs: writes nothing when none are configured', () => {
  const written = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    emitSecretHeaderArgs();
  } finally {
    process.stdout.write = realWrite;
  }

  assert.equal(written.join(''), '');
});

test('plan: secret headers are refused for a tunnel target too', () => {
  const plan = resolvePlan(input({
    appUrl: '', appStartCommand: 'npm run dev', appPort: '3000', secretHeaders: 'X-Bypass: s',
  }));
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(' '), /deployed URL only/);
});

// ─── The console the report links into ───────────────────────────────────────
//
// The failure this prevents: a workflow that names only its collector — the one
// setting a non-production stage cannot omit — writes its events to that stage
// and builds every report link into production. Each link 404s, and the report
// is what looks broken.

test('console: an explicit host wins over anything derivable', () => {
  assert.equal(
    resolveConsoleUrl({ consoleUrl: 'console.internal', collectorUrl: 'https://collector.service.ironbee.dev' }),
    'console.internal',
  );
});

test('console: an unset host follows the collector to its stage', () => {
  assert.equal(
    resolveConsoleUrl({ consoleUrl: '', collectorUrl: 'https://collector.service.ironbee.dev' }),
    'console.ironbee.dev',
  );
  assert.equal(
    resolveConsoleUrl({ consoleUrl: '  ', collectorUrl: 'https://collector.service.ironbee.us' }),
    'console.ironbee.us',
  );
});

// A collector that is not one of ours says nothing about which console to use,
// and neither does no collector at all.
test('console: an unrecognisable collector falls back to the default host', () => {
  assert.equal(resolveConsoleUrl({ consoleUrl: '', collectorUrl: '' }), 'console.ironbee.ai');
  assert.equal(
    resolveConsoleUrl({ consoleUrl: '', collectorUrl: 'https://collect.example.com' }),
    'console.ironbee.ai',
  );
  assert.equal(
    resolveConsoleUrl({ consoleUrl: '', collectorUrl: 'not a url' }),
    'console.ironbee.ai',
  );
});

test('plan: the derived console host is on the plan', () => {
  const plan = resolvePlan(input({ collectorUrl: 'https://collector.service.ironbee.dev' }));
  assert.equal(plan.consoleUrl, 'console.ironbee.dev');
});

// ─── APP_PORT carries no default ─────────────────────────────────────────────
//
// It used to default to 3000, and the default was indistinguishable from a
// port someone typed — the same defect the unused-input warnings had. Two
// things follow, and both are the point of removing it.

// Before: `APP_URL: http://localhost:4000` with nobody touching APP_PORT still
// compared 4000 against the default 3000 and warned about a disagreement
// between the user and themselves, on every single run.
test('port: a URL port alone warns about nothing', () => {
  const result = resolveTarget({ appUrl: 'http://localhost:4000', appStartCommand: 'x', appPort: '' });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.target, { kind: 'tunnel', port: 4000, host: 'localhost' });
});

// Before: this tunnelled to 3000 silently. An application on any other port
// then failed with a connection refused deep inside the run, where nothing
// points back at the port being wrong.
test('port: a start command with no port is refused up front', () => {
  const result = resolveTarget({ appUrl: '', appStartCommand: 'npm start', appPort: '' });
  assert.equal(result.target, null);
  assert.match(result.errors.join(' '), /APP_START_COMMAND is set but APP_PORT is not/);
});

test('port: a portless localhost URL is refused up front', () => {
  const result = resolveTarget({ appUrl: 'http://localhost', appStartCommand: '', appPort: '' });
  assert.equal(result.target, null);
  assert.match(result.errors.join(' '), /APP_URL has no port and APP_PORT is not set/);
});

// The warning now means what it says: both were written, and they disagree.
test('port: a real disagreement still warns, and the URL still wins', () => {
  const result = resolveTarget({ appUrl: 'http://localhost:4000', appStartCommand: '', appPort: '3000' });
  assert.deepEqual(result.target, { kind: 'tunnel', port: 4000, host: 'localhost' });
  assert.match(result.warnings.join(' '), /APP_URL names port 4000 and APP_PORT is 3000/);
});

// ─── An empty changeset is the base being wrong ──────────────────────────────
//
// The other half of the re-push loop. When some ref still holds the old tip —
// a fix PR branch opened by an earlier failing run does exactly that — the
// event's base resolves fine and measures a rewrite that changed no content, so
// the diff comes back empty and the run has nothing to review. Detectable, so
// no input has to ask which base was meant.

test('binding: a base that resolves to the same content falls back to the parent', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: 'b'.repeat(40),
      baseUsable: true,
      baseEmpty: true,
      parentSha: 'c'.repeat(40),
    }),
    ['--commit', 'a'.repeat(40), '--base', 'c'.repeat(40)],
  );
});

// Nothing is traded away by the fallback: the parent is strictly more to review
// than an empty diff. But a base that does say something must still win, or a
// multi-commit push silently narrows to its tip.
test('binding: a base with real content still outranks the parent', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: 'b'.repeat(40),
      baseUsable: true,
      baseEmpty: false,
      parentSha: 'c'.repeat(40),
    }),
    ['--commit', 'a'.repeat(40), '--base', 'b'.repeat(40)],
  );
});

test('binding: an empty base with no parent declares no changeset', () => {
  assert.deepEqual(
    resolveRepoBinding({
      eventName: 'push',
      sha: 'a'.repeat(40),
      beforeSha: 'b'.repeat(40),
      baseUsable: true,
      baseEmpty: true,
      parentSha: '',
    }),
    ['--commit', 'a'.repeat(40), '--no-diff'],
  );
});

// ─── VERIFICATION_AUTO ───────────────────────────────────────────────────────
//
// Off means "verify only when somebody asks". What it cannot mean is "do not
// start": the caller's own steps have run before this action's first one, which
// is why the input is a convenience and the job-level `if:` is the saving.

test('plan: auto off skips a push, with no error and no mode', () => {
  const plan = resolvePlan(input({ eventName: 'push', auto: 'false' }));

  assert.equal(plan.skipped, true);
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, null);
  assert.deepEqual(plan.errors, []);
});

test('plan: auto off skips a pull request too', () => {
  assert.equal(resolvePlan(input({ eventName: 'merge_request', auto: 'false' })).skipped, true);
});

// The one a person asked for by name. A `custom:` pipeline run by hand is
// somebody pressing a button — not "automatic".
test('plan: auto off still runs a manual pipeline', () => {
  for (const eventName of ['manual']) {
    const plan = resolvePlan(input({ eventName, auto: 'false' }));
    assert.notEqual(plan.skipped, true, eventName);
    assert.equal(plan.mode, 'platform', eventName);
  }
});

test('plan: auto on is the default and changes nothing', () => {
  assert.notEqual(resolvePlan(input({ eventName: 'push' })).skipped, true);
});

// A run that is not going to happen must not also complain about how it was
// configured: the skip is decided before any credential is required, so a
// repository that switched verification off does not get a red run telling it
// the key it deliberately never set is missing.
test('plan: a skipped run reports no configuration errors', () => {
  const plan = resolvePlan(input({ eventName: 'push', auto: 'false', ironbeeApiKey: '', appUrl: '' }));

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.errors, []);
});

// ─── The collector handed to the application ─────────────────────────────────

test('resolveCollectorUrl: an explicit collector is handed over as named', () => {
  assert.equal(
    resolveCollectorUrl({ collectorUrl: ' https://collector.service.ironbee.dev ' }),
    'https://collector.service.ironbee.dev',
  );
});

test('resolveCollectorUrl: an empty collector resolves to the default stage, not to nothing', () => {
  assert.equal(resolveCollectorUrl({ collectorUrl: '' }), 'https://collector.service.ironbee.ai');
  assert.equal(resolveCollectorUrl({ collectorUrl: undefined }), 'https://collector.service.ironbee.ai');
});

test('plan: the collector the application reports to names the same stage as the console', () => {
  const plan = resolvePlan(input({ collectorUrl: 'https://collector.service.ironbee.dev' }));
  assert.equal(plan.collectorUrl, 'https://collector.service.ironbee.dev');
  assert.equal(plan.consoleUrl, 'console.ironbee.dev');
});

// ─── The written outputs ─────────────────────────────────────────────────────

function writtenOutputs(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-plan-'));
  const file = path.join(dir, 'output');
  const previous = process.env.IRONBEE_OUTPUT;
  process.env.IRONBEE_OUTPUT = file;
  try {
    writeOutputs(plan);
    return fs.readFileSync(file, 'utf8');
  } finally {
    if (previous === undefined) {
      delete process.env.IRONBEE_OUTPUT;
    } else {
      process.env.IRONBEE_OUTPUT = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// run.sh bridges a non-loopback host to 127.0.0.1, and reads where from here.
test('outputs: target_host names where a tunnel target answers', () => {
  const docker = resolvePlan(input({ appUrl: 'http://host.docker.internal:4000', appStartCommand: 'docker compose up -d' }));
  assert.match(writtenOutputs(docker), /^target_host=host\.docker\.internal$/m);
  assert.match(writtenOutputs(docker), /^target_port=4000$/m);

  const local = resolvePlan(input({ appUrl: '', appStartCommand: 'npm start', appPort: '3000' }));
  assert.match(writtenOutputs(local), /^target_host=localhost$/m);

  const deployed = resolvePlan(input());
  assert.match(writtenOutputs(deployed), /^target_host=$/m);
});

test('outputs: cli_args is one argument per line in the delimiter form', () => {
  const text = writtenOutputs(resolvePlan(input({ project: 'my shop' })));
  assert.match(text, /^cli_args<<IRONBEE_EOF\n/m);
  assert.match(text, /^my shop$/m);
  assert.match(text, /\nIRONBEE_EOF\n$/);
});
