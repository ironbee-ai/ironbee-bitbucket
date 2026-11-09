#!/usr/bin/env node

// Turns what `ironbee verify --json` printed into the action's outputs.
//
// Two shapes arrive on that stream and both can accompany a non-zero exit, so
// the exit code cannot tell them apart: a finished job (which has an `id`) and
// a failure that produced no job (which has only `error`). Everything here
// keys on that difference.

'use strict';

const fs = require('fs');
const annotations = require('./annotations.js');

/**
 * The verdict a caller can act on.
 *
 * `unknown` is not a synonym for failure. A job that never reached a verdict —
 * cancelled, timed out, killed before the agent finished — has not failed a
 * check; calling it `fail` would put a verification's name on an
 * infrastructure outcome and send someone looking for a bug that does not
 * exist.
 */
function verdictOf(job) {
  const status = job && job.result && job.result.status;
  return status === 'pass' || status === 'fail' || status === 'not_applicable' ? status : 'unknown';
}

/**
 * The console link for the run, or nothing.
 *
 * `attempt` is the run's session id and exists from the first claim, so a job
 * that failed while queued has an id and no link. Rendering the id alone there
 * is the honest answer; a link to a session that was never created is not.
 */
function consoleUrl(job, consoleHost) {
  const attempt = job && typeof job.attempt === 'string' ? job.attempt.trim() : '';
  const host = String(consoleHost || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (attempt === '' || host === '') {
    return '';
  }
  return `https://${host}/sessions/${encodeURIComponent(attempt)}`;
}

/**
 * Whether the platform publishes this run on the pull request itself.
 *
 * The answer is "is there a publication", never its status: a pending delivery
 * lands seconds after the run ends, and waiting for it would hold the runner
 * for something the action does not act on. An older API leaves the field out,
 * which means the same as null.
 */
function platformPublishes(job) {
  const publication = job && job.publication;
  return Boolean(publication && typeof publication === 'object'
    && typeof publication.provider === 'string' && publication.provider !== '');
}

/**
 * Reads the captured stdout.
 *
 * Anything unparseable is reported as such rather than guessed at: the stream
 * is either our JSON or evidence that something went wrong before the CLI could
 * write any, and inventing a shape for the second case would hide it.
 */
function parseOutput(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') {
    return { kind: 'empty' };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unparseable', text };
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
    return { kind: 'job', job: parsed };
  }
  if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') {
    return { kind: 'failure', failure: parsed.error };
  }
  return { kind: 'unparseable', text };
}

function summarize(raw, consoleHost) {
  const outcome = parseOutput(raw);

  if (outcome.kind === 'job') {
    return {
      verdict: verdictOf(outcome.job),
      jobId: typeof outcome.job.id === 'string' ? outcome.job.id : '',
      jobUrl: consoleUrl(outcome.job, consoleHost),
      failureCode: '',
      failureMessage: '',
      platformPublishes: platformPublishes(outcome.job),
      job: outcome.job,
    };
  }
  if (outcome.kind === 'failure') {
    return {
      verdict: 'unknown',
      jobId: '',
      jobUrl: '',
      // The code is what a caller branches on; the message is what a person
      // reads. A failure that never reached the API carries no code, and
      // inventing one here would put a name the service does not know into the
      // field its own answers are matched on.
      failureCode: typeof outcome.failure.code === 'string' ? outcome.failure.code : '',
      failureMessage: typeof outcome.failure.message === 'string' ? outcome.failure.message : '',
      platformPublishes: false,
      job: null,
    };
  }
  return {
    verdict: 'unknown',
    jobId: '',
    jobUrl: '',
    failureCode: '',
    failureMessage: outcome.kind === 'empty'
      ? 'the verification command produced no output'
      : 'the verification command produced output that is not a job or an error',
    platformPublishes: false,
    job: null,
  };
}

function writeOutputs(summary) {
  const body = [
    ['verdict', summary.verdict],
    ['job_id', summary.jobId],
    ['job_url', summary.jobUrl],
    ['failure_code', summary.failureCode],
    // Never empty: its readers fall back from the re-verified job to the first
    // one with `||`, and an empty value would read the wrong job's answer.
    ['platform_publishes', summary.platformPublishes ? 'true' : 'false'],
  ].map(([key, value]) => `${key}=${value}\n`).join('');

  const file = process.env.IRONBEE_OUTPUT;
  if (file) {
    fs.appendFileSync(file, body);
  } else {
    process.stdout.write(body);
  }
}

function main() {
  const [jsonPath, consoleHost] = process.argv.slice(2);
  let raw = '';
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch {
    raw = '';
  }

  const summary = summarize(raw, consoleHost);
  writeOutputs(summary);

  if (summary.job === null && summary.failureMessage !== '') {
    const code = summary.failureCode === '' ? '' : `${summary.failureCode}: `;
    annotations.error(`verification did not produce a job — ${code}${summary.failureMessage}`);
  }
}

module.exports = { summarize, verdictOf, consoleUrl, parseOutput, platformPublishes, writeOutputs };

if (require.main === module) {
  main();
}
