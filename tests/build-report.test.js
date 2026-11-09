'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildPlatformReport, formatBadge, consoleHost, renderSummary } = require('../scripts/build-report.js');

const OPTIONS = { ironbeeVersion: '1.0.0', consoleUrl: 'console.ironbee.dev' };

function job(overrides) {
  return { id: 'job-1', status: 'succeeded', attempt: 'sess-1', ...overrides };
}

test('a passing job renders the badge and the console link', () => {
  const report = buildPlatformReport(job({ result: { status: 'pass', checks: ['the cart totals'] } }), OPTIONS);

  assert.match(report, /IronBee Verification Report/);
  assert.match(report, /✅ \*\*PASS\*\*/);
  assert.match(report, /https:\/\/console\.ironbee\.dev\/sessions\/sess-1/);
  assert.match(report, /- the cart totals/);
});

test('a failing job renders issues and fixes', () => {
  const report = buildPlatformReport(job({
    result: {
      status: 'fail',
      summary: 'the promo flow is broken',
      checks: ['applied a promo code'],
      issues: ['the total ignores it'],
      fixes: ['recompute the total'],
    },
  }), OPTIONS);

  assert.match(report, /❌ \*\*FAIL\*\*/);
  assert.match(report, /the promo flow is broken/);
  assert.match(report, /\*\*Issues:\*\*/);
  assert.match(report, /- the total ignores it/);
  assert.match(report, /- recompute the total/);
});

// The run that produced this verdict verifies and does not edit code, so the
// field holds remedies it recommends. A plain "Fixes" reads as "these were
// applied", on a report whose whole point is that the issues above remain.
test('the platform report calls them suggested, because nothing was applied', () => {
  const report = buildPlatformReport(job({
    result: { status: 'fail', issues: ['the total ignores it'], fixes: ['recompute the total'] },
  }), OPTIONS);

  assert.match(report, /\*\*Suggested fixes:\*\*/);
  assert.equal(/\*\*Fixes:\*\*/.test(report), false);
});

test('a not_applicable verdict is not dressed up as a pass', () => {
  const report = buildPlatformReport(job({ result: { status: 'not_applicable' } }), OPTIONS);

  assert.equal(report.includes('✅'), false);
  assert.match(report, /NOT_APPLICABLE/);
});

// A job that ended without a verdict is a different thing from one that failed
// its checks, and the report has to say which happened.
test('a job with no verdict says so, with the error that caused it', () => {
  const report = buildPlatformReport(job({
    status: 'failed',
    error: { type: 'deadline_exceeded', message: 'the run ran out of time' },
  }), OPTIONS);

  assert.match(report, /No verdict/);
  assert.match(report, /deadline_exceeded/);
  assert.match(report, /the run ran out of time/);
});

// The one failure a reader can act on from here, and the fix is a connection
// they have no way to guess at.
test('a checkout failure carries the recovery hint', () => {
  const report = buildPlatformReport(job({
    status: 'failed',
    error: { type: 'agent_error', message: 'repo checkout failed: authentication required' },
  }), OPTIONS);

  assert.match(report, /Connect its workspace to IronBee/);
  assert.match(report, /IRONBEE_BIND_REPOSITORY: false/);
});

test('an unrelated failure carries no hint', () => {
  const report = buildPlatformReport(job({
    status: 'failed',
    error: { type: 'agent_error', message: 'the agent exited' },
  }), OPTIONS);

  assert.equal(report.includes('Connect its workspace to IronBee'), false);
});

test('no job at all renders the failure instead of an empty verdict', () => {
  const report = buildPlatformReport(null, {
    ...OPTIONS,
    failureCode: 'CONCURRENT_LIMIT_EXCEEDED',
    failureMessage: 'too many verification jobs in flight',
  });

  assert.match(report, /No verification ran/);
  assert.match(report, /CONCURRENT_LIMIT_EXCEEDED/);
  assert.match(report, /too many verification jobs in flight/);
  assert.equal(report.includes('Job `'), false);
});

test('no job and no message still says what happened', () => {
  const report = buildPlatformReport(null, OPTIONS);

  assert.match(report, /did not produce a job/);
});

test('the job id is in the footer when there is one', () => {
  const report = buildPlatformReport(job({ result: { status: 'pass' } }), OPTIONS);

  assert.match(report, /Job `job-1`/);
});

// Bitbucket shows raw HTML as text, so the report is Markdown alone: the icon
// an image with no size, the session-end diagnostics under a bold heading.
test('the platform report carries no HTML, and its header icon is a Markdown image', () => {
  const report = buildPlatformReport(job({ result: { status: 'pass' } }), OPTIONS);
  assert.match(report, /^## !\[IronBee\]\(https:\/\/ironbee\.ai\/favicon\.png\) IronBee Verification Report$/m);
  assert.doesNotMatch(report, /<\/?[a-z][^>]*>/i);
});

test('the local report of a session that ended early carries no HTML', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-report-'));
  fs.writeFileSync(path.join(dir, 'claude-output.log.raw'), `${JSON.stringify({
    type: 'result', subtype: 'error_max_turns', num_turns: 100, session_id: 'sess-9',
  })}\n`);
  const report = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-report.js'), dir, '1.0.0'], {
    encoding: 'utf8',
  });
  assert.match(report, /^\*\*Session end details\*\*\n\n- \*\*Reason:\*\* Reached max turns limit/m);
  assert.match(report, /^## !\[IronBee\]\(https:\/\/ironbee\.ai\/favicon\.png\) IronBee Verification Report$/m);
  assert.doesNotMatch(report, /<\/?[a-z][^>]*>/i);
});

