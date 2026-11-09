#!/usr/bin/env node

// Bitbucket's stand-in for GitHub's workflow commands.
//
// Bitbucket Pipelines has no annotations: `::error::`, `::warning::` and
// `::notice::` would reach the log as they are, prefix and all. The same text is
// printed with a coloured `ERROR:` / `WARNING:` / `NOTICE:` prefix instead. A
// pipe's log has no collapsible sections either, so a step's box and `::group::`
// become a header line. run.sh carries a bash twin of each, which the tests hold
// to the same output.

'use strict';

const LEVELS = {
  error: { label: 'ERROR', colour: '31' },
  warning: { label: 'WARNING', colour: '33' },
  notice: { label: 'NOTICE', colour: '36' },
};

const ESC = '\x1b';

function format(level, message) {
  const { label, colour } = LEVELS[level];
  return `${ESC}[${colour};1m${label}:${ESC}[0m ${message}`;
}

function error(message) {
  console.log(format('error', message));
}

function warning(message) {
  console.log(format('warning', message));
}

function notice(message) {
  console.log(format('notice', message));
}

/**
 * A section's header line. The name and the collapsed flag are what GitLab's
 * sections take; a Bitbucket log has nowhere to put them, so only the title is
 * printed.
 */
function sectionStart(name, title) {
  return `${ESC}[1m▶ ${title}${ESC}[0m`;
}

/** A section ends where the next header starts: nothing is printed. */
function sectionEnd() {
  return '';
}

module.exports = { format, error, warning, notice, sectionStart, sectionEnd };
