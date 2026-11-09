#!/usr/bin/env node

// What a fix changed, and nothing else.
//
// The working tree is not clean when a fix starts: an install, a build and the
// IronBee setup have already written into it. The tree before the fix,
// compared with the tree after it, names the paths the fix touched, and the
// commit stages those alone, so nothing else that was lying there lands as a fix.
//
//   node fix-paths.js snapshot <file>       the working tree's id, to <file>
//   node fix-paths.js changed <file> <out>  the paths changed since <file>, NUL-separated, to <out>
//   node fix-paths.js stage <out>           those paths, staged as they stand now
//
// Paths are the repository's, from its root. Ignored files and the working
// directory's `.ironbee` (this run's own files) are left out. `snapshot` and
// `changed` never fail a step: without a snapshot, `changed` warns and lists
// every change `git status` reports instead.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function git(args, options) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function split(output) {
  return output.split('\0').filter((entry) => entry.length > 0);
}

function warn(message) {
  process.stderr.write(`warning: ${message}\n`);
}

/** The working tree as a tree object, taken twice before it is given up on. */
function snapshotTree(cwd) {
  try {
    return snapshotOnce(cwd);
  } catch (error) {
    // A file that appeared and vanished during the add is the usual cause, and
    // the running application writes such files; a second take rarely meets it.
    warn(`the tree could not be read (${firstLine(error)}); trying once more`);
    return snapshotOnce(cwd);
  }
}

/** The working tree, tracked and untracked files alike, as a tree object; its id. */
function snapshotOnce(cwd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ironbee-fix-'));
  const index = path.join(dir, 'index');
  try {
    // A copy of the real index, so files unchanged since it was written are not
    // read again. Its timestamp too: by it git tells a file rewritten in the
    // same second the index was written, which its size and times alone hide.
    const real = path.resolve(cwd, git(['rev-parse', '--git-path', 'index'], { cwd }).trim());
    if (fs.existsSync(real)) {
      fs.copyFileSync(real, index);
      const { atime, mtime } = fs.statSync(real);
      fs.utimesSync(index, atime, mtime);
    }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    // A file git cannot index (unreadable, or a nested repository with no
    // commit) is skipped rather than losing the snapshot: git then exits 1 and
    // still writes the index. Anything else wrote nothing, and is a failure.
    try {
      git(['add', '-A', '--ignore-errors', '--', ':/'], { cwd, env });
    } catch (error) {
      if (error.status !== 1) {
        throw error;
      }
      warn(`some files are not in the snapshot: ${firstLine(error)}`);
    }
    // Taken out after the add rather than excluded from it: git refuses a
    // pathspec that names an ignored path, and `.ironbee` often is one.
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.ironbee'], { cwd, env });
    return git(['write-tree'], { cwd, env }).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The paths whose content differs between two trees. A rename is its two paths. */
function changedPaths(cwd, before, after) {
  return split(git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', before, after], { cwd }));
}

/**
 * Every change `git status` reports, `.ironbee` left out: what counts when
 * there is no snapshot. A directory git does not descend into (a nested
 * repository) is no path to stage.
 */
function statusPaths(cwd) {
  const own = `${git(['rev-parse', '--show-prefix'], { cwd }).trim()}.ironbee`;
  return split(git(['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], { cwd }))
    .map((entry) => entry.slice(3))
    .filter((entry) => entry !== '' && !entry.endsWith('/'))
    .filter((entry) => entry !== own && !entry.startsWith(`${own}/`));
}

/** The paths changed since the snapshot in `file`; every change `git status` reports when that cannot be told. */
function changedSince(cwd, file) {
  let before = '';
  try {
    before = fs.readFileSync(file, 'utf8').trim();
  } catch {
    before = '';
  }
  if (before === '') {
    warn('there is no snapshot of the tree before the fix; every change git reports counts');
    return statusPaths(cwd);
  }
  try {
    git(['cat-file', '-e', `${before}^{tree}`], { cwd });
    return changedPaths(cwd, before, snapshotTree(cwd));
  } catch (error) {
    warn(`the tree before the fix could not be compared (${firstLine(error)}); every change git reports counts`);
    return statusPaths(cwd);
  }
}

/** Each path as it stands now: added, updated, or removed when it is gone. */
function stagePaths(cwd, paths) {
  if (paths.length === 0) {
    return;
  }
  const top = git(['rev-parse', '--show-toplevel'], { cwd }).trim();
  git(['update-index', '--add', '--remove', '--replace', '-z', '--stdin'], {
    cwd: top,
    input: paths.map((entry) => `${entry}\0`).join(''),
  });
}

function readPaths(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return split(fs.readFileSync(file, 'utf8'));
}

function firstLine(error) {
  const text = String((error && (error.stderr || error.message)) || error).trim();
  return text.split('\n')[0];
}

module.exports = { snapshotTree, changedPaths, statusPaths, changedSince, stagePaths, readPaths };

function main() {
  const [command, first, second] = process.argv.slice(2);
  const cwd = process.cwd();
  if (command === 'snapshot' && first) {
    // No stale snapshot survives a failed one: `changed` then falls back, and says so.
    fs.rmSync(first, { force: true });
    try {
      fs.writeFileSync(first, `${snapshotTree(cwd)}\n`);
    } catch (error) {
      warn(`the tree before the fix could not be recorded (${firstLine(error)}); the run goes on without it`);
    }
    return;
  }
  if (command === 'changed' && first && second) {
    let paths = [];
    try {
      paths = changedSince(cwd, first);
    } catch (error) {
      warn(`what the fix changed could not be read (${firstLine(error)}); no path counts`);
    }
    fs.writeFileSync(second, paths.map((entry) => `${entry}\0`).join(''));
    return;
  }
  if (command === 'stage' && first) {
    stagePaths(cwd, readPaths(first));
    return;
  }
  console.error('Usage: node fix-paths.js snapshot <file> | changed <file> <out> | stage <out>');
  process.exitCode = 1;
}

if (require.main === module) {
  main();
}
