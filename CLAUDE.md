# IronBee Bitbucket Pipe

Bitbucket Pipe for IronBee CLI — Verify and fix code changes using IronBee DevTools (browser, backend, Node.js) with Claude Code.

## Project Overview

This is a **Bitbucket Pipe** that orchestrates [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) and [Claude Code CLI](https://github.com/anthropics/claude-code) to automatically verify code changes in a browser and fix issues found. Supports pull request, branch push, `custom:` (manual) and scheduled pipelines.

**It is the GitHub Action [ironbee-action](https://github.com/ironbee-ai/ironbee-action), and must behave exactly like it.** Same inputs (as variables), same defaults, same decision logic, same messages, same report, same step order, same comments. The only differences are the ones Bitbucket forces (below). A change to the action is ported here by copying, and a change here that is not Bitbucket-forced belongs in the action first. The GitLab component ([ironbee-gitlab](https://gitlab.com/ironbee-ai/ironbee-gitlab)) is the same port for GitLab; this one started from it, so a diff against either shows the host-forced lines.

Consumers use it as a step of their `bitbucket-pipelines.yml`:

```yaml
- step:
    services: [docker]
    script:
      - pipe: docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v1
        variables:
          IRONBEE_API_KEY: $IRONBEE_API_KEY
```

## Two verification modes

The verification runs either on the **IronBee platform** (a verification job created through `ironbee verify run web`, followed to a verdict) or **locally** (Claude Code inside the pipe). `VERIFICATION_MODE` picks; `auto` reads the repository's visibility and whether an Anthropic credential is set.

Everything after the verdict is shared: the fix round, the commit, the pull request, the report. That is why the agent does not commit — where a fix lands depends on the trigger, and a step decides it.

Platform mode skips every local-only setup step (Chromium, DevTools, MCP, `ironbee install`), which is most of the step's time.

## The application's own telemetry

`APP_START_COMMAND` and `APP_RESTART_COMMAND` run with `IRONBEE_COLLECTOR_URL` (the
collector of this run's stage, resolved by `resolve-plan.js` so an empty variable still
names the default stage) and `IRONBEE_API_KEY` in their environment. A service whose
OTel collector reads them ships its traces and logs into the verification session.
Nothing is written to disk for it; the values live only in those steps' environments.

## Architecture

A pipe is a **Docker image**, which Bitbucket runs as a container on the step's Docker service, with the clone mounted as its working directory and the step's default variables plus the pipe's own `variables:` in its environment. `pipe.yml` is the pipe's metadata (Bitbucket reads it only for the `pipe: <workspace>/<repository>:<tag>` short form; it has no `required`), and `Dockerfile` builds the image the release workflow pushes to `ghcr.io/ironbee-ai/ironbee-bitbucket`.

**`pipe.sh` is the entry point.** It moves each pipe variable to the `INPUT_<NAME>` the steps read, with `pipe.yml`'s default when the step passed none, and takes the variable itself out of the environment; checks what the pipe cannot run without (the step's own variables, `EVENT_NAME`); makes the clone a safe directory and sets the git credential helper; resolves the short commit of a pull request pipeline; and runs `scripts/run.sh`. Sourcing `pipe.sh` defines its table and helpers and stops.

**`run.sh` is `action.yml`'s `steps:`, one to one.** Every step is a block in the same order, under the same name, with the same condition and the same body. A step is a function run by `run_step` in a subshell with `set -eo pipefail` (how GitHub runs a `shell: bash` step); its outputs go to `.ironbee/step-<id>.txt` in the action's `key=value` / `key<<DELIM` format (`IRONBEE_OUTPUT` replaces `GITHUB_OUTPUT`) and come back as `ID_key` variables through `read_outputs`, which reads line by line and never sources. `success()` is GitHub's: a failing step stops the later steps that are not `always()`, the `always()` ones still run, and the pipe ends red. The gate is still the last step. Sourcing `run.sh` defines its helpers and stops, which is how the tests reach them.

**Decisions live in `scripts/`, not in shell.** A decision written in `run.sh` cannot be tested: there is no way to ask "what would this do for a private repository with no Anthropic key" short of pushing a commit and waiting for a pipeline. Every branch — the mode, the target, the port, the repository binding, the verdict, the report, the fix prompt — is a pure function in a script with a test beside it. The steps invoke commands and wire outputs, and that is all.

## The differences Bitbucket forces, and nothing else

1. **Packaging** — a pipe: a public image built from this repository, `pipe.yml` its metadata, `pipe.sh` its entry point. Everything that places it is the consumer's step: the step image, `size`, `services`, `max-time`, `auth`, `artifacts`, `caches`, a `deployment`.
2. **Variables** — the action's inputs as upper-case variables (`VERIFICATION_MODE`, `IRONBEE_API_KEY`, `APP_START_COMMAND`, …), so every message names the variable the pipeline wrote. `pipe.yml` declares each with its default and `pipe.sh` applies it; a variable passed empty is empty, as a component input given an empty value is. The credentials default to the pipeline variables of their own names. `BITBUCKET_OAUTH_TOKEN` replaces `github_token`; `EVENT_NAME` is new; `verification_command` is gone, and so are GitLab's `stage`, `job_name` and `image` (the step's own keys).
3. **Context** — Bitbucket names no event: `EVENT_NAME` defaults to `merge_request` when `BITBUCKET_PR_ID` is set and `push` otherwise, and a `custom:` or scheduled pipeline sets it to `manual` or `schedule`, which `resolve-plan.js` reads as GitLab's mapped pipeline source; `pipe.sh` refuses any other value. `BITBUCKET_COMMIT` is 12 characters on a pull request pipeline, so `pipe.sh` resolves it. Bitbucket has no push-before commit, so a push binds to where it left its destination branch: the merge base of its commit with the pull request's destination (`BITBUCKET_PR_DESTINATION_BRANCH`), else with the repository's main branch (read by `git ls-remote --symref` in the fetch step), and the commit's parent when there is neither or the push is on that branch. A fork's pull request runs no pipeline, so `IS_FORK` is `false`. Privacy is `BITBUCKET_REPO_IS_PRIVATE`. `IRONBEE_ENVIRONMENT` falls back to a deployment step's `BITBUCKET_DEPLOYMENT_ENVIRONMENT`. There is no title variable: the local prompt reads the pull request's title through `bitbucket-api.js pr-title`, and goes without it when that fails.
4. **Environment** — a pipe's variables reach every process it starts. `pipe.sh` moves each to `INPUT_<NAME>` and unsets it; `run.sh` un-exports the `INPUT_*` values (and the credentials' own names, should anything have left them), and each step exports what the action's `env:` did.
5. **Git and tokens** — the clone's `origin` is the Pipelines proxy on the build container's loopback, which a pipe cannot reach, so every fetch and push goes to `REPOSITORY_URL` (`https://bitbucket.org/$BITBUCKET_REPO_FULL_NAME.git`). `pipe.sh` sets a global credential helper for `https://bitbucket.org` that answers `x-token-auth` and `$BITBUCKET_OAUTH_TOKEN` from the environment of the git it serves; the steps that fetch or push export the token from its input, and nothing else does, so the agent's git has none. The fetch uses `origin`'s refspec, so branches land at `origin/<branch>` as the action's fetch puts them. The clone is mounted from the build container, so it is a `safe.directory`; a pipe has no terminal, so `GIT_TERMINAL_PROMPT=0`. The `gh` calls are `bitbucket-api.js`: REST with `Bearer $BITBUCKET_OAUTH_TOKEN` at `api.bitbucket.org`. No token: the report stays in the log; fixes to push fail the step, naming `BITBUCKET_OAUTH_TOKEN`.
6. **No comment command** — Bitbucket Pipelines has no trigger for a pull request comment: `parse-command.js`, the comment steps and the reactions are left out.
7. **Annotations and groups** — `annotations.js` (and its bash twin in `run.sh`) prints `ERROR:` / `WARNING:` / `NOTICE:` with the same text; a step's box and `::group::` are a header line, since a pipe's log has no collapsible sections. No step summary: in its place the report is printed under its own header and copied to `.ironbee/upload/report.md`, in both modes. The report is Markdown alone, since Bitbucket shows raw HTML as text: the header icon is `![IronBee](…)` with no size, and the session-end diagnostics sit under a bold heading rather than in `<details>`.
8. **Masking** — the CLI's `::add-mask::` lines are dropped, not re-emitted: Bitbucket has no runtime masking and would print them.
9. **Timeout** — the floor is printed as the `max-time` the step needs; a pipe cannot read its step's `max-time`, so nothing is compared with it.
10. **The network** — a pipe is a container on the step's Docker service: its `localhost` is its own, and an application started with `docker compose` publishes its ports on the service, reached as `host.docker.internal`. `isNonRoutableHost` counts that name as non-routable, `resolve-plan.js` puts the tunnel target's host in `target_host`, and for a host other than the loopback `forward-port.js` bridges `127.0.0.1:<port>` to it once the upstream answers.
11. **Outputs** — the action's `outputs:` are `.ironbee/outputs.env` (`IRONBEE_VERDICT`, `IRONBEE_MODE`, `IRONBEE_JOB_ID`, `IRONBEE_JOB_URL`, `IRONBEE_ARTIFACTS_URL`, `IRONBEE_PLATFORM_PUBLISHES`), and the same lines are appended to the step's `BITBUCKET_PIPELINES_VARIABLES_PATH` before the gate when the pipe can reach it, for a step that declares them in `output-variables:`.
12. **Cache and artifacts** — the step's custom cache (`.cache/ms-playwright` in the clone, where `pipe.sh` points `PLAYWRIGHT_BROWSERS_PATH`, kept out of git) and `artifacts:` (`.ironbee/upload/**`) replace `actions/cache` and `actions/upload-artifact`. `.ironbee/upload/` is created before the first step and filled at the action's upload steps with what they upload; the artifacts link is the step's page.
13. **The image** — ours, so Setup Node and installing `jq` are gone: Node 22, git, jq, curl, and the Docker CLI with Buildx and Compose (the step image's Docker CLI only starts the pipe). `IS_SANDBOX=1` lets Claude Code skip permissions as root, which the pipe runs as; the git identity is `IronBee <commits-noreply@bitbucket.org>`, Bitbucket's own address for commits a pipeline makes.
14. **Skipping CI on the fix** — GitHub starts no workflow for a `GITHUB_TOKEN` push; Bitbucket starts a pipeline for every push, and `[skip ci]` in the commit message skips it, so both fix commit messages end in ` [skip ci]`. Bitbucket takes no push option.

## Project Structure

```
pipe.yml                    # the pipe's metadata: name, image, variables with defaults
pipe.sh                     # the entry point: variables -> INPUT_*, git, the commit, run.sh
Dockerfile                  # the image: node:22-bookworm, git, jq, curl, Docker CLI + Buildx + Compose
scripts/
  run.sh                    # the pipe's body: action.yml's steps, one to one
  resolve-plan.js           # mode, target, port, repo binding, CLI flags, budget floor
  read-job.js               # `ironbee verify --json` output -> verdict / job_id / job_url /
                            #   failure_code / platform_publishes
  build-report.js           # report markdown, from artifacts (local) or a job body (platform)
  build-fix-prompt.js       # fix-only prompt built from a failing verdict
  fix-paths.js              # the paths a fix touched: a tree snapshot before it, the diff
                            #   after it, and the staging of those paths alone
  build-reverify-prompt.js  # the re-verification's prompt, with the fix round's account
  gate.js                   # whether the run passes
  annotations.js            # ERROR: / WARNING: / NOTICE: and headers, for Bitbucket
  forward-port.js           # 127.0.0.1:<port> -> <host>:<port>, once the upstream answers
  bitbucket-api.js          # the title, the report comment and the fix PR, through the REST API
tests/
  *.test.js                 # node --test, no dependencies
  pipe-inputs.test.js       #   the pipe.yml <-> pipe.sh <-> run.sh <-> resolve-plan.js seams
  pipe-sh.test.js           #   pipe.sh's helpers, and the pipe end to end
  run-sh.test.js            #   run.sh's step machinery and context
.github/workflows/
  build.yml                 # tests, pipe.yml, and the image run on its skipped path
  release.yml               # on a v* tag: the image to ghcr.io, the line tag moved
CLAUDE.md                   # This file
README.md                   # Usage documentation
LICENSE                     # MIT
```

Run the tests with `node --test tests/*.test.js`, and `bash -n pipe.sh scripts/run.sh`.

## Variables

Grouped by area in `pipe.yml` and in `pipe.sh`'s table, in the action's order, and the README table mirrors it.

**Where it runs:** `VERIFICATION_MODE` (`auto` / `platform` / `local`)
**IronBee — account & endpoints:** `IRONBEE_API_KEY` (default `${IRONBEE_API_KEY}`), `IRONBEE_API_URL`, `IRONBEE_COLLECTOR_URL`, `IRONBEE_CONSOLE_URL`, `IRONBEE_CLI_VERSION`, `IRONBEE_PROJECT`, `IRONBEE_ENVIRONMENT`
**IronBee — the job (platform only):** `IRONBEE_BIND_REPOSITORY`, `IRONBEE_JOB_TIMEOUT_MINUTES`
**IronBee — DevTools platforms (local only):** `IRONBEE_BROWSER_DEVTOOLS` (default `true`), `IRONBEE_BACKEND_DEVTOOLS`, `IRONBEE_NODE_DEVTOOLS`, `IRONBEE_PYTHON_DEVTOOLS`, `IRONBEE_TERMINAL_DEVTOOLS`
**IronBee — config & hygiene:** `IRONBEE_EXTRA_CONFIG` (raw JSON, deep-merged into `.ironbee/config.json`), `IRONBEE_EXCLUDE_FILES`
**Claude auth (one required for local mode and fixing):** `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`
**Claude Code — install & runtime (local only):** `CLAUDE_CODE_CLI_VERSION`, `CLAUDE_CODE_MODEL`, `CLAUDE_CODE_MAX_TURNS`, `CLAUDE_CODE_ARGS`
**What to verify:** `VERIFICATION_PROMPT`, `VERIFICATION_AUTO`, `VERIFICATION_APPLY_FIX`
**App:** `APP_INSTALL_COMMAND`, `APP_BUILD_COMMAND`, `APP_START_COMMAND`, `APP_URL`, `APP_PORT`, `APP_RESTART_COMMAND`, `APP_LOGS_COMMAND`, `APP_WAIT_SECONDS`, `APP_HEADERS`, `APP_SECRET_HEADERS`
**Bitbucket:** `BITBUCKET_OAUTH_TOKEN`, `EVENT_NAME`
**Options:** `WORKING_DIRECTORY`, `VERBOSE`

Two naming rules the prefixes encode. `IRONBEE_*` and `CLAUDE_CODE_*` name the **engine
the variable configures**, which is what makes "does nothing in the other mode" readable off
the name; `VERIFICATION_*` carries neither prefix because those variables reach whichever engine
runs.

Every variable is a string, so every boolean is parsed in `resolve-plan.js` against one
vocabulary (`true`/`1`/`yes`/`on`, `false`/`0`/`no`/`off`) and an unrecognised value **fails
the run naming the variable**. Do not add a bare `= true` comparison on a raw input in
`run.sh`: that is a third, narrower vocabulary, and `VERBOSE: on` would then be on in the
generated config and off in the step. `VERBOSE` and `IRONBEE_EXCLUDE_FILES` are read back from
the plan's own outputs for exactly that reason.

A variable added to the pipe goes in three places that a test holds equal: `pipe.yml`
(name and default), `pipe.sh`'s `PIPE_VARIABLES` (the same, in the same order), and the
`INPUT_<NAME>` that `run.sh` or `resolve-plan.js` reads.

The repository binding measures the changeset from the first base that says
something: a push's own base (Bitbucket names none, so the plan step puts the merge base
with the destination branch in `BEFORE_SHA`; on that branch itself it is the commit, an
empty changeset, and the rule falls through), then the commit's first parent, then nothing.
Every other event — a manual pipeline, a schedule — goes straight to the parent. A pull
request binds by its id (`--pr`). The parent is read with `git cat-file commit` rather
than `rev-parse <sha>^`, because a shallow checkout's graft makes git report the commit
as parentless while the object still names it.
A local run's prompt diffs a push against the same base (the plan's `diff_base`), and
falls back to `HEAD~1`, then the empty tree, when this checkout does not have it.

