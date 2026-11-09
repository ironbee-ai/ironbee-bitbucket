'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createClient, REPORT_MARKER, API_URL } = require('../scripts/bitbucket-api.js');

const ROOT = 'https://api.example/2.0/repositories/ironbee/shop';

/** A fetch that answers from a list of handlers and records every call. */
function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const handler = handlers.find((h) => h.method === call.method && h.match.test(url));
    if (!handler) {
      return response(404, { type: 'error', error: { message: 'not found' } });
    }
    return handler.reply(call);
  };
  return { impl, calls };
}

function response(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

function client(fetchImpl, token) {
  return createClient({
    baseUrl: 'https://api.example/2.0/',
    token: token === undefined ? 'bb-step-token' : token,
    repository: 'ironbee/shop',
    fetchImpl,
  });
}

test('bitbucket-api: the real API is api.bitbucket.org, not the Pipelines proxy', () => {
  assert.equal(API_URL, 'https://api.bitbucket.org/2.0');
});

test('bitbucket-api: every call carries the step token as a Bearer, against the repository', async () => {
  const { impl, calls } = fakeFetch([
    { method: 'GET', match: /\/comments\?/, reply: () => response(200, { values: [] }) },
    { method: 'POST', match: /\/comments$/, reply: () => response(201, { id: 9 }) },
  ]);
  await client(impl).upsertComment(7, 'body');

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.headers.Authorization, 'Bearer bb-step-token');
    assert.ok(call.url.startsWith(`${ROOT}/pullrequests/7/comments`), call.url);
  }
});

// A public repository answers a read without one, so none is sent rather than
// an empty one.
test('bitbucket-api: without a token, a call is sent unauthenticated', async () => {
  const { impl, calls } = fakeFetch([
    { method: 'GET', match: /\/pullrequests\/7$/, reply: () => response(200, { id: 7, title: 'Promo discount' }) },
  ]);
  assert.equal(await client(impl, '').pullRequestTitle(7), 'Promo discount');
  assert.equal('Authorization' in calls[0].headers, false);
});

test('bitbucket-api: the repository must be <workspace>/<repository>', () => {
  for (const repository of ['', 'ironbee', 'ironbee/shop/extra', '/shop']) {
    assert.throws(() => createClient({ baseUrl: API_URL, token: 't', repository }), /BITBUCKET_REPO_FULL_NAME/);
  }
});

// Updated in place rather than appended to, so a pull request pushed to
// repeatedly carries one report comment rather than one per run.
test('bitbucket-api: an existing report comment is updated in place', async () => {
  const { impl, calls } = fakeFetch([
    {
      method: 'GET',
      match: /\/comments\?/,
      reply: () => response(200, {
        values: [
          { id: 1, content: { raw: 'looks good to me' } },
          { id: 2, content: { raw: `## ${REPORT_MARKER}\nold` } },
        ],
      }),
    },
    { method: 'PUT', match: /\/comments\/2$/, reply: () => response(200, { id: 2 }) },
  ]);
  const result = await client(impl).upsertComment(7, 'new body');

  assert.deepEqual(result, { action: 'updated', id: 2 });
  const put = calls.find((call) => call.method === 'PUT');
  assert.deepEqual(put.body, { content: { raw: 'new body' } });
  assert.equal(calls.some((call) => call.method === 'POST'), false);
});

test('bitbucket-api: with no report comment, a new one is posted', async () => {
  const { impl, calls } = fakeFetch([
    { method: 'GET', match: /\/comments\?/, reply: () => response(200, { values: [{ id: 1, content: { raw: 'hi' } }] }) },
    { method: 'POST', match: /\/comments$/, reply: () => response(201, { id: 5 }) },
  ]);
  const result = await client(impl).upsertComment(7, 'report');

  assert.deepEqual(result, { action: 'created', id: 5 });
  assert.deepEqual(calls.find((call) => call.method === 'POST').body, { content: { raw: 'report' } });
});

// The listing holds every comment of the pull request. Only a live
// conversation comment is the report: an inline one or a reply quoting it is
// somebody else's, and a deleted one is a placeholder.
test('bitbucket-api: an inline comment, a reply or a deleted comment is never the report', async () => {
  const { impl, calls } = fakeFetch([
    {
      method: 'GET',
      match: /\/comments\?/,
      reply: () => response(200, {
        values: [
          { id: 1, content: { raw: `${REPORT_MARKER} inline` }, inline: { path: 'a.js', to: 3 } },
          { id: 2, content: { raw: `> ${REPORT_MARKER} quoted` }, parent: { id: 9 } },
          { id: 3, content: { raw: `${REPORT_MARKER} gone` }, deleted: true },
          { id: 4, content: { raw: `## ${REPORT_MARKER}` } },
        ],
      }),
    },
    { method: 'PUT', match: /\/comments\/\d+$/, reply: () => response(200, {}) },
  ]);
  const result = await client(impl).upsertComment(7, 'x');

  assert.deepEqual(result, { action: 'updated', id: 4 });
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
});

