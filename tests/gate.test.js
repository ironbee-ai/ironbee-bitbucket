'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { gateDecision } = require('../scripts/gate.js');

// The bug this file exists for, from a real run: the verification command
// exited 0 without creating a job, the report said "the verification did not
// produce a job", and the gate was green — because the platform branch exited
// the command's status and never looked at a verdict.

test('gate: a clean exit with no verdict fails, because nothing was verified', () => {
  const decision = gateDecision({ mode: 'platform', platformExitCode: '0', platformVerdict: '' });

  assert.equal(decision.ok, false);
  assert.match(decision.message, /produced no passing verdict/);
  assert.match(decision.message, /nothing was verified/);
});

test('gate: a clean exit with an unknown verdict fails the same way', () => {
  const decision = gateDecision({ mode: 'platform', platformExitCode: '0', platformVerdict: 'unknown' });

  assert.equal(decision.ok, false);
  assert.match(decision.message, /\(unknown\)/);
});

test('gate: a passing verdict on a clean exit is the only green platform path', () => {
  assert.deepEqual(
    gateDecision({ mode: 'platform', platformExitCode: '0', platformVerdict: 'pass' }),
    { ok: true, message: null },
  );
});

// The run looked and found nothing its harness could verify. That is an answer,
// unlike `unknown`, and it must not block a merge.
test('gate: not_applicable is an answer, and passes', () => {
  assert.equal(gateDecision({ mode: 'platform', platformExitCode: '0', platformVerdict: 'not_applicable' }).ok, true);
  assert.equal(gateDecision({ mode: 'local', localVerdict: 'not_applicable' }).ok, true);
});

test('gate: a failing verdict fails even though the command exited cleanly', () => {
  const decision = gateDecision({ mode: 'platform', platformExitCode: '0', platformVerdict: 'fail' });

  assert.equal(decision.ok, false);
});

test('gate: a non-zero exit fails on its own, and says the status', () => {
  const decision = gateDecision({ mode: 'platform', platformExitCode: '2', platformVerdict: 'pass' });

  assert.equal(decision.ok, false);
  assert.match(decision.message, /exit 2/);
});

// Absent rather than zero: the step that records the status never ran at all.
test('gate: a missing exit status means the verification never ran', () => {
  const decision = gateDecision({ mode: 'platform', platformExitCode: '', platformVerdict: 'pass' });

  assert.equal(decision.ok, false);
  assert.match(decision.message, /did not run/);
});

test('gate: local mode passes only on a verdict, never on silence', () => {
  assert.equal(gateDecision({ mode: 'local', localVerdict: 'pass' }).ok, true);
  assert.equal(gateDecision({ mode: 'local', localVerdict: 'fail' }).ok, false);
  assert.equal(gateDecision({ mode: 'local', localVerdict: 'unknown' }).ok, false);

  const silent = gateDecision({ mode: 'local', localVerdict: '' });
  assert.equal(silent.ok, false);
  assert.match(silent.message, /verdict: none/);
});