The service endpoints resolve as a set, not one at a time. `IRONBEE_COLLECTOR_URL`
is the CLI's own stage-inference key, so the generated config **omits**
`collector.url` when nobody named one rather than writing a guess. `IRONBEE_CONSOLE_URL`
is the pipe's own (the report builder uses it, not the CLI), so `resolve-plan.js`
derives it from the collector when it is unset and publishes it as the `console_url` step
output. Report steps read that output, never the raw input.

Each mode ignores the other's variables, and `resolve-plan.js` warns in **both** directions
from two tables (`LOCAL_ONLY_INPUTS`, `PLATFORM_ONLY_INPUTS`). Membership is compared
against the variable's declared default, not tested for presence. A new variable
that only one mode reads belongs in one of those tables, with its `pipe.yml` default
copied into `fallback`.

## Outputs

`.ironbee/outputs.env` in the clone, which the step's later lines and its `after-script`
read, and the step's output variables when it declares them:

- `IRONBEE_VERDICT` — `pass` / `fail` / `not_applicable` / `unknown`
- `IRONBEE_MODE` — where the verification ran (`platform` / `local`)
- `IRONBEE_JOB_ID`, `IRONBEE_JOB_URL` — platform mode only
- `IRONBEE_ARTIFACTS_URL` — local mode only; platform evidence lives in the Console
- `IRONBEE_PLATFORM_PUBLISHES` — `true` when the platform publishes the run on the pull request itself; `false` otherwise, and in local mode

