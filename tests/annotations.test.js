'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const annotations = require('../scripts/annotations.js');

const RUN_SH = path.join(__dirname, '..', 'scripts', 'run.sh');

/** Calls one of run.sh's helpers, with the file sourced so nothing else runs. */
function bash(snippet) {
  return execFileSync('bash', ['-c', `source "${RUN_SH}"; ${snippet}`], { encoding: 'utf8' });
}

// Bitbucket prints `::error::` as it is, so the text keeps its words and gains a
// prefix a reader can see.
test('annotations: each level keeps the message word for word behind its prefix', () => {
  assert.equal(annotations.format('error', 'it broke'), '\x1b[31;1mERROR:\x1b[0m it broke');
  assert.equal(annotations.format('warning', 'it may break'), '\x1b[33;1mWARNING:\x1b[0m it may break');
  assert.equal(annotations.format('notice', 'it ran'), '\x1b[36;1mNOTICE:\x1b[0m it ran');
});

test('annotations: the printers write the formatted line to stdout', () => {
  const written = [];
  const realLog = console.log;
  console.log = (line) => { written.push(line); };
  try {
    annotations.error('e');
    annotations.warning('w');
    annotations.notice('n');
  } finally {
    console.log = realLog;
  }
  assert.deepEqual(written, [
    annotations.format('error', 'e'),
    annotations.format('warning', 'w'),
    annotations.format('notice', 'n'),
  ]);
});

// A pipe's log has no collapsible sections: a section is its title as a header.
test('annotations: a section is a header line, and its end prints nothing', () => {
  assert.equal(annotations.sectionStart('ironbee_x', 'A title'), '\x1b[1m▶ A title\x1b[0m');
  assert.equal(annotations.sectionEnd('ironbee_x'), '');
});

// The bash twins in run.sh print what the Node ones do, so a message reads the
// same whichever side of the job printed it.
test('annotations: run.sh\'s bash twins print the same lines', () => {
  assert.equal(bash('annotate_error "it broke"'), `${annotations.format('error', 'it broke')}\n`);
  assert.equal(bash('annotate_warning "it may break"'), `${annotations.format('warning', 'it may break')}\n`);
  assert.equal(bash('annotate_notice "it ran"'), `${annotations.format('notice', 'it ran')}\n`);
});

test('annotations: run.sh\'s sections match', () => {
  assert.equal(bash('section_start ironbee_x "A title" true'), `${annotations.sectionStart('ironbee_x', 'A title')}\n`);
  assert.equal(bash('section_end ironbee_x'), annotations.sectionEnd('ironbee_x'));
});
