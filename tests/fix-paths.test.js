'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { snapshotTree, changedPaths, stagePaths } = require('../scripts/fix-paths.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fix-paths.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A repository with two committed files, and what a build left behind before any fix. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-paths-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'one\n');
  fs.writeFileSync(path.join(dir, 'old.js'), 'old\n');
  fs.mkdirSync(path.join(dir, 'web'));
  fs.writeFileSync(path.join(dir, 'web', 'page.js'), 'page\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'build.log'), 'built\n');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'dep\n');
  return dir;
}

function staged(dir) {
  return git(dir, 'diff', '--cached', '--name-status', '--no-renames').trim().split('\n').filter(Boolean).sort();
}

// What the build left before the fix is not the fix, and neither is this run's
// own `.ironbee`; an edit, a new file, a deletion and a rename are.
test('fix paths: only what changed after the snapshot, each as it stands', () => {
  const dir = repo();
  const before = snapshotTree(dir);

  fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');
  fs.writeFileSync(path.join(dir, 'new.js'), 'new\n');
  fs.renameSync(path.join(dir, 'old.js'), path.join(dir, 'renamed.js'));
  fs.mkdirSync(path.join(dir, '.ironbee'));
  fs.writeFileSync(path.join(dir, '.ironbee', 'job.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'changed\n');

  const paths = changedPaths(dir, before, snapshotTree(dir));
  assert.deepEqual([...paths].sort(), ['app.js', 'new.js', 'old.js', 'renamed.js']);

  stagePaths(dir, paths);
  assert.deepEqual(staged(dir), ['A\tnew.js', 'A\trenamed.js', 'D\told.js', 'M\tapp.js']);
});

// No fix, nothing to stage — whatever else the tree holds.
test('fix paths: nothing changed since the snapshot is no path at all', () => {
  const dir = repo();
  const before = snapshotTree(dir);
  assert.deepEqual(changedPaths(dir, before, snapshotTree(dir)), []);
  stagePaths(dir, []);
  assert.deepEqual(staged(dir), []);
});

// A file that was already lying there and that the fix deleted is no path git
// can add, and must not fail the commit.
test('fix paths: an untracked file the fix deleted stages nothing and fails nothing', () => {
  const dir = repo();
  const before = snapshotTree(dir);
  fs.rmSync(path.join(dir, 'build.log'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');

  const paths = changedPaths(dir, before, snapshotTree(dir));
  assert.deepEqual([...paths].sort(), ['app.js', 'build.log']);
  stagePaths(dir, paths);
  assert.deepEqual(staged(dir), ['M\tapp.js']);
});

// From a working directory below the root: the paths are the repository's, a
// fix outside the directory counts, and the directory's own `.ironbee` does not.
test('fix paths: a working directory below the root names paths from the root', () => {
  const dir = repo();
  const web = path.join(dir, 'web');
  const before = snapshotTree(web);
  fs.writeFileSync(path.join(web, 'page.js'), 'fixed\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');
  fs.mkdirSync(path.join(web, '.ironbee'));
  fs.writeFileSync(path.join(web, '.ironbee', 'report.md'), 'r\n');

  const paths = changedPaths(web, before, snapshotTree(web));
  assert.deepEqual([...paths].sort(), ['app.js', 'web/page.js']);
  stagePaths(web, paths);
  assert.deepEqual(staged(dir), ['M\tapp.js', 'M\tweb/page.js']);
});

// The commands the steps run, through files.
test('fix paths: the command line writes the snapshot, the list and stages it', () => {
  const dir = repo();
  const run = (...args) => execFileSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, '.ironbee'));
  run('snapshot', '.ironbee/pre-fix-tree');
  fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');
  run('changed', '.ironbee/pre-fix-tree', '.ironbee/fix-paths');

  assert.equal(fs.readFileSync(path.join(dir, '.ironbee', 'fix-paths'), 'utf8'), 'app.js\0');
  run('stage', '.ironbee/fix-paths');
  assert.deepEqual(staged(dir), ['M\tapp.js']);
  // The real index is the only one that changed: the snapshots used their own.
  assert.equal(git(dir, 'status', '--porcelain', '--', 'build.log').trim(), '?? build.log');
});

// In local mode `.ironbee/` is in the repository's exclude file.
test('fix paths: an ignored `.ironbee` is left out as well', () => {
  const dir = repo();
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.ironbee/\n');
  fs.mkdirSync(path.join(dir, '.ironbee'));
  const before = snapshotTree(dir);
  fs.writeFileSync(path.join(dir, '.ironbee', 'job.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');
  assert.deepEqual(changedPaths(dir, before, snapshotTree(dir)), ['app.js']);
});

// A tracked `.ironbee` file is still this run's own, whatever the index says.
test('fix paths: a tracked file under `.ironbee` is left out too', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.ironbee'));
  fs.writeFileSync(path.join(dir, '.ironbee', 'config.json'), '{}\n');
  git(dir, 'add', '.ironbee/config.json');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'config');
  const before = snapshotTree(dir);
  fs.writeFileSync(path.join(dir, '.ironbee', 'config.json'), '{"changed":true}\n');
  assert.deepEqual(changedPaths(dir, before, snapshotTree(dir)), []);
});

// A same-size rewrite in the second the index was written leaves the file's
// size and times as the index recorded them; only the index's own timestamp
// tells git to read it again.
test('fix paths: a rewrite in the second the index was written is still seen', () => {
  const dir = repo();
  git(dir, 'config', 'core.trustctime', 'false');
  const file = path.join(dir, 'app.js');
  const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  fs.utimesSync(file, second, second);
  git(dir, 'update-index', '--refresh');
  const before = snapshotTree(dir);

  fs.writeFileSync(file, 'two\n');
  fs.utimesSync(file, second, second);
  fs.utimesSync(path.join(dir, '.git', 'index'), second, second);
  assert.deepEqual(changedPaths(dir, before, snapshotTree(dir)), ['app.js']);
});

// A file git cannot read, a container's root-owned leftover say, costs that
// file and not the snapshot.
// Root reads a file whatever its mode, so as root there is nothing to test.
test('fix paths: an unreadable untracked file does not lose the snapshot', { skip: process.getuid?.() === 0 }, () => {
  const dir = repo();
  const secret = path.join(dir, 'secret.db');
  fs.writeFileSync(secret, 'secret\n');
  fs.chmodSync(secret, 0o000);
  try {
    const run = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
    fs.mkdirSync(path.join(dir, '.ironbee'));
    assert.equal(run('snapshot', '.ironbee/pre-fix-tree').status, 0);
    assert.match(fs.readFileSync(path.join(dir, '.ironbee', 'pre-fix-tree'), 'utf8'), /^[0-9a-f]{40,64}\n$/);
    fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');
    assert.equal(run('changed', '.ironbee/pre-fix-tree', '.ironbee/fix-paths').status, 0);
    assert.equal(fs.readFileSync(path.join(dir, '.ironbee', 'fix-paths'), 'utf8'), 'app.js\0');
  } finally {
    fs.chmodSync(secret, 0o600);
  }
});

// No snapshot to compare with: the run says so and counts every change against
// HEAD, as before snapshots, still without its own `.ironbee`.
test('fix paths: a missing snapshot falls back to every change against HEAD, and warns', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.ironbee'));
  fs.writeFileSync(path.join(dir, '.ironbee', 'job.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');
  fs.rmSync(path.join(dir, 'old.js'));

  const result = spawnSync('node', [SCRIPT, 'changed', '.ironbee/pre-fix-tree', '.ironbee/fix-paths'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^warning: there is no snapshot of the tree before the fix/);
  const paths = fs.readFileSync(path.join(dir, '.ironbee', 'fix-paths'), 'utf8').split('\0').filter(Boolean).sort();
  assert.deepEqual(paths, ['app.js', 'build.log', 'old.js']);
});

test('fix paths: an unreadable snapshot falls back the same way', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, 'web', '.ironbee'));
  fs.writeFileSync(path.join(dir, 'web', '.ironbee', 'pre-fix-tree'), 'not-a-tree\n');
  fs.writeFileSync(path.join(dir, 'web', '.ironbee', 'job.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'web', 'page.js'), 'fixed\n');

  const result = spawnSync('node', [SCRIPT, 'changed', '.ironbee/pre-fix-tree', '.ironbee/fix-paths'], { cwd: path.join(dir, 'web'), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^warning: the tree before the fix could not be compared/);
  const paths = fs.readFileSync(path.join(dir, 'web', '.ironbee', 'fix-paths'), 'utf8').split('\0').filter(Boolean).sort();
  assert.deepEqual(paths, ['build.log', 'web/page.js']);
});

// A snapshot that cannot be taken at all warns and lets the step go on, and
// leaves no earlier snapshot behind to be compared with.
test('fix paths: a snapshot that cannot be taken warns, exits 0 and leaves no file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-paths-nogit-'));
  fs.writeFileSync(path.join(dir, 'pre-fix-tree'), 'stale\n');
  const result = spawnSync('node', [SCRIPT, 'snapshot', 'pre-fix-tree'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
  });
  assert.equal(result.status, 0);
  // Tried twice, then given up on in one line.
  assert.match(result.stderr, /^warning: the tree could not be read .*; trying once more$/m);
  assert.match(result.stderr, /^warning: the tree before the fix could not be recorded/m);
  assert.equal(fs.existsSync(path.join(dir, 'pre-fix-tree')), false);
});