// Oldest first, so "the first comment carrying the marker" names the same one
// whatever page it is on — the order the action's comment lookup reads in.
test('bitbucket-api: comments are read across every page, through the next links', async () => {
  const pages = {
    1: { values: [{ id: 1, content: { raw: 'a' } }], next: `${ROOT}/pullrequests/7/comments?pagelen=100&page=2` },
    2: { values: [{ id: 2, content: { raw: `${REPORT_MARKER} first` } }], next: `${ROOT}/pullrequests/7/comments?pagelen=100&page=3` },
    3: { values: [{ id: 3, content: { raw: `${REPORT_MARKER} second` } }] },
  };
  const { impl, calls } = fakeFetch([
    {
      method: 'GET',
      match: /\/comments\?/,
      reply: (call) => response(200, pages[new URL(call.url).searchParams.get('page') || '1']),
    },
    { method: 'PUT', match: /\/comments\/\d+$/, reply: () => response(200, {}) },
  ]);
  const result = await client(impl).upsertComment(7, 'x');

  assert.equal(result.id, 2);
  const listed = calls.filter((call) => call.method === 'GET').map((call) => new URL(call.url).searchParams);
  assert.deepEqual(listed.map((params) => params.get('page')), [null, '2', '3']);
  for (const params of listed) {
    assert.equal(params.get('pagelen'), '100');
  }
});

// The token goes only where this client addressed it: a next link to another
// host is refused rather than followed.
test('bitbucket-api: a next link outside the repository is never followed', async () => {
  const { impl, calls } = fakeFetch([
    {
      method: 'GET',
      match: /\/comments\?/,
      reply: () => response(200, { values: [], next: 'https://elsewhere.example/2.0/repositories/ironbee/shop/pullrequests/7/comments?page=2' }),
    },
  ]);
  await assert.rejects(client(impl).upsertComment(7, 'x'), /outside the repository/);
  assert.equal(calls.length, 1);
});

// Branch closing on merge is the repository's own choice, as `gh pr create`
// leaves it.
test('bitbucket-api: the fix pull request names its branches and nothing more', async () => {
  const { impl, calls } = fakeFetch([
    {
      method: 'POST',
      match: /\/pullrequests$/,
      reply: () => response(201, { id: 4, links: { html: { href: 'https://bitbucket.org/ironbee/shop/pull-requests/4' } } }),
    },
  ]);
  const created = await client(impl).createPullRequest({
    sourceBranch: 'ironbee/fix-abc1234-99',
    targetBranch: 'main',
    title: 'fix: IronBee verification fixes for abc1234',
    description: 'the report',
  });

  assert.equal(created.links.html.href, 'https://bitbucket.org/ironbee/shop/pull-requests/4');
  assert.equal(calls[0].url, `${ROOT}/pullrequests`);
  assert.deepEqual(calls[0].body, {
    title: 'fix: IronBee verification fixes for abc1234',
    description: 'the report',
    source: { branch: { name: 'ironbee/fix-abc1234-99' } },
    destination: { branch: { name: 'main' } },
  });
});

test('bitbucket-api: the title is read from the pull request', async () => {
  const { impl, calls } = fakeFetch([
    { method: 'GET', match: /\/pullrequests\/12$/, reply: () => response(200, { id: 12, title: 'feat: promo' }) },
  ]);
  assert.equal(await client(impl).pullRequestTitle(12), 'feat: promo');
  assert.equal(calls[0].url, `${ROOT}/pullrequests/12`);
});

// A refused call fails the step, as a failed `gh api` did, and says why without
// ever repeating the token.
test('bitbucket-api: a refused call throws with the status, never the token', async () => {
  const { impl } = fakeFetch([
    {
      method: 'GET',
      match: /\/comments\?/,
      reply: () => response(403, { type: 'error', error: { message: 'Your credentials lack one or more required privilege scopes.' } }),
    },
  ]);
  await assert.rejects(client(impl).upsertComment(7, 'x'), (error) => {
    assert.match(error.message, /GET \/pullrequests\/7\/comments answered 403/);
    assert.match(error.message, /privilege scopes/);
    assert.equal(error.message.includes('bb-step-token'), false);
    return true;
  });
});

// What pr-title prints is captured as the title, so a failure goes to stderr.
test('bitbucket-api: a failing command reports on stderr, never on stdout', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'bitbucket-api.js'), 'pr-title', '--id', '1'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, BITBUCKET_REPO_FULL_NAME: 'not-a-full-name' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ERROR:.*BITBUCKET_REPO_FULL_NAME/);
});
