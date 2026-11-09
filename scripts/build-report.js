#!/usr/bin/env node

// Builds a markdown verification report.
//
// Two sources, one report. A verification that ran on this runner leaves
// artifacts behind and the report is assembled from them; one that ran on the
// IronBee platform leaves a job body, and the report is assembled from that.
// The header, the badge and the footer are shared, so the two read as one
// product rather than as two tools that happen to comment on the same PR.
//
// Local:    node build-report.js <artifacts-dir> <ironbee-version> [artifact-url] [console-url] [session-id]
// Platform: node build-report.js --job <path> --version <v> [--console <url>]
//   [--job-url <url>] [--earlier-job-url <url>]
//                                [--failure-code <c>] [--failure-message <m>]
//
// Outputs markdown to stdout. One answer besides the report:
//   node build-report.js --fix-cycle <dir>   `true` when <dir>/sessions holds a fix cycle
//   node build-report.js --last-verdict <dir>   `<status>|<session id>` of the last verdict there

const fs = require('fs');
const path = require('path');

// Shared by both report shapes, so a reader sees one product. Plain Markdown:
// Bitbucket shows raw HTML as text, and an image takes no size.
const HEADER = '## ![IronBee](https://ironbee.ai/favicon.png) IronBee Verification Report';

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--fix-cycle') {
    console.log(hadFixCycle(parseVerdicts(argv[1] || '.')) ? 'true' : 'false');
    return;
  }
  if (argv[0] === '--last-verdict') {
    const cycles = parseVerdicts(argv[1] || '.');
    const last = cycles[cycles.length - 1];
    console.log(last ? `${last.verdict.status || 'unknown'}|${last.sessionId}` : '');
    return;
  }
  if (argv[0] === '--job') {
    console.log(buildPlatformReport(readJobFile(flag(argv, '--job')), {
      ironbeeVersion: flag(argv, '--version') || 'unknown',
      consoleUrl: flag(argv, '--console'),
      jobUrl: flag(argv, '--job-url'),
      earlierJobUrl: flag(argv, '--earlier-job-url'),
      failureCode: flag(argv, '--failure-code'),
      failureMessage: flag(argv, '--failure-message'),
    }));
    return;
  }

  const [artifactsDir, ironbeeVersion, artifactUrl, consoleUrl, sessionIdArg] = argv;

  if (!artifactsDir || !ironbeeVersion) {
    console.error('Usage: node build-report.js <artifacts-dir> <ironbee-version> [artifact-url] [console-url] [session-id]');
    process.exit(1);
  }

  const cycles = parseVerdicts(artifactsDir);
  const endReason = parseEndReason(artifactsDir);
  const sessionId = sessionIdArg || endReason?.session_id || findAnySessionId(artifactsDir);
  const finalStatus = cycles.length > 0 ? (cycles[cycles.length - 1].verdict.status || 'unknown') : 'unknown';
  const host = consoleHost(consoleUrl);

  const lines = [];

  // Header
  lines.push(HEADER);
  lines.push('');

  // Session-level console link (above the verdict badge)
  if (host && sessionId) {
    lines.push(`🔗 **[View session in IronBee Console](https://${host}/sessions/${sessionId})**`);
    lines.push('');
  }

  // Verdict badge
  lines.push(formatBadge(finalStatus, cycles.length));
  lines.push('');

  // Banner when the session ended abnormally (e.g., max_turns)
  if (endReason && isAbnormalEnd(endReason)) {
    lines.push(formatEndBanner(endReason));
    lines.push('');
  }

  // Each cycle
  cycles.forEach((cycle, i) => {
    lines.push('---');
    lines.push('');
    lines.push(formatCycle(i + 1, cycle, host));
    lines.push('');
  });

  // Session-end details — only when the session ended abnormally
  if (endReason && isAbnormalEnd(endReason)) {
    lines.push('---');
    lines.push('');
    lines.push(formatEndDetails(endReason));
    lines.push('');
  }

  // Artifact link
  if (artifactUrl) {
    lines.push('---');
    lines.push('');
    lines.push(`### 📦 [Download Verification Artifacts](${artifactUrl})`);
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push(`*Verified by [IronBee](https://github.com/ironbee-ai/ironbee-bitbucket) v${ironbeeVersion}*`);

  console.log(lines.join('\n'));
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 || at === argv.length - 1 ? '' : argv[at + 1];
}

