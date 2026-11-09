#!/usr/bin/env node

// Whether the run passes.
//
// The most consequential decision this action makes, and until now the only one
// still written in YAML-embedded shell — where it could not be tested, and where
// it was wrong: the platform branch exited the verification command's status and
// nothing else. A run whose command exited 0 without creating a job therefore
// passed. That happened. Nothing was verified, the report said so, and the gate
// was green.
//
// The rule both modes now share: a verdict is required. An exit status describes
// whether a command ran, not whether an application works, and "did not fail" is
// not the same as "passed" — the gap between them is exactly an unverified
// change being merged.

'use strict';

const annotations = require('./annotations.js');

/** Verdicts that let a run through. */
const PASSING_VERDICTS = ['pass', 'not_applicable'];

/**
 * `not_applicable` is a green light, not a missing one: the run looked and found
 * nothing its harness could verify, which is an answer. `unknown` is the absence
 * of an answer and fails, as does a verdict that never arrived.
 */
function isPassingVerdict(verdict) {
  return PASSING_VERDICTS.includes(String(verdict == null ? '' : verdict).trim());
}

/**
 * @returns {{ ok: boolean, message: string|null }} `message` is the reason to
 *   print when the gate refuses, and is null when it does not.
 */
function gateDecision({ mode, platformExitCode, platformVerdict, localVerdict }) {
  if (mode === 'platform') {
    const code = String(platformExitCode == null ? '' : platformExitCode).trim();
    // Absent, rather than zero: the step that records it never ran.
    if (code === '') {
      return { ok: false, message: 'the verification did not run' };
    }
    if (code !== '0') {
      return { ok: false, message: `verification did not pass (exit ${code})` };
    }
    // A clean exit is where the hole was. The command can end without creating
    // a job at all — a broken target, an interrupted client, a CLI that
    // declines to report why — and a status of 0 says only that nothing threw.
    if (!isPassingVerdict(platformVerdict)) {
      const named = String(platformVerdict || '').trim() || 'none';
      return {
        ok: false,
        message: `the verification exited cleanly but produced no passing verdict (${named}) — nothing was verified`,
      };
    }
    return { ok: true, message: null };
  }

  // Local mode reads the verdict the agent wrote. Same rule, reached from the
  // other side: there is no exit status to be misled by here, only the verdict.
  if (isPassingVerdict(localVerdict)) {
    return { ok: true, message: null };
  }
  const named = String(localVerdict || '').trim() || 'none';
  return { ok: false, message: `verification did not pass (verdict: ${named})` };
}

function main() {
  const decision = gateDecision({
    mode: process.env.MODE,
    platformExitCode: process.env.PLATFORM_CODE,
    platformVerdict: process.env.PLATFORM_VERDICT,
    localVerdict: process.env.LOCAL_VERDICT,
  });

  if (decision.ok) {
    return;
  }
  annotations.error(decision.message);
  process.exitCode = 1;
}

module.exports = { gateDecision, isPassingVerdict, PASSING_VERDICTS };

if (require.main === module) {
  main();
}