// `git add` refuses a nested repository with no commit, where `git status`
// does not: the snapshot skips it and records the rest.
test('fix paths: a nested repository with no commit does not lose the snapshot', () => {
  const dir = repo();
  git(dir, 'init', '-q', 'vendor');
  fs.writeFileSync(path.join(dir, 'vendor', 'x.js'), 'x\n');
  fs.mkdirSync(path.join(dir, '.ironbee'));
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

  assert.equal(run('snapshot', '.ironbee/pre-fix-tree').status, 0);
  assert.match(fs.readFileSync(path.join(dir, '.ironbee', 'pre-fix-tree'), 'utf8'), /^[0-9a-f]{40,64}\n$/);
  fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');
  assert.equal(run('changed', '.ironbee/pre-fix-tree', '.ironbee/fix-paths').status, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.ironbee', 'fix-paths'), 'utf8'), 'app.js\0');
});

// The fallback is `git status`, whose nested repository is a directory no
// commit could stage.
test('fix paths: the fallback lists no nested repository', () => {
  const dir = repo();
  git(dir, 'init', '-q', 'vendor');
  fs.writeFileSync(path.join(dir, 'app.js'), 'two\n');
  fs.mkdirSync(path.join(dir, '.ironbee'));
  const result = spawnSync('node', [SCRIPT, 'changed', '.ironbee/missing', '.ironbee/out'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const listed = fs.readFileSync(path.join(dir, '.ironbee', 'out'), 'utf8').split('\0').filter(Boolean).sort();
  assert.deepEqual(listed, ['app.js', 'build.log']);
});

test('fix paths: no list file stages nothing', () => {
  const dir = repo();
  execFileSync('node', [SCRIPT, 'stage', '.ironbee/missing'], { cwd: dir });
  assert.deepEqual(staged(dir), []);
});