function readJobFile(jobPath) {
  if (!jobPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(jobPath, 'utf-8'));
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// The platform report.
//
// Renders the verdict a job came back with, and — when it came back without one
// — says which job it was and why, rather than showing an empty verdict. A run
// that could not be created has no job at all, and its report is the failure.
function buildPlatformReport(job, options) {
  const opts = options || {};
  const host = consoleHost(opts.consoleUrl);
  const result = (job && job.result) || null;
  const status = result && result.status ? result.status : 'unknown';
  const lines = [];

  lines.push(HEADER);
  lines.push('');

  const link = opts.jobUrl || (host && job && job.attempt ? `https://${host}/sessions/${job.attempt}` : '');
  if (link) {
    lines.push(`🔗 **[View session in IronBee Console](${link})**`);
    // A fix round runs a second verification, and the badge above belongs to
    // that one — so linking only it drops the session that found the issues in
    // the first place. That is the session with the evidence: the failing
    // checks, the screenshots, the traces. The one linked above shows an
    // application that works.
    if (opts.earlierJobUrl && opts.earlierJobUrl !== link) {
      lines.push(`↳ the verification before the fix: [session](${opts.earlierJobUrl})`);
    }
    lines.push('');
  }

  lines.push(formatBadge(status, 1));
  lines.push('');

  if (job === null) {
    const code = opts.failureCode ? `\`${opts.failureCode}\` — ` : '';
    const message = opts.failureMessage || 'the verification did not produce a job';
    lines.push(`> ⚠️ **No verification ran.** ${code}${message}`);
    lines.push('');
  } else if (result === null) {
    const error = job.error || {};
    const label = error.type ? `\`${error.type}\`` : 'the run ended without one';
    const detail = error.message ? ` — ${error.message}` : '';
    lines.push(`> ⚠️ **No verdict.** ${label}${detail}`);
    lines.push('');
    lines.push(...recoveryHint(error.message));
  }

  if (result && result.summary) {
    lines.push(renderSummary(result.summary));
    lines.push('');
  }

  // `checks` gets a neutral bullet, never a tick: the contract carries no
  // per-check status, and a check whose words say it failed would be rendered
  // as passing.
  lines.push(...formatList('Checks', result && result.checks, '-'));
  lines.push(...formatList('Issues', result && result.issues, '-'));
  // "Suggested", unlike the local report's plain "Fixes", and the difference is
  // real rather than wording: the run that produces this verdict verifies and
  // does not edit code, so the field holds remedies it recommends, not changes
  // it made. Labelling them "Fixes" reads as "these were applied" — on a report
  // whose whole point is that the issues above are still there.
  lines.push(...formatList('Suggested fixes', result && result.fixes, '-'));

  if (result && result.refused) {
    lines.push(`> ℹ️ The run declined or narrowed part of the request (${result.reasonCode || 'no code'}).`);
    lines.push('');
  }

  lines.push('---');
  const jobLine = job ? `Job \`${job.id}\` · ` : '';
  lines.push(`*${jobLine}Verified by [IronBee](https://github.com/ironbee-ai/ironbee-bitbucket) on the IronBee platform*`);

  return lines.join('\n');
}

// The summary is Markdown the model wrote, and a model sometimes writes the
// escape sequences instead of the characters — a whole document on one line,
// with visible backslashes, in a pull request comment.
//
// Repaired only in the unambiguous case: a string with NO real newline that
// contains the two-character `\n`. A summary that already has newlines is left
// exactly as it is, so a legitimate `\n` inside a code sample survives.
function renderSummary(summary) {
  if (summary.includes('\n') || !summary.includes('\\n')) {
    return summary;
  }
  return summary
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

// The one failure a reader can act on from here: the platform could not read
// the repository, and the fix is a connection it has no way to guess at.
function recoveryHint(message) {
  if (!message || !/repo checkout failed/i.test(message)) return [];
  return [
    'The run could not read the repository. Connect its workspace to IronBee on the IronBee Console '
      + '(the IronBee app for Bitbucket), or set `IRONBEE_BIND_REPOSITORY: false` to verify the '
      + 'application without a checkout.',
    '',
  ];
}

function formatList(label, entries, bullet) {
  if (!entries || entries.length === 0) return [];
  const lines = [`**${label}:**`];
  for (const entry of entries) {
    lines.push(`${bullet} ${entry}`);
  }
  lines.push('');
  return lines;
}

// Parse all verdicts from actions.jsonl files in session directories.
// Each entry keeps its session/activity/verification IDs so per-cycle links
// can be rendered.
function parseVerdicts(artifactsDir) {
  const sessionsDir = path.join(artifactsDir, 'sessions');
  const cycles = [];

  if (!fs.existsSync(sessionsDir)) return cycles;

  for (const sessionId of fs.readdirSync(sessionsDir).sort()) {
    for (const event of readSessionEvents(path.join(sessionsDir, sessionId))) {
      // A scenario run's verdict is for visibility only: it gates nothing, and
      // its fail is no failure a fix answered.
      if (event.type === 'verdict_write' && event.verdict && event.kind !== 'scenario') {
        cycles.push({
          sessionId,
          activityId: event.activity_id,
          verificationId: event.verification_id,
          verdict: event.verdict,
        });
      }
    }
  }

  return cycles;
}

// A session's events in order. Each agent writes its own
// `agents/<id>/actions.jsonl`, and an older CLI wrote one `actions.jsonl` for
// the session; they are merged by `timestamp`, each file's own order kept (a
// line with an earlier or no timestamp stays after the one it followed).
function readSessionEvents(sessionDir) {
  const files = [path.join(sessionDir, 'actions.jsonl')];
  const agentsDir = path.join(sessionDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const agentId of fs.readdirSync(agentsDir).sort()) {
      files.push(path.join(agentsDir, agentId, 'actions.jsonl'));
    }
  }
  const entries = [];
  files.forEach((file, source) => {
    if (!fs.existsSync(file)) {
      return;
    }
    let key = Number.NEGATIVE_INFINITY;
    fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).forEach((line, index) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // skip malformed lines
        return;
      }
      const timestamp = typeof event.timestamp === 'number' ? event.timestamp : 0;
      key = Math.max(key, timestamp);
      entries.push({ event, key, source, index });
    });
  });
  entries.sort((a, b) => (a.key - b.key) || (a.source - b.source) || (a.index - b.index));
  return entries.map((entry) => entry.event);
}

