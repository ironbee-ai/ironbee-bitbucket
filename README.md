# IronBee Bitbucket Pipe

Bitbucket Pipe for [IronBee CLI](https://github.com/ironbee-ai/ironbee-cli) — Verify and fix code changes using IronBee DevTools (browser, backend, and Node.js modes) with Claude Code.

It is the Bitbucket twin of the [IronBee GitHub Action](https://github.com/ironbee-ai/ironbee-action) and the [IronBee GitLab component](https://gitlab.com/ironbee-ai/ironbee-gitlab): the same inputs, the same decisions, the same report, and the same steps, with only what Bitbucket forces done differently.

## Demo

https://github.com/user-attachments/assets/4015258a-a6d5-45dd-8ddf-5d736d489436

## What It Does

The IronBee pipe verifies your code changes against a running application, fixes what it finds, and reports on the pull request.

## Two ways to verify

The verification itself can run in one of two places. Everything after it — the verdict, the fix, the commit, the report — is the same either way.

| | **Platform** | **Local** |
|---|---|---|
| Where the agent runs | IronBee's infrastructure | inside the pipe, on your step |
| Model cost | IronBee's | your Anthropic account |
| Step setup | none — no Chromium, no DevTools install | Chromium, DevTools, MCP, ~2 minutes |
| Needs an Anthropic credential | only to fix what it finds | yes |
| Evidence | in the IronBee Console | Console **and** the step's artifacts |
| Private repositories | needs the IronBee app for Bitbucket (the workspace connected on the IronBee Console) | works with any checkout |

`VERIFICATION_MODE` picks between them and defaults to `auto`:

- the repository is **public** → **platform**. A public repository can be checked out without the IronBee app.
- the repository is **private** and an Anthropic credential is set → **local**. A private repository needs the IronBee app, and whether it is installed is the one thing the pipe cannot check for free — so it uses the engine it knows can run. **If the app does cover your repository, set `VERIFICATION_MODE: platform`.**
- the repository is **private** with no Anthropic credential → **platform**, because it is the only engine available. If the app is missing the run fails saying so — set `IRONBEE_BIND_REPOSITORY: 'false'` to verify the application without a checkout instead.

## What a run does

1. Resolve the plan — mode, target, changeset — and refuse anything that cannot work, before installing anything
2. Verify: start a platform job and follow it, or run the agent here
3. Fix what a failing verdict reported, when `VERIFICATION_APPLY_FIX` is on and an Anthropic credential is set
4. Commit the fixes — to the PR branch on a pull request, as a new PR otherwise
5. Report on the pull request, with a link to the run in the IronBee Console

When the workspace is connected to IronBee (the IronBee app for Bitbucket), the platform writes a platform run's findings on the pull request itself: a build status, inline comments with suggested fixes, and a summary. The pipe then leaves its own report comment out and keeps the report in the step log; the `IRONBEE_PLATFORM_PUBLISHES` output says which happened.

## Quick Start

Add these as **secured** repository variables (Repository settings → Pipelines → Repository variables):

| Variable | Needed for |
|----------|------------|
| `IRONBEE_API_KEY` | every run |
| `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) | local mode, and fixing in platform mode |

Then, in `bitbucket-pipelines.yml`, verifying a deployed URL on every pull request — the step defined once, so the other triggers below reuse it:

```yaml
definitions:
  steps:
    - step: &verify
        name: IronBee verify
        max-time: 120
        auth:
          system:
            scopes: [read:pullrequest:bitbucket, write:pullrequest:bitbucket, write:git:bitbucket]
        script:
          - pipe: docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v1
            variables:
              IRONBEE_API_KEY: $IRONBEE_API_KEY
              ANTHROPIC_API_KEY: $ANTHROPIC_API_KEY
              BITBUCKET_OAUTH_TOKEN: $BITBUCKET_OAUTH_TOKEN
              APP_URL: https://staging.example.com
pipelines:
  pull-requests:
    '**':
      - step: *verify
```

A pipe sees the step's default Bitbucket variables, but a repository variable only when the step passes it, so each one the run needs is named under `variables:`. `BITBUCKET_OAUTH_TOKEN` is the step's own token — see [The token](#the-token). To start the application inside the pipe instead, see [Starting the application in the pipe](#starting-the-application-in-the-pipe).

Pin `:v1` for the latest public release, `:v1.1.1` for an exact one, or `:v0`, the internal line used while a change is tried.

## Trigger Modes

Bitbucket names no event, so the pipe reads it from the pipeline: a pull request pipeline has its pull request, and anything else is a push unless `EVENT_NAME` says otherwise.

| Pipeline | `EVENT_NAME` | Verification Mode | Fix Behavior |
|----------|--------------|-------------------|-------------|
| `pull-requests:` | `merge_request` (the default with a pull request) | Diff-based — verifies changed pages | Commits fixes to the PR branch, posts the verification report comment unless the platform publishes the run on the pull request itself |
| `branches:` | `push` (the default otherwise) | Diff-based — verifies changed pages | Creates a fix PR automatically if issues found |
| `custom:`, run by hand | `manual` | Full — verifies entire application | Creates a fix PR automatically if issues found |
| `custom:`, on a schedule | `schedule` | Full — verifies entire application | Creates a fix PR automatically if issues found |

### PR Verification

A `pull-requests:` pipeline runs when a pull request is opened and on every push to it. Reviews the PR diff, verifies affected pages, and posts a verification report comment — unless the platform publishes the run on the pull request itself. Fixes are committed directly to the PR branch.

Bitbucket runs it on the source branch **merged with the destination**; the platform reads the pull request's own head through its API, so the merge commit is never reported as the head. A pull request from a **fork** runs no pipeline at all, so nothing here runs for one.

### Push to Main

```yaml
pipelines:
  branches:
    main:
      - step: *verify
```

Runs on a push to the branch. Reviews the pushed commit against its parent — Bitbucket names no commit a push started from, so a push of several commits is measured by its last — and verifies affected pages. If issues are found, creates a new branch with fixes and opens a PR.

### Scheduled Smoke Test

```yaml
pipelines:
  custom:
    ironbee-nightly:
      - step:
          <<: *verify
          script:
            - pipe: docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v1
              variables:
                IRONBEE_API_KEY: $IRONBEE_API_KEY
                BITBUCKET_OAUTH_TOKEN: $BITBUCKET_OAUTH_TOKEN
                APP_URL: https://staging.example.com
                EVENT_NAME: schedule
```

Then add a schedule for `ironbee-nightly` (Repository settings → Pipelines → Schedules). Runs a full application verification on a schedule. No diff — tests the entire application. Creates a fix PR if issues are found.

### On Demand

The same `custom:` pipeline with `EVENT_NAME: manual`, started from **Pipelines → Run pipeline**, verifies the whole application and is never switched off by `VERIFICATION_AUTO`. Creates a fix PR if issues are found.

Bitbucket Pipelines has no trigger for a pull request comment, so the action's `/ironbee-verify` comment command has no equivalent here.

### Turning Automatic Verification Off

To have **only** a manual pipeline verify anything, while a push or a pull request does nothing. There are two ways, and they cost different things.

**In the pipeline's start conditions — nothing runs at all.** A `custom:` pipeline alone, with no `pull-requests:` or `branches:` entry for the step, never starts by itself: no build minutes, no clone, no image pull.

**Or hand it to the pipe — one variable, and it decides.**

```yaml
- pipe: docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v1
  variables:
    IRONBEE_API_KEY: $IRONBEE_API_KEY
    VERIFICATION_AUTO: $IRONBEE_VERIFICATION_AUTO   # 'false' switches it off
```

The pipe's first real step resolves to "nothing to do", every step after it is skipped, and the pipe ends green in seconds — no verification, no job charged against your quota, no gate.

**What the variable cannot do is give back what ran before it.** By the time the pipe starts, Bitbucket has pulled the step image, cloned the repository, started the services and run the script lines before the pipe — in a pipeline that builds Docker images that is most of the run's cost. So: the variable is the convenient one, the start conditions are the ones that actually save the time.

Neither switches off a run somebody asked for **by name**: a `custom:` pipeline with `EVENT_NAME: manual` still verifies. "Automatic" describes a push and a pull request, not a person pressing a button.

## The token

The report comment, the fix commit and the fix pull request go through `BITBUCKET_OAUTH_TOKEN`, the short-lived token Bitbucket gives every step, scoped by the step's `auth`:

```yaml
auth:
  system:
    scopes: [read:pullrequest:bitbucket, write:pullrequest:bitbucket, write:git:bitbucket]
```

| Scope | What for |
|-------|----------|
| `read:pullrequest:bitbucket` | Reading the pull request (its title, in local mode) and its comments |
| `write:pullrequest:bitbucket` | The report comment, the fix pull request |
| `write:git:bitbucket` | The fix commit and the fix branch |

Pass it to the pipe under `variables:` (`BITBUCKET_OAUTH_TOKEN: $BITBUCKET_OAUTH_TOKEN`): the token is the step's, and Bitbucket does not say that it hands it to a pipe on its own. It dies when the step ends; the pipe never prints it.

The clone's `origin` points at the Pipelines proxy on the build container, which a pipe cannot reach, so the pipe fetches from and pushes to `https://bitbucket.org/<workspace>/<repository>.git` itself, with the token handed to git by a credential helper — never on a command line — and calls `api.bitbucket.org` with it.

Without a token, the pipe still verifies: the report stays in the step log (with a warning), and a run that produced fixes fails saying it has nothing to push them with — the fixes exist only in the pipe. So platform mode without fixing needs none; the token only adds the report comment.

Fix commits carry `[skip ci]` in their message. Bitbucket starts a pipeline for every push, and without it the fix commit would verify itself, and fix itself, forever.

A pipe's variables reach everything the pipe starts. The pipe takes its own variables back out of the environment and hands each step only what the action handed it: the application you start gets no Anthropic key, and the agent no token.

## Starting the application in the pipe

A pipe is a container on the step's **Docker service**: its `localhost` is its own, and an application it starts with `docker compose` runs on that service and publishes its ports there, reached from the pipe as **`host.docker.internal`**. Point `APP_URL` at that name: the pipe counts it as a tunnel target like `localhost`, and bridges the port to `127.0.0.1` once the application answers, which is where the tunnel looks for it.

```yaml
image: atlassian/default-image:5
options:
  runtime:
    cloud:
      version: 3
definitions:
  services:
    docker:
      memory: 7128
  steps:
    - step: &verify
        name: IronBee verify
        size: 2x
        max-time: 120
        services: [docker]
        auth:
          system:
            scopes: [read:pullrequest:bitbucket, write:pullrequest:bitbucket, write:git:bitbucket]
        script:
          - pipe: docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v1
            variables:
              IRONBEE_API_KEY: $IRONBEE_API_KEY
              CLAUDE_CODE_OAUTH_TOKEN: $CLAUDE_CODE_OAUTH_TOKEN
              BITBUCKET_OAUTH_TOKEN: $BITBUCKET_OAUTH_TOKEN
              APP_START_COMMAND: docker compose up -d --build
              APP_RESTART_COMMAND: docker compose up -d --build
              APP_LOGS_COMMAND: docker compose logs --no-color --tail=2000
              APP_URL: http://host.docker.internal:4000
              APP_WAIT_SECONDS: '300'
pipelines:
  pull-requests:
    '**':
      - step: *verify
```

What each line is for:

- **`runtime: cloud: version: 3`** — Compose builds need Buildx, which the default runtime disables. The pipe carries its own Docker CLI with Compose and Buildx and drives the step's Docker daemon (`DOCKER_HOST`).
- **`image: atlassian/default-image:5`** — runtime v3 no longer mounts the Docker CLI into the step, and Bitbucket starts the pipe with a `docker run` from the step image, so that image must carry the Docker CLI. `atlassian/default-image:5` does.
- **`services: [docker]` with `memory: 7128` on `size: 2x`** — the pipe, every image build and every container of the application share the Docker service's memory: up to 3 072 MB on `1x` and 7 128 MB on `2x`.
- **`max-time: 120`** — see [Give the step enough time](#give-the-step-enough-time).

`APP_WAIT_SECONDS` is how long both the bridge and the CLI wait for the application to answer.

### What it costs

A `2x` step spends two build minutes for every minute it runs, and a Free workspace has 50 build minutes a month. A run that starts an application stack typically spends 20 to 40 build minutes — so on Free, a pull request or two exhausts the month. Plan on Standard or above for regular use, or verify a deployed URL, which needs no Docker service and runs on `1x`.

## Give the step enough time

The pipe prints the `max-time` its configuration needs, at the top of the run. Set at least that much on the step:

```yaml
- step:
    max-time: 120
```

A pipe cannot read its step's `max-time`, so the number is printed, not checked. Bitbucket's default is 120 minutes. When the step is killed mid-run the verification job is cancelled and the run reads as a platform failure, which is the one failure mode worth spending a line of configuration to avoid.

## Protected deployments

A preview deployment behind SSO or a protection bypass answers 401 or 403 to the verification, and the run would report on the login page. The pipe refuses that case in preflight, by name.

An SSO redirect that answers **200** with a login page cannot be told apart from an application by a status code, so it is not caught — the verdict will describe the login page.

Two ways past it:

- **`APP_SECRET_HEADERS`** — if the protection can be bypassed with a header, put it there. The value is encrypted before it is stored and is never returned by the API. It is readable inside the run itself, which is the caller's own verification of the caller's own deployment; do not use this field for anything that protects more than the target.
- **Verify in the pipe instead** — set `APP_START_COMMAND` and `APP_PORT`, and leave `APP_URL` empty. This verifies the application rather than the deployment: edge configuration, rewrites and the built artifact are not exercised.

## Usage Examples

Each example shows the pipe's `variables:`; the step around it is the [Quick Start](#quick-start)'s.

### With Application Configuration

```yaml
- pipe: docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v1
  variables:
    IRONBEE_API_KEY: $IRONBEE_API_KEY
    APP_BUILD_COMMAND: npm run build
    APP_START_COMMAND: npm run dev
    APP_URL: http://localhost:3000
```

An application started this way runs inside the pipe's own container, so `localhost` is right here; one started with `docker compose` is on the step's Docker service — see [Starting the application in the pipe](#starting-the-application-in-the-pipe).

### With Custom Instructions

```yaml
- pipe: docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v1
  variables:
    IRONBEE_API_KEY: $IRONBEE_API_KEY
    VERIFICATION_PROMPT: Focus on the checkout flow and payment form validation
    CLAUDE_CODE_MAX_TURNS: '30'
```

### With OAuth Token

Add `CLAUDE_CODE_OAUTH_TOKEN` as a secured repository variable instead of `ANTHROPIC_API_KEY`, and pass it: `CLAUDE_CODE_OAUTH_TOKEN: $CLAUDE_CODE_OAUTH_TOKEN`.

### Commit the IronBee Config to the Repo

The files IronBee generates (`.ironbee/`, `.claude/`, `.mcp.json`, `.gitignore`) are kept out of the commits this pipe makes, because they are its working files rather than the change being verified. Turn that off to let a run commit the setup it generated — useful if you want it available for local development:

```yaml
    IRONBEE_EXCLUDE_FILES: 'false'
```

### With Custom IronBee Console URL

The report includes a link to the IronBee Console for the verification session. The host is derived from `IRONBEE_COLLECTOR_URL`'s stage, falling back to `console.ironbee.ai`. Name it explicitly if you self-host:

```yaml
    IRONBEE_CONSOLE_URL: console.example.com
```

### Enable Additional DevTools Platforms

By default only the browser platform runs. Opt into the others when you want IronBee to verify those layers too. They apply to **local mode** — a platform run uses the platforms its harness declares:

```yaml
    IRONBEE_BROWSER_DEVTOOLS: 'true'
    IRONBEE_BACKEND_DEVTOOLS: 'true'
    IRONBEE_NODE_DEVTOOLS: 'false'
    IRONBEE_PYTHON_DEVTOOLS: 'false'
    # A PTY in the pipe — enable it only when the CLI is what you are verifying.
    IRONBEE_TERMINAL_DEVTOOLS: 'false'
```

### Raw Config Overrides

For any IronBee CLI setting not exposed as a dedicated variable, pass a JSON object via `IRONBEE_EXTRA_CONFIG`. It is deep-merged into the generated `.ironbee/config.json` and user keys win:

```yaml
    IRONBEE_EXTRA_CONFIG: >-
      {"verification": {"enable": true},
       "browserDevTools": {"env": {"LOG_FILE": "/tmp/browser-devtools.log"}}}
```

### Verbose Logging

```yaml
    VERBOSE: 'true'
```

## Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| **Where the verification runs** | | | |
| `VERIFICATION_MODE` | No | `auto` | `auto`, `platform`, or `local` — see [Two ways to verify](#two-ways-to-verify) |
| **IronBee — account & endpoints** | | | |
| `IRONBEE_API_KEY` | Yes | `${IRONBEE_API_KEY}` | IronBee API key. Authenticates the collector, and the platform API in platform mode |
| `IRONBEE_API_URL` | No | | IronBee API base URL. Empty uses the CLI default |
| `IRONBEE_COLLECTOR_URL` | No | | IronBee collector endpoint URL. Empty uses the CLI default — and leaving it empty is what lets the CLI resolve every other service URL to the same stage, since an explicit one here is how it infers which stage that is. The application's own commands run with the resolved URL as `IRONBEE_COLLECTOR_URL` and the key as `IRONBEE_API_KEY` in their environment, so a service whose OTel collector reads them ships its traces and logs to the verification session |
| `IRONBEE_CONSOLE_URL` | No | | IronBee Console hostname (no scheme) for session links in the report. Empty derives it from `IRONBEE_COLLECTOR_URL`, so a non-production collector does not produce production links |
| `IRONBEE_CLI_VERSION` | No | `latest` | IronBee CLI version to install. Empty means `latest`, so a `$VARIABLE` that resolves to nothing still works |
| `IRONBEE_PROJECT` | No | | Project the results attach to. Empty derives it from the git remote |
| `IRONBEE_ENVIRONMENT` | No | | Environment the run is against, by name — selects that environment's variables and secrets on top of the project-wide ones. An unknown name is created by the first run that uses it. Empty falls back to a deployment step's environment (`BITBUCKET_DEPLOYMENT_ENVIRONMENT`) |
| **IronBee — the verification job** (platform mode only) | | | |
| `IRONBEE_BIND_REPOSITORY` | No | `true` | Bind the run to the repository so the agent reads the changeset. Turn it off to verify the application without repository context — what a private repository the IronBee app for Bitbucket does not cover needs |
| `IRONBEE_JOB_TIMEOUT_MINUTES` | No | | Run timeout for the verification job. Empty uses the API default |
| **IronBee — DevTools platforms** (local mode only) | | | |
| `IRONBEE_BROWSER_DEVTOOLS` | No | `true` | Web UI, DOM, console, a11y, screenshots, recording |
| `IRONBEE_BACKEND_DEVTOOLS` | No | `false` | HTTP, gRPC, GraphQL, WebSocket, DB, logs |
| `IRONBEE_NODE_DEVTOOLS` | No | `false` | Node.js runtime — tracepoints, exceptions, variables, HTTP capture |
| `IRONBEE_PYTHON_DEVTOOLS` | No | `false` | Python runtime (debugpy) — tracepoints, exceptions, logs, thread dumps |
| `IRONBEE_TERMINAL_DEVTOOLS` | No | `false` | CLI, REPL and TUI verification by driving a PTY. **This gives the agent a shell in the pipe** — enable it only where that is the thing being verified |
| **IronBee — config & repo hygiene** | | | |
| `IRONBEE_EXTRA_CONFIG` | No | | Raw IronBee config (JSON) deep-merged into `.ironbee/config.json`; user keys win |
| `IRONBEE_EXCLUDE_FILES` | No | `true` | Keep IronBee-generated files (`.ironbee/`, `.claude/`, `.mcp.json`, `.gitignore`) out of the commits this pipe makes. Turn it off to let a run commit the IronBee setup it generated |
| **Claude Code — auth** | | | |
| `ANTHROPIC_API_KEY` | Yes* | `${ANTHROPIC_API_KEY}` | Anthropic API key for Claude Code |
| `CLAUDE_CODE_OAUTH_TOKEN` | No* | `${CLAUDE_CODE_OAUTH_TOKEN}` | Claude Code OAuth token (alternative auth) |
| **Claude Code — install & runtime** (local mode only) | | | |
| `CLAUDE_CODE_CLI_VERSION` | No | `latest` | Claude Code CLI version to install. Empty means `latest` |
| `CLAUDE_CODE_MODEL` | No | | Claude model for the agent that runs in the pipe. Platform mode uses the platform default |
| `CLAUDE_CODE_MAX_TURNS` | No | `100` | Maximum conversation turns for the agent that runs in the pipe |
| `CLAUDE_CODE_ARGS` | No | | Additional Claude Code CLI arguments |
| **What to verify, and what to do about it** | | | |
| `VERIFICATION_PROMPT` | No | | Additional instructions for the verification agent. Reaches whichever engine runs |
| `VERIFICATION_AUTO` | No | `true` | Off means only a manual pipeline verifies anything; a push or a pull request does nothing. It cannot save what runs before the pipe; the pipeline's start conditions do that — see [Turning Automatic Verification Off](#turning-automatic-verification-off) |
| `VERIFICATION_APPLY_FIX` | No | `true` | Apply fixes for the issues a failing verification reports. Needs an Anthropic credential; without one the run verifies and reports only |
| **Application under test** | | | |
| `APP_INSTALL_COMMAND` | No | | Command to install dependencies |
| `APP_BUILD_COMMAND` | No | | Command to build the application |
| `APP_START_COMMAND` | No | | Command to start the application. It runs with `IRONBEE_COLLECTOR_URL` and `IRONBEE_API_KEY` in its environment, the collector of this run's stage, for the application's own telemetry |
| `APP_URL` | No | | Application URL for verification. A **routable** URL is verified as a deployment; a `localhost` one — or `host.docker.internal`, or a dotless host — means the application runs in this step and is reached through a reverse tunnel |
| `APP_PORT` | No | | Local port the application listens on, for a tunnelled target. Required when `APP_START_COMMAND` is set without an `APP_URL`, or when `APP_URL` points at localhost without a port. No default — a guessed port tunnels to nothing. The port in `APP_URL` wins when both name one |
| `APP_RESTART_COMMAND` | No | | Command that restarts the application so it picks up the fixes, run between the fix round and the re-verification. Empty stops the process this pipe started and re-runs `APP_START_COMMAND` — right only when that command runs the application itself. One that hands off (docker compose, a process manager) leaves the pre-fix code running, and the re-verification then reports a confident result about code that no longer exists. For a compose project: `docker compose up -d --build`. Like `APP_START_COMMAND`, it runs with `IRONBEE_COLLECTOR_URL` and `IRONBEE_API_KEY` in its environment |
| `APP_LOGS_COMMAND` | No | | Command that prints the application's own logs, captured into the evidence artifact. Needed whenever `APP_START_COMMAND` hands off — what the pipe captures then is lifecycle chatter, not the application, so a service that died or stopped consuming leaves no trace. For compose: `docker compose logs --no-color --tail=2000` |
| `APP_WAIT_SECONDS` | No | | How long to wait for the local application to accept connections. Empty uses the CLI default (60s) |
| `APP_HEADERS` | No | | Request headers for a deployed URL, one `Name: value` per line. **Non-secret values only** — they are stored in the clear and readable by anyone with any of the account's credentials |
| `APP_SECRET_HEADERS` | No | | Request headers whose values are secret — a deployment-protection bypass, an environment token. Same `Name: value` per line, from a secured variable. Encrypted before storage and never read back |
| **Bitbucket** | | | |
| `BITBUCKET_OAUTH_TOKEN` | No | `${BITBUCKET_OAUTH_TOKEN}` | The step's token, for pull request operations — see [The token](#the-token) |
| `EVENT_NAME` | No | | What started the pipeline: `merge_request` and `push` are told apart on their own; a `custom:` pipeline sets `manual` or `schedule` — see [Trigger Modes](#trigger-modes) |
| **Pipe — general behaviour** | | | |
| `WORKING_DIRECTORY` | No | `.` | Working directory for verification, relative to the clone |
| `VERBOSE` | No | `false` | Log tool responses, the prompt, the artifact list and verdict details |

Every `true`/`false` variable also accepts `1`/`0`, `yes`/`no` and `on`/`off`. Anything else fails the run naming the variable — Bitbucket does not type-check a pipe's variables, so a value nobody validates is a setting that silently did not apply. A variable passed empty is empty, not its default.

Bitbucket expands `$NAME` references in a pipe's variables when it starts the pipe, from the step's environment — that is how `$IRONBEE_API_KEY` reaches it. A command that needs a variable of its own expanded when it runs is better kept in a script file the command calls.

*Required for local mode, and for fixing in platform mode. A platform run that only verifies needs neither.

## Outputs

The pipe writes its outputs to `.ironbee/outputs.env` in the clone, which the step's later script lines and its `after-script` can read. A step that declares them in `output-variables:` gets them as variables of the steps after it, when the pipe can reach the step's variables file:

```yaml
- step:
    output-variables: [IRONBEE_VERDICT, IRONBEE_JOB_URL]
    script:
      - pipe: docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v1
        variables:
          IRONBEE_API_KEY: $IRONBEE_API_KEY
```

| Variable | Description |
|----------|-------------|
| `IRONBEE_VERDICT` | `pass`, `fail`, `not_applicable`, or `unknown` |
| `IRONBEE_MODE` | Where the verification ran: `platform` or `local` |
| `IRONBEE_JOB_ID` | Verification job id — platform mode only |
| `IRONBEE_JOB_URL` | IronBee Console link for the run — platform mode only, once the job has started |
| `IRONBEE_ARTIFACTS_URL` | The step's page, whose Artifacts tab holds the verification evidence — **local mode only**. In platform mode the evidence is captured on the platform and lives in the Console; this output is empty |
| `IRONBEE_PLATFORM_PUBLISHES` | `true` when the platform publishes the run on the pull request itself, so the pipe posted no report comment; `false` otherwise, and always in local mode |

## How It Works

### Verification Flow

1. **Setup** — Installs `@ironbee-ai/cli`, `@anthropic-ai/claude-code`, `@ironbee-ai/devtools`, and Playwright Chromium (cached across runs)
2. **Configure** — Writes `.ironbee/config.json` with the collector URL, the DevTools platform enable flags, and the MCP `LOG_FILE` paths under `.ironbee/artifacts/` (deep-merging `IRONBEE_EXTRA_CONFIG` on top), then runs `ironbee install --client claude` to set up hooks, skills, rules, and MCP config. The IronBee API key is passed via the `IRONBEE_API_KEY` env var (not written to disk) and inherited by hooks and MCP subprocesses
3. **Verify** — Claude Code runs `/ironbee-verify` (or `/ironbee-verify full` for manual/scheduled) which:
   - Reviews the code diff (push/PR) or tests the full app (manual/scheduled)
   - Builds and starts the application
   - Records sessions via the enabled DevTools modes and takes screenshots
   - Tests functionality and checks for errors
   - Submits a verdict (pass/fail)
4. **Fix** — If verification fails, Claude Code fixes the issues and re-verifies
5. **Report** — Posts a verification report on the PR with a session-level IronBee Console link, per-cycle verification links (`activityId` + `verificationId`), and a link to the evidence artifacts. Bitbucket has no step summary, so the report is also printed in the step log under its own header and kept as `report.md` in `.ironbee/upload/`

### Fix Behavior

- **PR trigger** — fixes are committed and pushed to the PR branch
- **Push / Manual / Scheduled** — fixes go to a new branch and a PR is opened

The pipe performs the commit and the push itself. The agent only edits files.

### Re-verification after a fix

One fix round per run, and a re-verification only where it can mean something.

A **tunnelled** target is re-verified: the application is restarted with the fixed code and a second verification runs. A **deployed URL** is not — the deployment still serves the code that was deployed, so a second run would verify the same bytes and report a result unrelated to the fix. There the loop closes when the fix is deployed and the pipeline runs again.

### Evidence Collection

Screenshots and recordings are organized by verification cycle:

```
.ironbee/artifacts/
  cycle-1/
    screenshots/homepage-before-fix.png
    recordings/verification.webm
  cycle-2/
    screenshots/homepage-after-fix.png
    recordings/verification.webm
```

The pipe copies into `.ironbee/upload/` what the action uploads: in local mode the evidence above, when the run produced any, linked in the PR comment; the application log (`app.log`, and `app-service-logs.txt` from `APP_LOGS_COMMAND`) whenever the pipe started the application; and, in both modes, `report.md`, in place of a step summary. Keep them with the step's `artifacts:`:

```yaml
- step:
    artifacts:
      - .ironbee/upload/**
```

A platform run's evidence lives in the IronBee Console.

### Caching

Playwright Chromium binaries (~200MB) are kept between runs by a custom cache of the step. A pipe keeps nothing outside the clone, so they live in `.cache/ms-playwright` there (`PLAYWRIGHT_BROWSERS_PATH`), and the pipe tells git to ignore it:

```yaml
definitions:
  caches:
    playwright: .cache/ms-playwright
# and on the step:
#   caches: [playwright]
```

Browser downloads during `npm install` are skipped (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true`) and installed separately with system dependencies.

## Development

This repository lives on GitHub ([github.com/ironbee-ai/ironbee-bitbucket](https://github.com/ironbee-ai/ironbee-bitbucket)), where its workflows run the tests and publish the image.

```sh
node --test tests/*.test.js
bash -n pipe.sh scripts/run.sh
docker build -t ironbee-bitbucket:dev .
```

To try unreleased code from a real pipeline, push a `v0` tag at it (the image is built as `:v0`) and point the step at `docker://ghcr.io/ironbee-ai/ironbee-bitbucket:v0`.

## Releasing

1. Bump the version in `pipe.yml`'s `image:` (a test holds the examples in this README and `CLAUDE.md` to its line)
2. Merge to `main`, then tag the commit `vX.Y.Z` and push the tag
3. The tag's workflow tests the scripts, checks the tag against `pipe.yml`, builds the image, pushes it to `ghcr.io/ironbee-ai/ironbee-bitbucket` as `:vX.Y.Z` and `:vX`, and moves the `vX` tag to the same commit
4. `v0` is moved by hand to whatever commit is being tried; pushing it builds `:v0`

The version and the tags move in step with `ironbee-action`: the same number on both, `v1` the public line, `v0` the internal one.

The package must be public (the organization's package settings, once): Bitbucket runs a pipe only from a public image.

## License

MIT
