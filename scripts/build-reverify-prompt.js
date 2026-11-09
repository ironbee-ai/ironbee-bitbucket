#!/usr/bin/env node

// The prompt the re-verification runs with.
//
// It exists because the second run reads a repository that does not contain the
// fixes. They were made on this runner and pushed nowhere, so the commit the run
// binds to still holds the original code — and an agent that reads it finds the
// bug it was asked to confirm gone, states it confidently, and fails the run
// over source that is no longer what the application is executing. That happened
// on a real run: the fix was correct, the rebuilt container was serving it, and
// the verdict quoted the unfixed line.
//
// So the fixes are carried as the agent's own account of them, not as a patch.
// A diff of the working tree would spend the whole budget restating code the
// run cannot act on anyway, while what actually changes the second run's
// behaviour is knowing *that* those areas were repaired and that the source on
// disk is stale.

'use strict';

const fs = require('fs');

/**
 * The API's cap on a job prompt. Mirrored rather than imported — this
 * repository has no dependencies — and deliberately conservative: overshooting
 * it is a 400 at create time, which loses the re-verification entirely rather
 * than degrading it.
 */
const PROMPT_MAX_CHARS = 4000;

/** Below this, a fix note is too clipped to tell the agent anything useful. */
const MIN_SUMMARY_CHARS = 200;

const HEADER = [
  'Fixes have already been applied to the running application since the first',
  'verification. They were made on the machine that started the application and',
  'were NOT pushed, so the repository at this commit still contains the original',
  'code: reading the source will show the problems as unfixed. Judge the',
  'application by its behaviour, and treat the source as out of date wherever it',
  'disagrees with what the running application does.',
  '',
  'What was fixed, in the words of whoever fixed it:',
].join('\n');

const TRUNCATION_MARKER = '\n[…truncated]';

/**
 * Trims to a budget on a line boundary, so the note never ends mid-sentence in
 * a way that inverts its meaning ("this was not" / "this was not fixed").
 *
 * The marker is charged to the budget rather than added after it. Appending it
 * to an already-full clip is how a function that exists to respect a cap
 * returns something over it — and over this particular cap is a 400 at create
 * time, which loses the re-verification rather than shortening it.
 */
function clip(text, budget) {
  const trimmed = String(text).trim();
  if (trimmed.length <= budget) {
    return trimmed;
  }
  const room = budget - TRUNCATION_MARKER.length;
  if (room <= 0) {
    return '';
  }
  const cut = trimmed.slice(0, room);
  const lastBreak = cut.lastIndexOf('\n');
  const body = lastBreak > room / 2 ? cut.slice(0, lastBreak) : cut;
  return `${body.trimEnd()}${TRUNCATION_MARKER}`;
}

/**
 * The caller's own prompt keeps its full length, and the fix note takes what is
 * left. That order is deliberate: the caller's prompt was accepted by the first
 * verification, so clipping it here would make the second run answer a narrower
 * question than the first — a difference in the verdict that nothing in the
 * report would explain.
 *
 * With no room left the note is dropped rather than squeezed, which is the
 * behaviour the action had before this existed.
 */
function buildReverifyPrompt({ userPrompt, fixSummary }) {
  const user = String(userPrompt == null ? '' : userPrompt).trim();
  const summary = String(fixSummary == null ? '' : fixSummary).trim();

  if (summary.length === 0) {
    return user;
  }

  const separator = user.length > 0 ? '\n\n' : '';
  const budget = PROMPT_MAX_CHARS - user.length - separator.length - HEADER.length - 1;
  if (budget < MIN_SUMMARY_CHARS) {
    return user;
  }

  return `${user}${separator}${HEADER}\n${clip(summary, budget)}`;
}

function main() {
  const [, , summaryPath, outPath] = process.argv;
  const fixSummary = summaryPath && fs.existsSync(summaryPath)
    ? fs.readFileSync(summaryPath, 'utf8')
    : '';

  const prompt = buildReverifyPrompt({
    userPrompt: process.env.USER_PROMPT,
    fixSummary,
  });

  if (prompt.length === 0) {
    return;
  }
  fs.writeFileSync(outPath, `${prompt}\n`);
  process.stdout.write(outPath);
}

module.exports = { buildReverifyPrompt, PROMPT_MAX_CHARS, MIN_SUMMARY_CHARS };

if (require.main === module) {
  main();
}