## Key Conventions

- No TypeScript, no npm dependencies, no package.json — including the tests, which use Node's built-in runner
- Decision logic goes in `scripts/` with a test beside it, never in `run.sh` or `pipe.sh`
- `run.sh` mirrors `action.yml` step for step; a step added, moved or renamed in the action is added, moved or renamed here
- Copied scripts keep the action's code and comments; they are edited only where Bitbucket forces it, so a diff against the action shows exactly the Bitbucket-forced lines
- Claude Code CLI is called directly with `--output-format stream-json` for live logs
- Browser binaries cached at `$BITBUCKET_CLONE_DIR/.cache/ms-playwright` with the step's custom cache
- Browser downloads skipped during npm install (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true`)
- PR comments are created/updated (not duplicated) through the REST API
- No report comment when the job carries a `publication` (`platform_publishes=true` from `read-job.js`, the re-verified job's answer first): the platform writes that run on the pull request itself, and the report stays in the step log
- User prompt passed via env var or file, never as a shell word
- IronBee API key never written to `.ironbee/config.json`; provided as `IRONBEE_API_KEY` env on the `ironbee install` and `claude` steps
- `BITBUCKET_OAUTH_TOKEN` reaches node through the environment and git through the credential helper; it is never on a command line and never printed
- The pipe performs the commit and the push; the agent only edits files
- The last step in `run.sh` is the gate that exits with the verification's result. Nothing may be added after it but the exit

## Releasing

**The GitHub repository ([github.com/ironbee-ai/ironbee-bitbucket](https://github.com/ironbee-ai/ironbee-bitbucket)) is the pipe's home**: the code, the workflow that tests it, and the workflow that builds and publishes its image to `ghcr.io/ironbee-ai/ironbee-bitbucket`.

- **Version bump rule** — `pipe.yml`'s `image:` names the release (`ghcr.io/ironbee-ai/ironbee-bitbucket:v1.2.3`). Bump it in the commit that is tagged; the release workflow refuses a release tag that differs, and `pipe-inputs.test.js` holds the README's and this file's examples to its line (`:v1`).
- **Versions and tags are the action's.** The release tag is `vX.Y.Z`, the same number as the `ironbee-action` release it pairs with. Pushing it builds the image as `:vX.Y.Z` and `:vX`, and moves the `vX` git tag to the same commit. `v0` is the internal line: moved by hand to whatever is being tried, and pushing it builds `:v0`. A semver tag is never moved or re-pushed.
- The package is made public once, in the organization's package settings: a pipe runs only from a public image.

## Related Projects

- **ironbee-action**: The GitHub Action this pipe mirrors
- **ironbee-gitlab**: The same port for GitLab CI/CD
- **ironbee-cli** (`@ironbee-ai/cli`): The CLI tool this pipe uses for verification hooks
- **claude-code** (`@anthropic-ai/claude-code`): Claude Code CLI
- **ironbee-devtools** (`@ironbee-ai/devtools`): MCP server for IronBee verification, with browser (Playwright), backend, and Node.js modes
