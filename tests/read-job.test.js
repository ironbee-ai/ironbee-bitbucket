'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  summarize, verdictOf, consoleUrl, parseOutput, platformPublishes, writeOutputs,
} = require('../scripts/read-job.js');

const HOST = 'console.ironbee.dev';

function job(overrides) {
  return {
    id: 'job-1',
    name: 'shop preview',
    status: 'succeeded',
    attempt: 'sess-1',
    ...overrides,
  };
}

// ─── Telling the two shapes apart ────────────────────────────────────────────
//
// Both land on stdout and both can accompany a non-zero exit, so the exit code
// cannot separate them. Only the presence of `id` can.

test('parse: a job body is recognised by its id', () => {
  const parsed = parseOutput(JSON.stringify(job()));
  assert.equal(parsed.kind, 'job');
  assert.equal(parsed.job.id, 'job-1');
});

test('parse: a failure envelope is recognised by its error', () => {
  const parsed = parseOutput(JSON.stringify({ error: { code: 'QUOTA_EXCEEDED', message: 'full' } }));
  assert.equal(parsed.kind, 'failure');
  assert.equal(parsed.failure.code, 'QUOTA_EXCEEDED');
});

test('parse: empty output is its own case, not a failure with no message', () => {
  assert.equal(parseOutput('').kind, 'empty');
  assert.equal(parseOutput('   \n').kind, 'empty');
  assert.equal(parseOutput(undefined).kind, 'empty');
});

// Unparseable output is evidence that something went wrong before the CLI could
// write any, and guessing a shape for it would hide that.
test('parse: anything else is unparseable rather than guessed at', () => {
  assert.equal(parseOutput('not json').kind, 'unparseable');
  assert.equal(parseOutput('{"nothing":"useful"}').kind, 'unparseable');
  assert.equal(parseOutput('[1,2,3]').kind, 'unparseable');
  assert.equal(parseOutput('null').kind, 'unparseable');
});

// ─── The verdict ─────────────────────────────────────────────────────────────

test('verdict: each real verdict passes through', () => {
  for (const status of ['pass', 'fail', 'not_applicable']) {
    assert.equal(verdictOf(job({ result: { status } })), status);
  }
});

// A job that never reached a verdict has not failed a check. Calling it `fail`
// would put a verification's name on an infrastructure outcome.
test('verdict: a job with no result is unknown, not fail', () => {
  assert.equal(verdictOf(job({ status: 'failed', error: { type: 'deadline_exceeded' } })), 'unknown');
  assert.equal(verdictOf(job({ status: 'cancelled' })), 'unknown');
});

test('verdict: an unrecognised status is unknown', () => {
  assert.equal(verdictOf(job({ result: { status: 'weird' } })), 'unknown');
});

test('verdict: no job at all is unknown', () => {
  assert.equal(verdictOf(null), 'unknown');
  assert.equal(verdictOf(undefined), 'unknown');
});

// ─── The console link ────────────────────────────────────────────────────────

test('link: built from the attempt and the configured host', () => {
  assert.equal(consoleUrl(job(), HOST), 'https://console.ironbee.dev/sessions/sess-1');
});

test('link: the host may carry a scheme or a trailing slash', () => {
  for (const host of ['https://console.ironbee.dev', 'console.ironbee.dev/', 'https://console.ironbee.dev/']) {
    assert.equal(consoleUrl(job(), host), 'https://console.ironbee.dev/sessions/sess-1');
  }
});

// A job that failed while queued never claimed an attempt. A link to a session
// that was never created is worse than no link.
test('link: no attempt means no link', () => {
  assert.equal(consoleUrl(job({ attempt: undefined }), HOST), '');
  assert.equal(consoleUrl(job({ attempt: '' }), HOST), '');
});

test('link: no configured host means no link', () => {
  assert.equal(consoleUrl(job(), ''), '');
  assert.equal(consoleUrl(job(), undefined), '');
});

test('link: the attempt is encoded rather than spliced', () => {
  assert.equal(
    consoleUrl(job({ attempt: 'a b/c' }), HOST),
    'https://console.ironbee.dev/sessions/a%20b%2Fc',
  );
});

// ─── The summary the outputs are built from ──────────────────────────────────