// The footer names the pipe a reader of the pull request can look up.
test('the footer links to this pipe', () => {
  const report = buildPlatformReport(job({ result: { status: 'pass' } }), OPTIONS);
  assert.match(report, /\[IronBee\]\(https:\/\/github\.com\/ironbee-ai\/ironbee-bitbucket\) on the IronBee platform/);
});

test('a job that never claimed an attempt renders without a link', () => {
  const report = buildPlatformReport(job({ attempt: undefined, result: { status: 'pass' } }), OPTIONS);

  assert.equal(report.includes('View session in IronBee Console'), false);
  assert.match(report, /Job `job-1`/);
});

test('an explicit job url wins over the one built from the attempt', () => {
  const report = buildPlatformReport(job({ result: { status: 'pass' } }), {
    ...OPTIONS,
    jobUrl: 'https://console.example.com/sessions/other',
  });

  assert.match(report, /https:\/\/console\.example\.com\/sessions\/other/);
});

test('a refusal marker is surfaced rather than hidden behind the verdict', () => {
  const report = buildPlatformReport(job({
    result: { status: 'pass', refused: true, reasonCode: 'narrowed_by_prompt' },
  }), OPTIONS);

  assert.match(report, /declined or narrowed/);
  assert.match(report, /narrowed_by_prompt/);
});

// ─── Shared with the local report ────────────────────────────────────────────

test('the badge is the same function both reports use', () => {
  assert.match(formatBadge('pass', 1), /✅ \*\*PASS\*\*/);
  assert.match(formatBadge('fail', 3), /❌ \*\*FAIL\*\* \(3 cycles\)/);
  assert.match(formatBadge('unknown', 1), /⚠️ \*\*UNKNOWN\*\*/);
});

test('the console host is normalised the same way for both', () => {
  assert.equal(consoleHost('https://console.ironbee.dev/'), 'console.ironbee.dev');
  assert.equal(consoleHost(''), '');
});

// ─── The summary a model sometimes escapes ───────────────────────────────────
//
// Seen live: a verdict whose summary carried the two-character sequences
// instead of the characters. Rendered as-is that is a whole document on one
// line, with visible backslashes, in a pull request comment.

test('a summary with escaped newlines is repaired', () => {
  assert.equal(renderSummary('**A**\\n- one\\n- two'), '**A**\n- one\n- two');
});

test('escaped quotes and backslashes are repaired with them', () => {
  assert.equal(renderSummary('say \\"hi\\"\\nand \\\\ too'), 'say "hi"\nand \\ too');
});

// A summary that already has newlines is left exactly as it is, so a
// legitimate `\n` inside a code sample survives.
test('a summary with real newlines is left alone', () => {
  const original = '**A**\n- a literal \\n inside a code sample';
  assert.equal(renderSummary(original), original);
});

test('a summary with neither is left alone', () => {
  assert.equal(renderSummary('one line, nothing to repair'), 'one line, nothing to repair');
});

test('the repair reaches the rendered report', () => {
  const report = buildPlatformReport(
    job({ result: { status: 'fail', summary: '**Found**\\n- the total is wrong' } }),
    OPTIONS,
  );

  assert.match(report, /\*\*Found\*\*\n- the total is wrong/);
});

// A fix round runs a second verification and the badge belongs to that one, so
// linking only it drops the session that found the issues — the one carrying
// the failing checks, the screenshots and the traces.
test('both sessions are linked when a fix round ran', () => {
  const report = buildPlatformReport(job({ result: { status: 'pass', checks: ['the order completes'] } }), {
    ...OPTIONS,
    jobUrl: 'https://console.example/sessions/second',
    earlierJobUrl: 'https://console.example/sessions/first',
  });

  assert.match(report, /\(https:\/\/console\.example\/sessions\/second\)/);
  assert.match(report, /the verification before the fix.*sessions\/first/);
});

test('a run with no fix round links one session and says nothing more', () => {
  const report = buildPlatformReport(job({ result: { status: 'pass', checks: ['the order completes'] } }), {
    ...OPTIONS,
    jobUrl: 'https://console.example/sessions/only',
    earlierJobUrl: '',
  });

  assert.equal(report.includes('the verification before the fix'), false);
});

// Guards the expression that feeds it: when no re-verification ran, both step
// outputs hold the same URL, and repeating it would read as two sessions.
test('an earlier link identical to the current one is not repeated', () => {
  const report = buildPlatformReport(job({ result: { status: 'pass', checks: ['ok'] } }), {
    ...OPTIONS,
    jobUrl: 'https://console.example/sessions/same',
    earlierJobUrl: 'https://console.example/sessions/same',
  });

  assert.equal(report.includes('the verification before the fix'), false);
});

