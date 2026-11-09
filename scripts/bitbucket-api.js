#!/usr/bin/env node

// The pull request calls the pipe makes: the title for the prompt, the report
// comment, and the pull request that carries a fix found outside one.
//
// They are REST calls with the step's own token (BITBUCKET_OAUTH_TOKEN, scoped
// by the step's `auth.system.scopes`), sent to api.bitbucket.org rather than
// through the Pipelines proxy, which sits on the build container's loopback
// where a pipe cannot reach it. The token reaches this script through the
// environment and is never printed or put on a command line; a call without
// one is sent unauthenticated, which a public repository answers.
//
//   node bitbucket-api.js pr-title --id <id>
//   node bitbucket-api.js upsert-comment --id <id> --body-file <path>
//   node bitbucket-api.js create-pr --source <branch> --target <branch> --title <title>
//                                   (--body-file <path> | --description <text>)
//
// Reads BITBUCKET_OAUTH_TOKEN and BITBUCKET_REPO_FULL_NAME from the environment.
// A failure is reported on stderr, so what pr-title prints is the title alone.

'use strict';

const fs = require('fs');
const annotations = require('./annotations.js');

/** The text the report comment is found by, the same one the report's header carries. */
const REPORT_MARKER = 'IronBee Verification Report';

const API_URL = 'https://api.bitbucket.org/2.0';

/** The largest page the comment listing serves. */
const PAGE_LENGTH = 100;

function createClient({ baseUrl, token, repository, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const segments = String(repository || '').split('/');
  if (segments.length !== 2 || segments.some((segment) => segment === '')) {
    throw new Error(`BITBUCKET_REPO_FULL_NAME must be <workspace>/<repository> (got '${String(repository || '')}')`);
  }
  const api = String(baseUrl).replace(/\/+$/, '');
  const root = `${api}/repositories/${segments.map(encodeURIComponent).join('/')}`;

  /**
   * A path under the repository, or a `next` link the API handed back. A link
   * is followed only under the repository's own root, so the token never goes
   * anywhere a response named.
   */
  async function request(method, pathOrUrl, body) {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${root}${pathOrUrl}`;
    if (!url.startsWith(`${root}/`)) {
      throw new Error(`Bitbucket API refused to follow a link outside the repository: ${url.split('?')[0]}`);
    }
    const headers = { Accept: 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).trim().slice(0, 300);
      } catch {
        detail = '';
      }
      throw new Error(`Bitbucket API ${method} ${url.slice(root.length).split('?')[0] || '/'} answered ${String(response.status)}`
        + (detail === '' ? '' : `: ${detail}`));
    }
    return response;
  }

  async function pullRequestTitle(id) {
    const pullRequest = await (await request('GET', `/pullrequests/${encodeURIComponent(String(id))}`)).json();
    return typeof pullRequest.title === 'string' ? pullRequest.title : '';
  }

  /**
   * Every comment on the pull request, oldest first — the order GitHub lists
   * issue comments in, so "the first one carrying the marker" names the same
   * comment.
   */
  async function listComments(id) {
    const comments = [];
    let next = `/pullrequests/${encodeURIComponent(String(id))}/comments?pagelen=${String(PAGE_LENGTH)}`;
    while (next) {
      const page = await (await request('GET', next)).json();
      comments.push(...(Array.isArray(page.values) ? page.values : []));
      next = typeof page.next === 'string' && page.next !== '' ? page.next : '';
    }
    return comments;
  }

  /**
   * Updated in place rather than appended to: a pull request that is pushed to
   * repeatedly would otherwise collect one comment per run. Only a live
   * conversation comment counts, as GitHub's issue comments are: an inline
   * comment or a reply quoting the report is somebody else's.
   */
  async function upsertComment(id, body) {
    const comments = await listComments(id);
    const existing = comments.find((comment) => !comment.deleted && !comment.inline && !comment.parent
      && comment.content && typeof comment.content.raw === 'string'
      && comment.content.raw.includes(REPORT_MARKER));
    const base = `/pullrequests/${encodeURIComponent(String(id))}/comments`;
    if (existing) {
      await request('PUT', `${base}/${encodeURIComponent(String(existing.id))}`, { content: { raw: body } });
      return { action: 'updated', id: existing.id };
    }
    const created = await (await request('POST', base, { content: { raw: body } })).json();
    return { action: 'created', id: created.id };
  }

  async function createPullRequest({ sourceBranch, targetBranch, title, description }) {
    const response = await request('POST', '/pullrequests', {
      title,
      description,
      source: { branch: { name: sourceBranch } },
      destination: { branch: { name: targetBranch } },
    });
    return response.json();
  }

  return { pullRequestTitle, listComments, upsertComment, createPullRequest };
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 || at === argv.length - 1 ? '' : argv[at + 1];
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const client = createClient({
    baseUrl: API_URL,
    token: process.env.BITBUCKET_OAUTH_TOKEN,
    repository: process.env.BITBUCKET_REPO_FULL_NAME,
  });

  if (command === 'pr-title') {
    console.log(await client.pullRequestTitle(flag(argv, '--id')));
    return;
  }
  if (command === 'upsert-comment') {
    const body = fs.readFileSync(flag(argv, '--body-file'), 'utf8');
    const result = await client.upsertComment(flag(argv, '--id'), body);
    console.log(`${result.action === 'updated' ? 'Updated' : 'Posted'} the report comment on #${flag(argv, '--id')}`);
    return;
  }
  if (command === 'create-pr') {
    const bodyFile = flag(argv, '--body-file');
    const description = bodyFile === '' ? flag(argv, '--description') : fs.readFileSync(bodyFile, 'utf8');
    const created = await client.createPullRequest({
      sourceBranch: flag(argv, '--source'),
      targetBranch: flag(argv, '--target'),
      title: flag(argv, '--title'),
      description,
    });
    const link = created.links && created.links.html && created.links.html.href;
    console.log(link || `#${String(created.id)}`);
    return;
  }
  throw new Error(`unknown command '${String(command)}' — expected pr-title, upsert-comment or create-pr`);
}

module.exports = { createClient, REPORT_MARKER, API_URL };

if (require.main === module) {
  main().catch((error) => {
    console.error(annotations.format('error', error.message));
    process.exitCode = 1;
  });
}