// Normalize console URL into a bare hostname (strips scheme + trailing slashes).
function consoleHost(consoleUrl) {
  if (!consoleUrl) return '';
  return consoleUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// Parse the final type:"result" event from claude-output.log.raw.
// Returns the parsed event (with subtype, num_turns, errors, etc.) or null.
function parseEndReason(artifactsDir) {
  const logFile = path.join(artifactsDir, 'claude-output.log.raw');
  if (!fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') return event;
    } catch {}
  }
  return null;
}

// Last-resort session_id lookup: name of any subdirectory under sessions/.
function findAnySessionId(artifactsDir) {
  const sessionsDir = path.join(artifactsDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return '';
  const entries = fs.readdirSync(sessionsDir).filter((name) => {
    try { return fs.statSync(path.join(sessionsDir, name)).isDirectory(); } catch { return false; }
  });
  return entries[0] || '';
}

function isAbnormalEnd(end) {
  return end.subtype && end.subtype !== 'success';
}

// Human-readable label for the result.subtype field.
function endReasonLabel(end) {
  const subtype = end.subtype || 'unknown';
  switch (subtype) {
    case 'success': return 'Completed successfully';
    case 'error_max_turns': return 'Reached max turns limit';
    case 'error_during_execution': return 'Error during execution';
    default: return subtype;
  }
}

// One-line banner shown under the verdict badge when the session ended abnormally.
function formatEndBanner(end) {
  const label = endReasonLabel(end);
  const turns = end.num_turns != null ? ` after ${end.num_turns} turn${end.num_turns === 1 ? '' : 's'}` : '';
  return `> ⚠️ **Session ended early:** ${label}${turns}. Verification may be incomplete.`;
}

// Full end-of-session diagnostics under a bold heading: Bitbucket has no
// collapsible block, and shows a `<details>` tag as text.
function formatEndDetails(end) {
  const lines = [];
  lines.push('**Session end details**');
  lines.push('');
  lines.push(`- **Reason:** ${endReasonLabel(end)} (\`${end.subtype || 'unknown'}\`)`);
  if (end.terminal_reason && end.terminal_reason !== end.subtype) {
    lines.push(`- **Terminal reason:** \`${end.terminal_reason}\``);
  }
  if (end.num_turns != null) lines.push(`- **Turns:** ${end.num_turns}`);
  if (typeof end.total_cost_usd === 'number') {
    lines.push(`- **Cost:** $${end.total_cost_usd.toFixed(4)}`);
  }
  if (typeof end.duration_ms === 'number') {
    lines.push(`- **Duration:** ${(end.duration_ms / 1000).toFixed(1)}s`);
  }
  if (Array.isArray(end.errors) && end.errors.length > 0) {
    lines.push(`- **Errors:**`);
    for (const e of end.errors) lines.push(`  - ${e}`);
  }
  if (Array.isArray(end.permission_denials) && end.permission_denials.length > 0) {
    lines.push(`- **Blocked tool calls:** ${end.permission_denials.length}`);
    for (const d of end.permission_denials.slice(0, 10)) {
      const target = d.tool_input?.file_path
        || (typeof d.tool_input?.command === 'string' ? d.tool_input.command.slice(0, 80) : '')
        || d.tool_input?.url
        || '';
      lines.push(`  - \`${d.tool_name}\`${target ? ` — ${target}` : ''}`);
    }
  }
  return lines.join('\n');
}

// Format the top-level badge line.
function formatBadge(status, cycleCount) {
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⚠️';
  const label = status.toUpperCase();
  const suffix = cycleCount > 1 ? ` (${cycleCount} cycles)` : '';
  return `${icon} **${label}**${suffix}`;
}

// Format a single verification cycle as markdown.
function formatCycle(num, cycle, host) {
  const lines = [];
  const verdict = cycle.verdict;
  const status = verdict.status || 'unknown';
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⚠️';

  lines.push(`### Cycle ${num} — ${icon} ${status}`);
  lines.push('');

  // Per-verification console link
  if (host && cycle.sessionId && cycle.verificationId) {
    const params = new URLSearchParams();
    if (cycle.activityId) params.set('activityId', cycle.activityId);
    params.set('verificationId', cycle.verificationId);
    const url = `https://${host}/sessions/${cycle.sessionId}?${params.toString()}`;
    lines.push(`🔗 [View this verification in IronBee Console](${url})`);
    lines.push('');
  }

  if (verdict.checks && verdict.checks.length > 0) {
    lines.push('**Checks:**');
    for (const c of verdict.checks) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  if (verdict.issues && verdict.issues.length > 0) {
    lines.push('**Issues:**');
    for (const issue of verdict.issues) {
      lines.push(`- ${issue}`);
    }
    lines.push('');
  }

  if (verdict.fixes && verdict.fixes.length > 0) {
    lines.push('**Fixes:**');
    for (const fix of verdict.fixes) {
      lines.push(`- ${fix}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// A fix cycle: a failing verdict before the last one, so the agent fixed and
// verified again. A run without one fixed nothing, whatever its tree gained.
function hadFixCycle(cycles) {
  return cycles.slice(0, -1).some((cycle) => cycle.verdict && cycle.verdict.status === 'fail');
}

module.exports = { buildPlatformReport, formatBadge, consoleHost, renderSummary, parseVerdicts, readSessionEvents, hadFixCycle };

if (require.main === module) {
  main();
}