test('summary: a passing job carries its verdict, id and link', () => {
  const summary = summarize(JSON.stringify(job({ result: { status: 'pass' } })), HOST);
  assert.deepEqual(
    { verdict: summary.verdict, jobId: summary.jobId, jobUrl: summary.jobUrl, failureCode: summary.failureCode },
    {
      verdict: 'pass',
      jobId: 'job-1',
      jobUrl: 'https://console.ironbee.dev/sessions/sess-1',
      failureCode: '',
    },
  );
});

test('summary: a failing job is reported as a verdict, not as an error', () => {
  const summary = summarize(JSON.stringify(job({ result: { status: 'fail', issues: ['x'] } })), HOST);
  assert.equal(summary.verdict, 'fail');
  assert.equal(summary.failureMessage, '');
  assert.notEqual(summary.job, null);
});

test('summary: a job that never claimed an attempt has an id and no link', () => {
  const summary = summarize(JSON.stringify(job({ attempt: undefined, status: 'failed' })), HOST);
  assert.equal(summary.jobId, 'job-1');
  assert.equal(summary.jobUrl, '');
});

test('summary: a failure envelope carries the code a caller branches on', () => {
  const summary = summarize(
    JSON.stringify({ error: { status: 429, code: 'CONCURRENT_LIMIT_EXCEEDED', message: 'too many' } }),
    HOST,
  );
  assert.equal(summary.verdict, 'unknown');
  assert.equal(summary.jobId, '');
  assert.equal(summary.failureCode, 'CONCURRENT_LIMIT_EXCEEDED');
  assert.equal(summary.failureMessage, 'too many');
  assert.equal(summary.job, null);
});

// A failure that never reached the API has no code, and the summary must not
// invent one — the field is matched against the service's own answers.
test('summary: a failure with no code reports the message alone', () => {
  const summary = summarize(JSON.stringify({ error: { message: '--url and --port are alternatives' } }), HOST);
  assert.equal(summary.failureCode, '');
  assert.equal(summary.failureMessage, '--url and --port are alternatives');
});

test('summary: empty output is reported as such rather than as a verdict', () => {
  const summary = summarize('', HOST);
  assert.equal(summary.verdict, 'unknown');
  assert.equal(summary.jobId, '');
  assert.match(summary.failureMessage, /no output/);
});

test('summary: unparseable output says so', () => {
  const summary = summarize('<html>504 Gateway Timeout</html>', HOST);
  assert.equal(summary.verdict, 'unknown');
  assert.match(summary.failureMessage, /not a job or an error/);
});

// ─── Whether the platform publishes the run itself ───────────────────────────
//
// Only the presence of a publication counts. An older API leaves the field out,
// which reads like null; a pending status is still a publication.

test('publication: no publication key is false', () => {
  assert.equal(summarize(JSON.stringify(job()), HOST).platformPublishes, false);
});

test('publication: null is false', () => {
  assert.equal(summarize(JSON.stringify(job({ publication: null })), HOST).platformPublishes, false);
});

test('publication: a pending publication is true', () => {
  const body = job({ publication: { provider: 'bitbucket', status: 'pending' } });
  assert.equal(summarize(JSON.stringify(body), HOST).platformPublishes, true);
});

test('publication: an object without a provider is false', () => {
  assert.equal(platformPublishes(job({ publication: {} })), false);
  assert.equal(platformPublishes(job({ publication: { provider: '' } })), false);
  assert.equal(platformPublishes(job({ publication: 'bitbucket' })), false);
});

test('publication: no job is false', () => {
  assert.equal(summarize(JSON.stringify({ error: { message: 'x' } }), HOST).platformPublishes, false);
  assert.equal(summarize('', HOST).platformPublishes, false);
});

// ─── The written outputs ─────────────────────────────────────────────────────

function writtenOutputs(summary) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-job-'));
  const file = path.join(dir, 'output');
  const previous = process.env.IRONBEE_OUTPUT;
  process.env.IRONBEE_OUTPUT = file;
  try {
    writeOutputs(summary);
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

// Never empty: the report step falls back from the re-verified job to the first
// with `||`, and an empty value would read the other job's answer.
test('outputs: platform_publishes is written as true or false', () => {
  const published = job({ publication: { provider: 'bitbucket', status: 'succeeded' } });
  assert.match(writtenOutputs(summarize(JSON.stringify(published), HOST)), /^platform_publishes=true$/m);
  assert.match(writtenOutputs(summarize(JSON.stringify(job()), HOST)), /^platform_publishes=false$/m);
  assert.match(writtenOutputs(summarize('', HOST)), /^platform_publishes=false$/m);
});