// ─── The fix cycle a local run's commit needs ────────────────────────────────

const { parseVerdicts, hadFixCycle } = require('../scripts/build-report.js');

/**
 * A `.ironbee` with one session whose verdicts are `statuses`, in order, in the
 * main agent's file as the CLI writes them (`agents/main/actions.jsonl`), or in
 * the session-level file an older CLI wrote when `layout` is `legacy`. A status
 * may be `{ status, kind, agent, timestamp }`.
 */
function sessions(statuses, layout) {
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const dir = fsx.mkdtempSync(pathx.join(require('node:os').tmpdir(), 'cycles-'));
  const files = new Map();
  statuses.forEach((entry, index) => {
    const spec = typeof entry === 'string' ? { status: entry } : entry;
    const file = layout === 'legacy'
      ? pathx.join(dir, 'sessions', 's1', 'actions.jsonl')
      : pathx.join(dir, 'sessions', 's1', 'agents', spec.agent || 'main', 'actions.jsonl');
    const event = { type: 'verdict_write', timestamp: spec.timestamp || 1000 + index, verdict: { status: spec.status } };
    if (spec.kind) {
      event.kind = spec.kind;
    }
    files.set(file, [...(files.get(file) || ['{"type":"tool_call","timestamp":1}']), JSON.stringify(event)]);
  });
  fsx.mkdirSync(pathx.join(dir, 'sessions', 's1', 'agents', 'main'), { recursive: true });
  for (const [file, lines] of files) {
    fsx.mkdirSync(pathx.dirname(file), { recursive: true });
    fsx.writeFileSync(file, `${lines.join('\n')}\n`);
  }
  return dir;
}

function fixCycleCli(dir) {
  const script = require('node:path').join(__dirname, '..', 'scripts', 'build-report.js');
  return require('node:child_process').execFileSync('node', [script, '--fix-cycle', dir], { encoding: 'utf8' }).trim();
}

test('fix cycle: a failing verdict before the last one is one', () => {
  assert.equal(hadFixCycle(parseVerdicts(sessions(['fail', 'pass']))), true);
  assert.equal(hadFixCycle(parseVerdicts(sessions(['fail', 'fail', 'pass']))), true);
});

// A first cycle that passes fixed nothing; a lone fail never verified a fix.
// The session-level file an older CLI wrote is read too.
test('fix cycle: the legacy session-level file is read as well', () => {
  assert.equal(hadFixCycle(parseVerdicts(sessions(['fail', 'pass'], 'legacy'))), true);
  assert.equal(hadFixCycle(parseVerdicts(sessions(['pass'], 'legacy'))), false);
});

// A scenario run's verdict is for visibility: its fail is no failure a fix answered.
test('fix cycle: a scenario run\'s fail is not one', () => {
  assert.equal(hadFixCycle(parseVerdicts(sessions([{ status: 'fail', kind: 'scenario' }, 'pass']))), false);
  assert.equal(parseVerdicts(sessions([{ status: 'fail', kind: 'scenario' }, 'pass'])).length, 1);
});

// Each agent writes its own file; the verdicts are read in time order across them.
test('fix cycle: the agents\' files are merged by timestamp', () => {
  const failThenPass = sessions([{ status: 'pass', agent: 'main', timestamp: 2000 }, { status: 'fail', agent: 'verifier', timestamp: 1000 }]);
  assert.deepEqual(parseVerdicts(failThenPass).map((cycle) => cycle.verdict.status), ['fail', 'pass']);
  assert.equal(hadFixCycle(parseVerdicts(failThenPass)), true);

  const passThenFail = sessions([{ status: 'fail', agent: 'main', timestamp: 2000 }, { status: 'pass', agent: 'verifier', timestamp: 1000 }]);
  assert.equal(hadFixCycle(parseVerdicts(passThenFail)), false);
});

test('fix cycle: a pass alone, a fail alone or no verdict is none', () => {
  assert.equal(hadFixCycle(parseVerdicts(sessions(['pass']))), false);
  assert.equal(hadFixCycle(parseVerdicts(sessions(['pass', 'pass']))), false);
  assert.equal(hadFixCycle(parseVerdicts(sessions(['fail']))), false);
  assert.equal(hadFixCycle(parseVerdicts(sessions([]))), false);
});

test('last verdict: the command line names the last verdict and its session', () => {
  const script = require('node:path').join(__dirname, '..', 'scripts', 'build-report.js');
  const last = (dir) => require('node:child_process').execFileSync('node', [script, '--last-verdict', dir], { encoding: 'utf8' }).trim();
  assert.equal(last(sessions(['fail', 'pass', { status: 'fail', kind: 'scenario' }])), 'pass|s1');
  assert.equal(last('/nonexistent'), '');
});

test('fix cycle: the command line answers true or false', () => {
  assert.equal(fixCycleCli(sessions(['fail', 'pass'])), 'true');
  assert.equal(fixCycleCli(sessions(['pass'])), 'false');
  assert.equal(fixCycleCli('/nonexistent'), 'false');
});
