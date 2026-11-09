'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReverifyPrompt,
  PROMPT_MAX_CHARS,
  MIN_SUMMARY_CHARS,
} = require('../scripts/build-reverify-prompt.js');

// What this prevents, from a real run: the fix was correct and the rebuilt
// container was serving it, and the re-verification failed anyway — it read the
// repository at the bound commit, which does not contain the fixes, found the
// original bug in the source, and quoted the unfixed line in its verdict.

test('reverify: with no fixes to report, the caller keeps their own prompt', () => {
  assert.equal(buildReverifyPrompt({ userPrompt: 'test the checkout', fixSummary: '' }), 'test the checkout');
  assert.equal(buildReverifyPrompt({ userPrompt: 'test the checkout' }), 'test the checkout');
  assert.equal(buildReverifyPrompt({ userPrompt: '', fixSummary: '   ' }), '');
});

test('reverify: the note says the repository is stale, and carries the account of the fixes', () => {
  const prompt = buildReverifyPrompt({
    userPrompt: 'test the checkout',
    fixSummary: 'Rounded both sides of the discount check and compared with a tolerance.',
  });

  assert.match(prompt, /^test the checkout/);
  assert.match(prompt, /NOT pushed/);
  assert.match(prompt, /Rounded both sides of the discount check/);
});

// The caller's prompt was accepted by the first verification. Clipping it here
// would make the second run answer a narrower question than the one it repeats,
// and nothing in the report would explain the difference.
test('reverify: the note is dropped rather than the caller being clipped', () => {
  const userPrompt = 'u'.repeat(PROMPT_MAX_CHARS - 50);

  const prompt = buildReverifyPrompt({ userPrompt, fixSummary: 'Fixed the discount check.' });

  assert.equal(prompt, userPrompt);
});

test('reverify: a summary too clipped to say anything is dropped whole', () => {
  // Sized so the budget left after the caller's prompt and the header lands
  // under the floor a note has to clear, whatever the header's exact length.
  const userPrompt = 'u'.repeat(PROMPT_MAX_CHARS - MIN_SUMMARY_CHARS);

  const prompt = buildReverifyPrompt({ userPrompt, fixSummary: 's'.repeat(2000) });

  assert.equal(prompt, userPrompt);
  assert.equal(prompt.includes('NOT pushed'), false);
});

// Overshooting the API's cap is a 400 at create time, which loses the
// re-verification altogether rather than degrading it.
test('reverify: the result never exceeds the prompt cap', () => {
  for (const userLength of [0, 100, 1000, 3000]) {
    const prompt = buildReverifyPrompt({
      userPrompt: 'u'.repeat(userLength),
      fixSummary: 'line of fix detail\n'.repeat(1000),
    });
    assert.ok(
      prompt.length <= PROMPT_MAX_CHARS,
      `user ${String(userLength)} produced ${String(prompt.length)} chars`,
    );
  }
});

test('reverify: a clipped note says it was clipped, and ends on a line', () => {
  const prompt = buildReverifyPrompt({
    userPrompt: '',
    fixSummary: 'a fix line that is long enough to matter\n'.repeat(500),
  });

  assert.match(prompt, /\[…truncated\]$/);
  assert.equal(prompt.includes('NOT pushed'), true);
});
