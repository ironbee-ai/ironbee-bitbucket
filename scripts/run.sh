#!/usr/bin/env bash
#
# The pipe's body: the GitHub Action's steps, one to one.
#
# Each block below is one step of the action, in the same order, under the same
# name, with the same condition and the same body. What differs is only what
# Bitbucket forces: a step is a function run in a subshell with `set -eo pipefail`
# (how GitHub runs a `shell: bash` step), its outputs go to a file of its own and
# come back as ID_key variables, `if:` is a bash condition, and `always()` is a
# condition without `success`. A failing step stops the steps after it that are
# not `always()`, and the pipe ends red; the gate is still the last step.
#
# pipe.sh starts it, with the pipe's variables as INPUT_<NAME>s.
#
# The helpers come first, and sourcing this file defines them and stops — the
# tests hold them to the action's semantics that way.

# ── Helpers ──────────────────────────────────────────────────────────

# Bitbucket has no annotations: the same text, with a coloured prefix.
# scripts/annotations.js is the Node twin of these.
annotate_error() {
  printf '\033[31;1mERROR:\033[0m %s\n' "$*"
}
annotate_warning() {
  printf '\033[33;1mWARNING:\033[0m %s\n' "$*"
}
annotate_notice() {
  printf '\033[36;1mNOTICE:\033[0m %s\n' "$*"
}

# GitHub's step boxes and `::group::`, as header lines: a pipe's log has no
# collapsible sections. The name and the collapsed flag have nowhere to go.
section_start() {
  printf '\033[1m▶ %s\033[0m\n' "$2"
}
section_end() {
  :
}
group_start() {
  IRONBEE_GROUP="ironbee_group_${RANDOM}${RANDOM}"
  section_start "$IRONBEE_GROUP" "$1" true
}
group_end() {
  section_end "$IRONBEE_GROUP"
}

set_output() {
  local name="${1}_${2//-/_}"
  if [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    printf -v "$name" '%s' "$3"
  fi
}

# A step's outputs, back as PREFIX_key variables. The two forms GitHub's runner
# reads from GITHUB_OUTPUT — `key=value` and `key<<DELIMITER` — read line by
# line and never sourced: a value is data, not shell.
read_outputs() {
  local prefix="$1" file="$2" line key value delimiter='' started='' before_equals before_heredoc
  if [ ! -f "$file" ]; then
    return 0
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$delimiter" ]; then
      if [ "$line" = "$delimiter" ]; then
        set_output "$prefix" "$key" "$value"
        delimiter=''
      else
        if [ -n "$started" ]; then
          value+=$'\n'
        fi
        value+="$line"
        started=1
      fi
      continue
    fi
    before_equals="${line%%=*}"
    before_heredoc="${line%%<<*}"
    if [ "$before_heredoc" != "$line" ] \
      && { [ "$before_equals" = "$line" ] || [ "${#before_heredoc}" -lt "${#before_equals}" ]; }; then
      key="$before_heredoc"
      delimiter="${line#*<<}"
      value=''
      started=''
    elif [ "$before_equals" != "$line" ] && [ -n "$before_equals" ]; then
      set_output "$prefix" "$before_equals" "${line#*=}"
    fi
  done < "$file"
}

# GitHub's `success()`: no step before this one has failed.
success() {
  [ -z "$STEP_FAILED" ]
}

# One step. Its failure is recorded rather than ending the pipe, because the
# steps after it that run `always()` still have to run.
run_step() {
  local id="$1" title="$2" fn="$3" out prefix code
  prefix="$(printf '%s' "$id" | tr '[:lower:]-' '[:upper:]_')"
  out="$IRONBEE_STATE/step-${id}.txt"
  : > "$out"
  section_start "ironbee_${id//-/_}" "$title"
  (
    set -eo pipefail
    export IRONBEE_OUTPUT="$out"
    "$fn"
  )
  code=$?
  section_end "ironbee_${id//-/_}"
  read_outputs "$prefix" "$out"
  if [ "$code" -eq 0 ]; then
    printf -v "${prefix}_conclusion" '%s' success
  else
    printf -v "${prefix}_conclusion" '%s' failure
    STEP_FAILED="$title"
    annotate_error "${title}: process completed with exit code ${code}"
  fi
}

# The event name resolve-plan.js reads. Bitbucket names no event: a pull
# request pipeline is told apart by its pull request, and nothing tells a
# branch push from a `custom:` or scheduled pipeline, so those say it through
# the pipe's EVENT_NAME (`manual`, `schedule`).
bitbucket_event_name() {
  if [ -n "$1" ]; then
    echo "$1"
  elif [ -n "$2" ]; then
    echo merge_request
  else
    echo push
  fi
}

# Only a repository Bitbucket calls public can be checked out without
# credentials.
bitbucket_repository_private() {
  if [ "$1" = false ]; then
    echo false
  else
    echo true
  fi
}

# Where a push left its destination branch: the merge base of the commit and
# that branch as the fetch put it. Empty when either is unknown here.
bitbucket_push_base() {
  if [ -n "$1" ] && [ -n "$2" ]; then
    git merge-base "$1" "refs/remotes/origin/$2" 2>/dev/null || true
  fi
}

# A step's page, whose Artifacts tab holds what the step's `artifacts:` kept.
# The step's uuid carries braces, which a URL path escapes.
bitbucket_step_url() {
  local uuid="$4"
  uuid="${uuid//\{/%7B}"
  uuid="${uuid//\}/%7D}"
  echo "${1}/${2}/pipelines/results/${3}/steps/${uuid}"
}

# A pipe's variables are in the environment of everything the pipe starts.
# pipe.sh hands them over as INPUT_<NAME>s, and those are taken back out, so
# each step hands a process exactly what the action's `env:` handed it — the
# application gets no Anthropic key, the agent no BITBUCKET_OAUTH_TOKEN.
unexport_inputs() {
  local name
  for name in ${!INPUT_@}; do
    export -n "$name"
  done
}

# The action's `outputs:`, as a dotenv file in the clone, which the step's
# later lines and its after-script read. Written empty at the start, so the
# file exists whatever happens, and again before the gate.
write_outputs_env() {
  local verdict
  if [ "$PLAN_mode" != platform ] && [ -n "$VERDICT_status" ]; then
    verdict="$VERDICT_status"
  else
    verdict="${JOB_REVERIFIED_verdict:-$JOB_verdict}"
  fi
  {
    printf 'IRONBEE_VERDICT=%s\n' "$verdict"
    printf 'IRONBEE_MODE=%s\n' "$PLAN_mode"
    printf 'IRONBEE_JOB_ID=%s\n' "${JOB_REVERIFIED_job_id:-$JOB_job_id}"
    printf 'IRONBEE_JOB_URL=%s\n' "${JOB_REVERIFIED_job_url:-$JOB_job_url}"
    printf 'IRONBEE_ARTIFACTS_URL=%s\n' "$UPLOAD_ARTIFACTS_artifact_url"
    printf 'IRONBEE_PLATFORM_PUBLISHES=%s\n' "${JOB_REVERIFIED_platform_publishes:-${JOB_platform_publishes:-false}}"
  } > "$IRONBEE_STATE/outputs.env"
}

# The same lines as the step's output variables, for a step that declares them
# in `output-variables:`, when the pipe can reach the file Bitbucket reads them
# from. Once, before the gate: the file is appended to, never rewritten.
write_output_variables() {
  if [ -n "${BITBUCKET_PIPELINES_VARIABLES_PATH:-}" ] \
    && [ -d "$(dirname "$BITBUCKET_PIPELINES_VARIABLES_PATH")" ]; then
    cat "$IRONBEE_STATE/outputs.env" >> "$BITBUCKET_PIPELINES_VARIABLES_PATH"
  fi
}

# The start command in the background, its log appended to. Job control is on
# for this one command, so it leads a process group of its own and the restart
# and the stop end it whole, children included. Stdin is /dev/null, as a
# background command's is without job control.
start_app_process() {
  set -m
  nohup bash -c "$APP_START_COMMAND" < /dev/null >> .ironbee/artifacts/app.log 2>&1 &
  echo $! > .ironbee/app.pid
  set +m
}

# The process group the start command leads, so what it spawned stops with
# it; the process alone when it leads none.
stop_app_process() {
  kill -- "-$1" 2>/dev/null || kill "$1" 2>/dev/null || true
}

# A cancelled or timed-out job signals the job's process group, which the
# application, leading its own, is not in: it is stopped here, so it does not
# outlive the job holding the port. Nothing can be done on SIGKILL.
stop_on_signal() {
  if [ -f "$IRONBEE_STATE/app.pid" ]; then
    stop_app_process "$(cat "$IRONBEE_STATE/app.pid")"
  fi
  exit "$1"
}
trap_signals() {
  trap 'stop_on_signal 129' HUP
  trap 'stop_on_signal 130' INT
  trap 'stop_on_signal 143' TERM
}

# The IronBee setup `ironbee install` wrote, staged whole, for a caller who
# keeps it in the commits. A path that neither exists nor is tracked is skipped,
# and so is one the repository ignores, as a whole-tree add skips it.
stage_setup_paths() {
  local setup_path
  for setup_path in .mcp.json .gitignore .claude; do
    if [ -e "$setup_path" ] || [ -n "$(git ls-files -- "$setup_path")" ]; then
      git add -A -- "$setup_path" 2>/dev/null || true
    fi
  done
}

# The restart before a re-verification. The running application is the
# pre-fix code; replacing it is what makes the second run mean anything at
# all — a re-verification against the old bytes reports a confident verdict
# about code that no longer exists, in either direction: a good fix reads as
# still broken, and a transient first failure reads as fixed.
restart_app() {
  local pid=''
  if [ -f .ironbee/app.pid ]; then
    pid="$(cat .ironbee/app.pid)"
  fi

  # The caller's own restart, run to completion so the application has been
  # replaced before the run starts. The process this action started is
  # stopped first while it is still up: left running, it keeps the port and
  # the old code.
  if [ -n "$APP_RESTART_COMMAND" ]; then
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 2
    fi
    echo "Restarting the application with APP_RESTART_COMMAND"
    bash -c "$APP_RESTART_COMMAND" >> .ironbee/artifacts/app.log 2>&1 || {
      annotate_error "APP_RESTART_COMMAND failed; the re-verification would run against the pre-fix application"
      return 1
    }
    return 0
  fi

  # Whether this action's own restart can work at all. The process it
  # started being gone already means the start command handed off —
  # to docker compose, a process manager, a service — so the kill below
  # hits nothing and re-running the command is a no-op against an
  # application that is still up. Said out loud, because the symptom
  # otherwise is a re-verification that quietly tested the wrong code.
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    annotate_warning "the process this action started is no longer running, so APP_START_COMMAND hands the application off to something else"
    annotate_warning "the restart before re-verification may not have replaced it, and the result may describe the pre-fix code"
    annotate_warning "set APP_RESTART_COMMAND to the command that rebuilds and restarts it (for compose: docker compose up -d --build)"
  fi
  # The whole process group, so nothing the start command spawned keeps the port.
  if [ -n "$pid" ]; then
    stop_app_process "$pid"
    sleep 2
  fi
  # The fix is in the sources, and what the start command serves is the
  # build's output, so the build runs again first.
  if [ -n "$APP_BUILD_COMMAND" ]; then
    group_start "Rebuilding the application"
    if ! bash -c "$APP_BUILD_COMMAND"; then
      group_end
      annotate_error "APP_BUILD_COMMAND failed on the fixed code, so there is no application to re-verify"
      return 1
    fi
    group_end
  fi
  start_app_process
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

# ── The pipe ─────────────────────────────────────────────────────────

set +e
STEP_FAILED=''

# Every path in the action is relative to the working directory, so the pipe
# moves there once rather than in each step.
if ! cd "${INPUT_WORKING_DIRECTORY:-.}"; then
  annotate_error "WORKING_DIRECTORY '${INPUT_WORKING_DIRECTORY}' does not exist"
  exit 1
fi
IRONBEE_STATE="$PWD/.ironbee"
trap_signals
# The step's `artifacts:` keeps .ironbee/upload/, so it exists from the start.
mkdir -p "$IRONBEE_STATE" "$IRONBEE_STATE/upload"

# The `github` context the action's steps read, from Bitbucket's own variables.
# A pull request pipeline's commit is the source's head (pipe.sh resolved its
# short form); the checkout is that head merged with the destination.
EVENT_NAME="$(bitbucket_event_name "${INPUT_EVENT_NAME:-}" "${BITBUCKET_PR_ID:-}")"
# Bitbucket starts no pipeline for a pull request from a fork.
IS_FORK=false
REPOSITORY_PRIVATE="$(bitbucket_repository_private "${BITBUCKET_REPO_IS_PRIVATE:-}")"
PR_NUMBER="${BITBUCKET_PR_ID:-}"
COMMIT_SHA="${BITBUCKET_COMMIT:-}"
# Bitbucket names no commit a push started from; the plan step measures a push
# from where it left its destination branch instead.
BEFORE_SHA=""
REF_NAME="${BITBUCKET_BRANCH:-${BITBUCKET_TAG:-}}"
# Fetches and pushes go here, never to the clone's `origin`: that is the
# Pipelines proxy on the build container's loopback, which a pipe cannot reach.
# git takes the credential from the helper pipe.sh set, which reads
# BITBUCKET_OAUTH_TOKEN from the step that runs git.
REPOSITORY_URL="https://bitbucket.org/${BITBUCKET_REPO_FULL_NAME:-}.git"

unexport_inputs
# And the credentials under their own names, should anything have left them in
# the environment; each step that needs one exports it from its input.
export -n IRONBEE_API_KEY ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN BITBUCKET_OAUTH_TOKEN 2>/dev/null || true
write_outputs_env

# The Playwright cache sits in the clone, the only place a pipe keeps anything
# between runs (a custom cache of the step), so git is told to ignore it: the
# fix detection and the commits below read `git status`. Compared as physical
# paths, because git resolves symlinks and BITBUCKET_CLONE_DIR may not.
GIT_TOP="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$GIT_TOP" ] && [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] \
  && mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null; then
  GIT_TOP_PHYSICAL="$(cd "$GIT_TOP" && pwd -P)"
  BROWSERS_PHYSICAL="$(cd "$PLAYWRIGHT_BROWSERS_PATH" && pwd -P)"
  if [ -n "$GIT_TOP_PHYSICAL" ] && [ -n "$BROWSERS_PHYSICAL" ] \
    && [ "${BROWSERS_PHYSICAL#"$GIT_TOP_PHYSICAL"/}" != "$BROWSERS_PHYSICAL" ]; then
    GIT_EXCLUDE="$(git rev-parse --git-path info/exclude)"
    mkdir -p "$(dirname "$GIT_EXCLUDE")"
    printf '/%s/\n' "${BROWSERS_PHYSICAL#"$GIT_TOP_PHYSICAL"/}" >> "$GIT_EXCLUDE"
  fi
fi

# ── Setup ──────────────────────────────────────────────────────────

# Fetch git history for diff
step_fetch_history() {
  export BITBUCKET_OAUTH_TOKEN="$INPUT_BITBUCKET_OAUTH_TOKEN"

  # From the repository's URL with the refspec `origin` has, so the branches
  # land where a fetch from `origin` puts them (`origin/<branch>`).
  local refspec='+refs/heads/*:refs/remotes/origin/*'
  if [ -n "${BITBUCKET_PR_DESTINATION_BRANCH:-}" ]; then
    refspec="+refs/heads/${BITBUCKET_PR_DESTINATION_BRANCH}:refs/remotes/origin/${BITBUCKET_PR_DESTINATION_BRANCH}"
  fi

  # Unshallow so git diff / git log always work (even single-commit repos)
  git fetch --unshallow "$REPOSITORY_URL" '+refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true
  # A depth makes a complete history shallow again, and a merge base further
  # back than it is then not found: the depth only where the unshallow did
  # not take.
  if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = true ]; then
    git fetch "$REPOSITORY_URL" "$refspec" --depth=50 2>/dev/null || true
  else
    git fetch "$REPOSITORY_URL" "$refspec" 2>/dev/null || true
  fi

  # The repository's main branch, the destination a push measures from when
  # no pull request names one. Bitbucket hands a step no variable for it.
  if [ "$EVENT_NAME" = push ] && [ -z "${BITBUCKET_PR_DESTINATION_BRANCH:-}" ]; then
    MAIN_BRANCH="$(git ls-remote --symref "$REPOSITORY_URL" HEAD 2>/dev/null \
      | awk '/^ref:/ { sub("^refs/heads/", "", $2); print $2; exit }')" || MAIN_BRANCH=""
    echo "main_branch=${MAIN_BRANCH}" >> "$IRONBEE_OUTPUT"
  fi
}
if success; then
  run_step fetch-history "Fetch git history for diff" step_fetch_history
fi

# Setup Node.js — none: the pipe's image carries Node.

# ── The comment command ────────────────────────────────────────────
#
# Not here. Bitbucket Pipelines has no trigger for a pull request comment, so
# the run somebody asks for by name is a `custom:` pipeline.

# ── Decide what runs, and where ────────────────────────────────────
#
# Every decision the action makes lives in one script so it can be tested:
# the mode, the target, the repository binding, the flags. This step reads
# the answers and nothing else. It runs before any install, so a pipeline
# that cannot run costs one Node startup rather than a Chromium download.

# Resolve the verification plan
step_plan() {
  export INPUT_VERIFICATION_MODE INPUT_IRONBEE_API_KEY INPUT_ANTHROPIC_API_KEY INPUT_CLAUDE_CODE_OAUTH_TOKEN
  export INPUT_APP_URL INPUT_APP_START_COMMAND INPUT_APP_PORT INPUT_APP_RESTART_COMMAND
  export INPUT_APP_LOGS_COMMAND INPUT_APP_WAIT_SECONDS INPUT_APP_HEADERS INPUT_APP_SECRET_HEADERS
  export INPUT_IRONBEE_PROJECT
  # A deployment step's environment is one Bitbucket hands the step, as
  # BITBUCKET_DEPLOYMENT_ENVIRONMENT — unlike GitHub, where it reaches the job
  # through no variable and only a deployment event carries one.
  INPUT_IRONBEE_ENVIRONMENT="${INPUT_IRONBEE_ENVIRONMENT:-${BITBUCKET_DEPLOYMENT_ENVIRONMENT:-}}"
  export INPUT_IRONBEE_ENVIRONMENT
  export INPUT_IRONBEE_CONSOLE_URL INPUT_IRONBEE_COLLECTOR_URL INPUT_IRONBEE_BIND_REPOSITORY
  export INPUT_IRONBEE_JOB_TIMEOUT_MINUTES INPUT_VERIFICATION_AUTO INPUT_VERIFICATION_APPLY_FIX
  export INPUT_CLAUDE_CODE_MODEL INPUT_CLAUDE_CODE_MAX_TURNS INPUT_CLAUDE_CODE_ARGS
  export INPUT_IRONBEE_BROWSER_DEVTOOLS INPUT_IRONBEE_BACKEND_DEVTOOLS INPUT_IRONBEE_NODE_DEVTOOLS
  export INPUT_IRONBEE_PYTHON_DEVTOOLS INPUT_IRONBEE_TERMINAL_DEVTOOLS
  export INPUT_IRONBEE_EXCLUDE_FILES INPUT_IRONBEE_EXTRA_CONFIG INPUT_VERBOSE
  export REPOSITORY_PRIVATE IS_FORK EVENT_NAME PR_NUMBER COMMIT_SHA BEFORE_SHA

  # Bitbucket names no commit a push started from, so a push measures from
  # where it left its destination branch: the pull request's when one is
  # named, else the repository's main branch. On that branch itself the base
  # is the commit, a changeset of nothing, and the parent stands in below.
  if [ "$EVENT_NAME" = push ]; then
    DESTINATION="${BITBUCKET_PR_DESTINATION_BRANCH:-$FETCH_HISTORY_main_branch}"
    BEFORE_SHA="$(bitbucket_push_base "$COMMIT_SHA" "$DESTINATION")"
    # Off the destination, the parent is the last commit alone and the rest of
    # the branch goes unread, so that is said.
    if [ -n "${BITBUCKET_BRANCH:-}" ] && [ "$BITBUCKET_BRANCH" != "$DESTINATION" ] \
      && { [ -z "$BEFORE_SHA" ] || [ "$BEFORE_SHA" = "$COMMIT_SHA" ]; }; then
      if [ -z "$DESTINATION" ]; then
        annotate_warning "the repository's main branch could not be read, so this push of ${BITBUCKET_BRANCH} is measured from its commit's parent alone"
      else
        annotate_warning "${BITBUCKET_BRANCH} has no merge base with ${DESTINATION} below its own commit in this clone, so this push is measured from its commit's parent alone"
      fi
    fi
  fi

  # The base of a push is a SHA this checkout may not have: the first push
  # of a branch reports all zeros, and a force-push can name a commit that
  # is gone. Both are forty hex characters and would pass every shape
  # check on the way to failing at the platform's own checkout, so the
  # question is answered here, where git can answer it.
  BASE_USABLE=false
  BASE_EMPTY=false
  if [ -n "$BEFORE_SHA" ] && git cat-file -e "${BEFORE_SHA}^{commit}" 2>/dev/null; then
    BASE_USABLE=true
    # A base whose tree matches the commit's is a rewrite, not a
    # changeset: the push replaced history without changing content, so
    # measuring from it produces an empty diff and a run with nothing to
    # review. Asked here because only git can answer it.
    if git diff --quiet "$BEFORE_SHA" "$COMMIT_SHA" 2>/dev/null; then
      BASE_EMPTY=true
    fi
  fi
  export BASE_USABLE BASE_EMPTY

  # The commit's own first parent, as the fallback base. Read out of the
  # commit object rather than with `rev-parse "$COMMIT_SHA^"`, because the
  # default checkout is shallow: the graft makes git report the commit as
  # parentless, while the object it just fetched still names the parent on
  # its own `parent` line. The base only has to exist on the remote — the
  # run fetches both SHAs itself — and a parent always does when its child
  # does.
  PARENT_SHA=""
  if [ -n "$COMMIT_SHA" ] && git cat-file -e "${COMMIT_SHA}^{commit}" 2>/dev/null; then
    PARENT_SHA="$(git cat-file commit "$COMMIT_SHA" | awk '/^parent /{print $2; exit}')"
  fi
  export PARENT_SHA

  node "$IRONBEE_BITBUCKET_HOME/scripts/resolve-plan.js"
}
if success; then
  run_step plan "Resolve the verification plan" step_plan
fi

# ── Preflight: refuse what cannot work, before installing anything ─

# Check the deployment is reachable
step_check_deployment() {
  export APP_URL="$INPUT_APP_URL"
  export INPUT_APP_HEADERS INPUT_APP_SECRET_HEADERS

  # The headers the platform run sends go with the check, so a protection
  # they bypass is not refused here. Read by curl through a descriptor, never
  # a command line or a file: the secret ones are the caller's. A local run's
  # agent sends none, and neither does its check.
  HEADER_LINES=(true)
  if [ "$PLAN_mode" = platform ]; then
    HEADER_LINES=(node "$IRONBEE_BITBUCKET_HOME/scripts/resolve-plan.js" --header-lines)
  fi

  # curl prints 000 itself when the connection fails, so nothing is appended to
  # it; an empty answer is a curl that could not run at all.
  # Redirects are never followed, with headers or without: curl repeats
  # custom headers to every host it is redirected to, and these carry
  # secrets. The target is named instead, below.
  ANSWER=$(curl -o /dev/null -s -w '%{http_code} %{redirect_url}' --max-time 15 -H @<("${HEADER_LINES[@]}") "$APP_URL" || true)
  STATUS="${ANSWER%% *}"
  REDIRECT=""
  if [ "$STATUS" != "$ANSWER" ]; then
    REDIRECT="${ANSWER#* }"
  fi
  if [ -z "$STATUS" ]; then
    STATUS="000"
  fi

  if [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ]; then
    annotate_error "$APP_URL answers $STATUS — it is behind deployment protection."
    annotate_error "The verification would report on the login page rather than on the application."
    annotate_error "Verify the application on this runner instead: set APP_START_COMMAND and APP_PORT, and leave APP_URL empty."
    exit 1
  fi

  # A connection failure is not a refusal. This runner and the IronBee
  # platform dial from different networks, so "unreachable from here" says
  # nothing about whether the run can reach it.
  if [ "$STATUS" = "000" ]; then
    annotate_warning "$APP_URL did not answer from this runner. The verification runs from elsewhere and may still reach it."
  elif [ "${STATUS#3}" != "$STATUS" ]; then
    # A sign-in redirect to an identity provider, or http to https: the
    # verification follows it, and reports on wherever it lands.
    annotate_warning "$APP_URL answers $STATUS, redirecting to ${REDIRECT:-a target it does not name}. Not followed here; if that is a sign-in page, the verification will report on it rather than on the application."
  else
    echo "$APP_URL answers $STATUS"
  fi
}
if success && [ "$PLAN_target_kind" = url ]; then
  run_step check-deployment "Check the deployment is reachable" step_check_deployment
fi

# Restore Playwright browser cache — the step's custom cache restores it
# before the step's script and saves it after; PLAYWRIGHT_BROWSERS_PATH, set by
# pipe.sh, points the browser install at it.

# ── Install IronBee CLI ────────────────────────────────────────────

# Install IronBee CLI
step_install_cli() {
  # Resolve "latest" via `npm view` so the install pins to an explicit
  # version — avoids any dist-tag / CDN cache surprises that can make
  # `npm install -g @ironbee-ai/cli` silently pull an older release.
  if [ -z "$INPUT_IRONBEE_CLI_VERSION" ] || [ "$INPUT_IRONBEE_CLI_VERSION" = "latest" ]; then
    VERSION="$(npm view @ironbee-ai/cli version)"
  else
    VERSION="$INPUT_IRONBEE_CLI_VERSION"
  fi
  echo "Installing @ironbee-ai/cli@${VERSION}"
  npm install -g "@ironbee-ai/cli@${VERSION}"
  INSTALLED="$(ironbee --version)"
  echo "Installed @ironbee-ai/cli version: ${INSTALLED}"
  echo "ironbee-version=${INSTALLED}" >> "$IRONBEE_OUTPUT"
  echo "ironbee-path=$(which ironbee)" >> "$IRONBEE_OUTPUT"
}
if success && [ -n "$PLAN_mode" ]; then
  run_step install-cli "Install IronBee CLI" step_install_cli
fi

# Configure IronBee
step_configure_ironbee() {
  export IRONBEE_COLLECTOR_URL="$INPUT_IRONBEE_COLLECTOR_URL"
  export BROWSER_DEVTOOLS_ENABLE="$INPUT_IRONBEE_BROWSER_DEVTOOLS"
  export BACKEND_DEVTOOLS_ENABLE="$INPUT_IRONBEE_BACKEND_DEVTOOLS"
  export NODE_DEVTOOLS_ENABLE="$INPUT_IRONBEE_NODE_DEVTOOLS"
  export PYTHON_DEVTOOLS_ENABLE="$INPUT_IRONBEE_PYTHON_DEVTOOLS"
  export TERMINAL_DEVTOOLS_ENABLE="$INPUT_IRONBEE_TERMINAL_DEVTOOLS"
  export EXTRA_CONFIG="$INPUT_IRONBEE_EXTRA_CONFIG"

  mkdir -p .ironbee/artifacts
  ARTIFACTS_DIR="$(pwd)/.ironbee/artifacts" node -e '
    const fs = require("fs");
    const annotations = require(process.env.IRONBEE_BITBUCKET_HOME + "/scripts/annotations.js");
    const dir = process.env.ARTIFACTS_DIR;
    const toBool = (v) => /^(true|1|yes|on)$/i.test(String(v || "").trim());
    const config = {
      // The key is omitted rather than written empty when nobody named a
      // collector: an explicit `collector.url` is what the CLI infers its
      // service domain from, so writing one here would pin every other
      // service URL to whatever stage this action guessed.
      ...(process.env.IRONBEE_COLLECTOR_URL
        ? { collector: { url: process.env.IRONBEE_COLLECTOR_URL } }
        : {}),
      // Cycle gating — drives whether the per-platform MCP server is
      // registered in .mcp.json by `ironbee install`.
      browser: { enable: toBool(process.env.BROWSER_DEVTOOLS_ENABLE) },
      backend: { enable: toBool(process.env.BACKEND_DEVTOOLS_ENABLE) },
      node:    { enable: toBool(process.env.NODE_DEVTOOLS_ENABLE) },
      python:  { enable: toBool(process.env.PYTHON_DEVTOOLS_ENABLE) },
      terminal:{ enable: toBool(process.env.TERMINAL_DEVTOOLS_ENABLE) },
      // MCP env, merged into the server entry the CLI writes into
      // .mcp.json for each cycle enabled above.
      //
      // Written twice because the override key follows the *physical*
      // server name, and the CLI has two layouts: one composed server
      // serving every enabled cycle (key `ironbeeDevTools`), or one
      // server per cycle (key `<cycle>DevTools`). A composed CLI reads
      // only the first block and a per-cycle CLI only the second, so
      // both are written and the pinned version decides which applies.
      // Writing one alone is how BROWSER_CHROMIUM_SANDBOX silently stops
      // being applied on a CLI upgrade.
      ironbeeDevTools: {
        env: {
          LOG_FILE: dir + "/ironbee-devtools-mcp.log",
          BROWSER_CHROMIUM_SANDBOX: "false",
        },
      },
      browserDevTools: {
        env: {
          LOG_FILE: dir + "/ironbee-browser-devtools-mcp.log",
          // A pipe container has no user namespaces for Chromium to
          // sandbox with; launch Chromium with --no-sandbox or it dies on
          // first navigate with "Target page, context or browser has been closed".
          BROWSER_CHROMIUM_SANDBOX: "false",
        },
      },
      backendDevTools: {
        env: { LOG_FILE: dir + "/ironbee-backend-devtools-mcp.log" },
      },
      nodeDevTools: {
        env: { LOG_FILE: dir + "/ironbee-node-devtools-mcp.log" },
      },
      pythonDevTools: {
        env: { LOG_FILE: dir + "/ironbee-python-devtools-mcp.log" },
      },
      terminalDevTools: {
        env: { LOG_FILE: dir + "/ironbee-terminal-devtools-mcp.log" },
      },
    };
    const extra = (process.env.EXTRA_CONFIG || "").trim();
    if (extra) {
      let parsed;
      try { parsed = JSON.parse(extra); }
      catch (e) {
        annotations.error("IRONBEE_EXTRA_CONFIG is not valid JSON: " + e.message);
        process.exit(1);
      }
      const merge = (target, source) => {
        for (const key of Object.keys(source)) {
          const sv = source[key];
          if (sv && typeof sv === "object" && !Array.isArray(sv)) {
            if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
              target[key] = {};
            }
            merge(target[key], sv);
          } else {
            target[key] = sv;
          }
        }
        return target;
      };
      merge(config, parsed);
    }
    fs.writeFileSync(".ironbee/config.json", JSON.stringify(config, null, 2));
  '
}
if success && [ "$PLAN_mode" = local ]; then
  run_step configure-ironbee "Configure IronBee" step_configure_ironbee
fi

# Setup IronBee for Claude
step_setup_ironbee() {
  export IRONBEE_API_KEY="$INPUT_IRONBEE_API_KEY"
  # The sessions in .ironbee/ under the working directory, where the verdict,
  # the evidence and the fix detection read them; the CLI's default keeps them
  # outside the project.
  export IRONBEE_RUNTIME_LOCATION=in-project

  if [ "$PLAN_exclude_files" = "true" ]; then
    # Both asked of git: the exclude file is not .git/info/exclude from a
    # working directory below the repository's root, and its patterns are
    # read from the root, so each one names the working directory.
    GIT_EXCLUDE="$(git rev-parse --git-path info/exclude)"
    PREFIX="$(git rev-parse --show-prefix)"
    mkdir -p "$(dirname "$GIT_EXCLUDE")"
    echo "${PREFIX}.mcp.json" >> "$GIT_EXCLUDE"
    echo "${PREFIX}.ironbee/" >> "$GIT_EXCLUDE"
    echo "${PREFIX}.claude/settings.json" >> "$GIT_EXCLUDE"
    echo "${PREFIX}.claude/skills/ironbee-*.md" >> "$GIT_EXCLUDE"
    echo "${PREFIX}.claude/rules/ironbee-*.md" >> "$GIT_EXCLUDE"
    echo "${PREFIX}.claude/commands/ironbee-*.md" >> "$GIT_EXCLUDE"
  fi

  ironbee install --client claude
}
if success && [ "$PLAN_mode" = local ]; then
  run_step setup-ironbee "Setup IronBee for Claude" step_setup_ironbee
fi

# ── Browser Setup ────────────────────────────────────────────────

# Install IronBee DevTools
step_install_devtools() {
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='true'

  # Resolve "latest" via `npm view` so the install pins to an explicit
  # version — same rationale as for @ironbee-ai/cli above.
  VERSION="$(npm view @ironbee-ai/devtools version)"
  echo "Installing @ironbee-ai/devtools@${VERSION}"
  npm install -g "@ironbee-ai/devtools@${VERSION}"
  echo "Installed @ironbee-ai/devtools version: ${VERSION}"
}
if success && [ "$PLAN_mode" = local ]; then
  run_step install-devtools "Install IronBee DevTools" step_install_devtools
fi

# Install Chromium and system dependencies
step_install_chromium() {
  npx -y playwright install --with-deps chromium ffmpeg
}
if success && [ "$PLAN_mode" = local ]; then
  run_step install-chromium "Install Chromium and system dependencies" step_install_chromium
fi

# ── Build Verification Prompt ──────────────────────────────────────

# Build verification prompt
step_build_prompt() {
  export USER_PROMPT="$INPUT_VERIFICATION_PROMPT"

  ARTIFACTS_DIR="$(pwd)/.ironbee/artifacts"

  # Determine trigger context and diff target
  DIFF_TARGET=""
  if [ "$EVENT_NAME" = "merge_request" ]; then
    # Bitbucket has no variable for the title: the pull request is read for it,
    # and the prompt goes without one when that read fails.
    if ! TITLE="$(BITBUCKET_OAUTH_TOKEN="$INPUT_BITBUCKET_OAUTH_TOKEN" \
      node "$IRONBEE_BITBUCKET_HOME/scripts/bitbucket-api.js" pr-title --id "$PR_NUMBER")"; then
      TITLE=""
      annotate_warning "the pull request's title could not be read, so the prompt goes without it"
    fi
    CONTEXT="Pull Request #${PR_NUMBER}${TITLE:+: ${TITLE}}"
    DIFF_TARGET="origin/${BITBUCKET_PR_DESTINATION_BRANCH}"
  elif [ "$EVENT_NAME" = "push" ]; then
    CONTEXT="Push to ${REF_NAME} (commit ${COMMIT_SHA})"
    # The push's own base, the one the platform binding measures from: the
    # last commit alone would leave the rest of a multi-commit push unread.
    # Bitbucket names no base for a push, so on this host it is the parent.
    if [ -n "$PLAN_diff_base" ] && git cat-file -e "${PLAN_diff_base}^{commit}" 2>/dev/null; then
      DIFF_TARGET="$PLAN_diff_base"
    elif git rev-parse HEAD~1 >/dev/null 2>&1; then
      DIFF_TARGET="HEAD~1"
    else
      DIFF_TARGET="$(git hash-object -t tree /dev/null)"
    fi
  elif [ "$EVENT_NAME" = "manual" ]; then
    CONTEXT="Manual run on ${REF_NAME}"
  elif [ "$EVENT_NAME" = "schedule" ]; then
    CONTEXT="Scheduled run on ${REF_NAME}"
  else
    CONTEXT="${EVENT_NAME} on ${REF_NAME}"
  fi

  # With VERIFICATION_APPLY_FIX off the agent verifies and reports, and
  # changes nothing: no fix lands from this run.
  if [ "$PLAN_can_fix" = "true" ]; then
    ON_FAILURE="If verification fails, fix the issues and re-verify"
  else
    ON_FAILURE="If verification fails, do not change any files: fixing is off for this run, and the verdict reports the issues"
  fi

  # Build the prompt
  PROMPT=/tmp/ironbee-prompt.md
  if [ -n "$DIFF_TARGET" ] && [ "$PLAN_can_fix" = "true" ]; then
    echo "You are running in CI. Verify the code changes and fix any issues found." > "$PROMPT"
  elif [ -n "$DIFF_TARGET" ]; then
    echo "You are running in CI. Verify the code changes and report any issues found." > "$PROMPT"
  else
    echo "You are running in CI. Verify that the application is working correctly." > "$PROMPT"
  fi
  echo "" >> "$PROMPT"
  echo "## Context" >> "$PROMPT"
  echo "${CONTEXT}" >> "$PROMPT"
  if [ -n "$DIFF_TARGET" ]; then
    echo "Diff target: ${DIFF_TARGET}" >> "$PROMPT"
  fi

  # App configuration
  if [ -n "$INPUT_APP_INSTALL_COMMAND" ] || [ -n "$INPUT_APP_BUILD_COMMAND" ] || [ -n "$INPUT_APP_START_COMMAND" ] || [ -n "$INPUT_APP_URL" ]; then
    echo "" >> "$PROMPT"
    echo "## Application" >> "$PROMPT"
    if [ -n "$INPUT_APP_INSTALL_COMMAND" ]; then
      echo "- Install command: \`${INPUT_APP_INSTALL_COMMAND}\`" >> "$PROMPT"
    fi
    if [ -n "$INPUT_APP_BUILD_COMMAND" ]; then
      echo "- Build command: \`${INPUT_APP_BUILD_COMMAND}\`" >> "$PROMPT"
    fi
    if [ -n "$INPUT_APP_START_COMMAND" ]; then
      echo "- Start command: \`${INPUT_APP_START_COMMAND}\`" >> "$PROMPT"
    fi
    if [ -n "$INPUT_APP_URL" ]; then
      echo "- Application URL: ${INPUT_APP_URL}" >> "$PROMPT"
    fi
    # The port the plan resolved: APP_PORT, or the one APP_URL names.
    if [ -n "$PLAN_target_port" ]; then
      echo "- Application port: ${PLAN_target_port}" >> "$PROMPT"
    fi
  fi

  # Evidence instructions
  echo "" >> "$PROMPT"
  echo "## Evidence" >> "$PROMPT"
  echo "Organize artifacts by verification cycle under: ${ARTIFACTS_DIR}/" >> "$PROMPT"
  echo "IMPORTANT: Each verification cycle gets ONE directory. Increment the cycle number for each new cycle." >> "$PROMPT"
  echo "  - Cycle 1 (fail + fix) = cycle-1/" >> "$PROMPT"
  echo "  - Cycle 2 (re-verify) = cycle-2/" >> "$PROMPT"
  echo "  Do NOT create multiple directories for the same cycle (e.g. cycle-1-fail AND cycle-1-pass)." >> "$PROMPT"
  echo "Directory structure:" >> "$PROMPT"
  echo "  ${ARTIFACTS_DIR}/cycle-<N>/screenshots/" >> "$PROMPT"
  echo "  ${ARTIFACTS_DIR}/cycle-<N>/recordings/" >> "$PROMPT"
  echo "Examples:" >> "$PROMPT"
  echo "  cycle-1/screenshots/homepage-before-fix.png" >> "$PROMPT"
  echo "  cycle-1/recordings/verification.webm" >> "$PROMPT"
  echo "  cycle-2/screenshots/homepage-after-fix.png" >> "$PROMPT"
  echo "  cycle-2/recordings/verification.webm" >> "$PROMPT"
  echo "Use descriptive file names that reflect what is being verified." >> "$PROMPT"

  # Append user's custom prompt
  if [ -n "$USER_PROMPT" ]; then
    echo "" >> "$PROMPT"
    echo "## Additional Instructions" >> "$PROMPT"
    printf "%s\n" "$USER_PROMPT" >> "$PROMPT"
  fi

  # Core instruction: run the IronBee verify command
  echo "" >> "$PROMPT"
  echo "## Task" >> "$PROMPT"
  if [ -n "$DIFF_TARGET" ]; then
    echo "1. Review the code changes: \`git diff ${DIFF_TARGET} --name-only\` and \`git diff ${DIFF_TARGET}\`" >> "$PROMPT"
    echo "   IMPORTANT: Do NOT use \`git diff HEAD~1\`. Always use \`${DIFF_TARGET}\` as the diff target." >> "$PROMPT"
    echo "2. Run /ironbee-verify to perform verification" >> "$PROMPT"
    echo "3. ${ON_FAILURE}" >> "$PROMPT"
    echo "Do not commit, push, or open a pull request — that is handled for you." >> "$PROMPT"
  else
    echo "1. Run /ironbee-verify full to verify the application is working correctly" >> "$PROMPT"
    echo "2. ${ON_FAILURE}" >> "$PROMPT"
    echo "Do not commit, push, or open a pull request — that is handled for you." >> "$PROMPT"
  fi

  # Output the prompt (multiline)
  {
    echo "prompt<<PROMPT_DELIM"
    cat "$PROMPT"
    echo "PROMPT_DELIM"
  } >> "$IRONBEE_OUTPUT"

  if [ "$PLAN_verbose" = "true" ]; then
    group_start "Verification prompt"
    cat "$PROMPT"
    group_end
  fi
}
if success && [ "$PLAN_mode" = local ]; then
  run_step build-prompt "Build verification prompt" step_build_prompt
fi

# ── Configure git identity ────────────────────────────────────────

# Configure git identity
step_git_identity() {
  git config user.name "IronBee"
  git config user.email "commits-noreply@bitbucket.org"
}
if success && [ -n "$PLAN_mode" ]; then
  run_step git-identity "Configure git identity" step_git_identity
fi

# ── Install Claude Code CLI ─────────────────────────────────────

# Install Claude Code CLI
step_install_claude() {
  # Resolve "latest" via `npm view` so the install pins to an explicit
  # version — same rationale as for @ironbee-ai/cli above.
  if [ -z "$INPUT_CLAUDE_CODE_CLI_VERSION" ] || [ "$INPUT_CLAUDE_CODE_CLI_VERSION" = "latest" ]; then
    VERSION="$(npm view @anthropic-ai/claude-code version)"
  else
    VERSION="$INPUT_CLAUDE_CODE_CLI_VERSION"
  fi
  echo "Installing @anthropic-ai/claude-code@${VERSION}"
  npm install -g "@anthropic-ai/claude-code@${VERSION}"
  echo "Installed @anthropic-ai/claude-code version: $(claude --version)"
}
if success && [ "$PLAN_mode" = local ]; then
  run_step install-claude "Install Claude Code CLI" step_install_claude
fi

# ── Platform verification ──────────────────────────────────────────
#
# The application is started here only for a tunnel target: a deployed URL
# was started by whoever deployed it. It runs in the background for the
# length of the pipe, and is stopped by the teardown at the very end —
# after the fix round and any re-verification, both of which still need it.

# Start the application
step_start_app() {
  export APP_INSTALL_COMMAND="$INPUT_APP_INSTALL_COMMAND"
  export APP_BUILD_COMMAND="$INPUT_APP_BUILD_COMMAND"
  export APP_START_COMMAND="$INPUT_APP_START_COMMAND"
  # The application's own commands run with the collector of this run's
  # stage and its key in their environment, so a service whose OTel
  # collector reads these ships its traces and logs to the verification
  # session. Nothing is written to disk for it.
  export IRONBEE_COLLECTOR_URL="$PLAN_collector_url"
  export IRONBEE_API_KEY="$INPUT_IRONBEE_API_KEY"
  export TARGET_HOST="$PLAN_target_host"
  export TARGET_PORT="$PLAN_target_port"
  export APP_WAIT_SECONDS="$INPUT_APP_WAIT_SECONDS"

  mkdir -p .ironbee/artifacts

  if [ -n "$APP_INSTALL_COMMAND" ]; then
    group_start "Installing application dependencies"
    bash -c "$APP_INSTALL_COMMAND"
    group_end
  fi
  if [ -n "$APP_BUILD_COMMAND" ]; then
    group_start "Building the application"
    bash -c "$APP_BUILD_COMMAND"
    group_end
  fi
  if [ -z "$APP_START_COMMAND" ]; then
    annotate_error "a tunnel target needs APP_START_COMMAND to start the application"
    exit 1
  fi

  # Both streams to one file, because "the app never started" and "the app
  # answered 500" are the two failures a reader has to tell apart and the
  # verdict shows neither. In a process group of its own, so the restart and
  # the stop end it whole.
  : > .ironbee/artifacts/app.log
  start_app_process
  echo "Started the application (pid $(cat .ironbee/app.pid)); waiting for it happens in the CLI"

  # An application published on another host — the step's Docker service,
  # which a pipe reaches at host.docker.internal — is where the tunnel, which
  # dials 127.0.0.1, does not look. It is bridged to the loopback once it
  # answers.
  case "$TARGET_HOST" in
    localhost | 127.0.0.1 | ::1 | '')
      ;;
    *)
      nohup node "$IRONBEE_BITBUCKET_HOME/scripts/forward-port.js" \
        --listen "$TARGET_PORT" --to "${TARGET_HOST}:${TARGET_PORT}" --wait "${APP_WAIT_SECONDS:-60}" \
        > .ironbee/forward-port.log 2>&1 &
      echo $! > .ironbee/forward-port.pid
      echo "Forwarding 127.0.0.1:${TARGET_PORT} to ${TARGET_HOST}:${TARGET_PORT} once it answers (pid $(cat .ironbee/forward-port.pid))"
      ;;
  esac
}
if success && [ "$PLAN_needs_app" = true ]; then
  run_step start-app "Start the application" step_start_app
fi

# Run platform verification
step_platform_verify() {
  export IRONBEE_API_KEY="$INPUT_IRONBEE_API_KEY"
  export API_URL_OVERRIDE="$INPUT_IRONBEE_API_URL"
  export USER_PROMPT="$INPUT_VERIFICATION_PROMPT"
  export CLI_ARGS="$PLAN_cli_args"
  export INPUT_APP_SECRET_HEADERS

  mkdir -p .ironbee/artifacts

  # Exported only when set. The CLI reads this variable before it reads
  # its own configuration, so an empty value would win over the endpoint
  # the user configured and point the run at nothing.
  if [ -n "$API_URL_OVERRIDE" ]; then
    export IRONBEE_API_URL="$API_URL_OVERRIDE"
  fi

  # One argument per line: an argument can contain a space — a project
  # name, a URL with one — and re-splitting a joined string is how such a
  # value silently becomes two arguments. Written as an `if` rather than
  # `[ -n "$line" ] && ARGS+=(…)`, whose status on the loop's last
  # (empty) line is 1 and would end the step under `set -e`.
  ARGS=()
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      ARGS+=("$line")
    fi
  done <<< "$CLI_ARGS"

  # Emitted straight into this step rather than carried on a step output:
  # a step output is a file on the runner that outlives the step, and this
  # one carries the caller's secret.
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      ARGS+=("$line")
    fi
  done < <(node "$IRONBEE_BITBUCKET_HOME/scripts/resolve-plan.js" --secret-header-args)

  # Through a file, never a shell word: the prompt is caller text and a
  # command line is the one place it could become a command.
  if [ -n "$USER_PROMPT" ]; then
    printf '%s\n' "$USER_PROMPT" > .ironbee/prompt.txt
    ARGS+=("--prompt-file" ".ironbee/prompt.txt")
  fi

  set +e
  ironbee verify run web "${ARGS[@]}" > .ironbee/raw-output.txt
  EXIT_CODE=$?
  set -e

  # The CLI may ask the runner to mask the tunnel credentials by writing
  # `::add-mask::` on stdout — the same stream `--json` writes the job to.
  # They are kept out of the JSON so it parses. Bitbucket has no such
  # command, so they are not re-emitted either: printed, they would put the
  # secret in the step log in the clear.
  grep -v '^::add-mask::' .ironbee/raw-output.txt > .ironbee/artifacts/job.json || true

  # Never fails the step. The report, the outputs and the teardown all
  # have to run on whatever came back, and the recorded code is what the
  # gate step at the end exits with.
  echo "exit_code=$EXIT_CODE" >> "$IRONBEE_OUTPUT"
  echo "Verification command exited $EXIT_CODE"
}
if success && [ "$PLAN_mode" = platform ]; then
  run_step platform-verify "Run platform verification" step_platform_verify
fi

# Read the verification job
step_read_job() {
  node "$IRONBEE_BITBUCKET_HOME/scripts/read-job.js" \
    .ironbee/artifacts/job.json "$PLAN_console_url"
}
if [ "$PLAN_mode" = platform ]; then
  run_step job "Read the verification job" step_read_job
fi

# ── Run Claude Code with IronBee ───────────────────────────────────

# Run Claude Code verification
step_claude_verify() {
  export ANTHROPIC_API_KEY="$INPUT_ANTHROPIC_API_KEY"
  export CLAUDE_CODE_OAUTH_TOKEN="$INPUT_CLAUDE_CODE_OAUTH_TOKEN"
  export IRONBEE_API_KEY="$INPUT_IRONBEE_API_KEY"
  export PROMPT_CONTENT="$BUILD_PROMPT_prompt"
  # Its hooks write the session in .ironbee/, as above.
  export IRONBEE_RUNTIME_LOCATION=in-project
  # Claude Code refuses --dangerously-skip-permissions as root unless told it
  # is in a sandbox. The pipe's image runs as root, where GitHub's runner
  # does not, and the pipe's container is that sandbox.
  if [ "$(id -u)" = "0" ]; then
    export IS_SANDBOX=1
  fi

  # Write prompt to file and pipe to claude
  PROMPT_FILE=$(mktemp)
  printf "%s" "$PROMPT_CONTENT" > "$PROMPT_FILE"

  # Run Claude Code with the verification prompt (stream output for live CI logs)
  LOG_FILE="$(pwd)/.ironbee/artifacts/claude-output.log"

  # Split as shell words, as the action's expression splice is, so a quoted
  # argument stays one argument.
  eval "EXTRA_ARGS=( $INPUT_CLAUDE_CODE_ARGS )"

  # The tree before the agent runs. It verifies and fixes in this one
  # invocation, so what changed after this is its fix, and what the IronBee
  # setup or anything earlier left in the tree is not.
  node "$IRONBEE_BITBUCKET_HOME/scripts/fix-paths.js" snapshot .ironbee/pre-fix-tree || {
    annotate_warning "the tree before the fix could not be recorded; what changed is read from git status"
    : > .ironbee/pre-fix-tree
  }

  cat "$PROMPT_FILE" | claude --output-format stream-json --verbose \
    --max-turns $INPUT_CLAUDE_CODE_MAX_TURNS \
    --dangerously-skip-permissions \
    ${INPUT_CLAUDE_CODE_MODEL:+--model "$INPUT_CLAUDE_CODE_MODEL"} \
    "${EXTRA_ARGS[@]}" \
    2>&1 | tee "$LOG_FILE.raw" | jq -r --unbuffered --arg verbose "$PLAN_verbose" '
      if .type == "assistant" and .message.content then
        (.message.content[] |
          if .type == "text" then "🤖 " + .text
          elif .type == "tool_use" then (if $verbose == "true" then "🔧 " + .name + ": " + (.input | tostring | .[0:500]) else empty end)
          else empty end)
      elif .type == "user" and .message.content then
        (.message.content[] |
          if .type == "tool_result" then
            (if .is_error then "❌ Error: " + (.content | tostring | .[0:500])
             elif $verbose == "true" then "  ↳ " + (.content | tostring | .[0:500])
             else empty end)
          else empty end)
      elif .type == "result" then
        "✅ Done (cost: $" + (.total_cost_usd // 0 | tostring) + ", turns: " + (.num_turns // 0 | tostring) + ")"
      else empty end
    ' 2>/dev/null | tee "$LOG_FILE" || true

  rm -f "$PROMPT_FILE"

  node "$IRONBEE_BITBUCKET_HOME/scripts/fix-paths.js" changed .ironbee/pre-fix-tree .ironbee/fix-paths || {
    annotate_warning "what the fix changed could not be read; no path counts as fixed"
    : > .ironbee/fix-paths
  }
  # A fix needs a fix cycle too: a failing verdict before the last one. The
  # agent installs, builds and starts the application in this same run, and
  # what those wrote is no fix on a run that never failed.
  FIX_CYCLE="$(node "$IRONBEE_BITBUCKET_HOME/scripts/build-report.js" --fix-cycle .ironbee || echo false)"
  if [ -s .ironbee/fix-paths ] && [ "$FIX_CYCLE" = "true" ]; then
    echo "fixed=true" >> "$IRONBEE_OUTPUT"
  else
    echo "fixed=false" >> "$IRONBEE_OUTPUT"
  fi
}
if success && [ "$PLAN_mode" = local ]; then
  run_step claude-verify "Run Claude Code verification" step_claude_verify
fi

# ── Fix what the platform found ────────────────────────────────────
#
# A second, fix-only agent. It does not verify: a verdict already exists,
# produced by a run with a browser and the application in front of it, and
# asking this one to re-derive it from a text summary would get a worse
# answer at full price. Local mode has no equivalent step — its agent
# verifies and fixes inside one invocation.
# Installed here rather than with the local one, and gated on the verdict:
# a platform run that passes never pays for an agent it was not going to
# use, which is most of what platform mode is for.

# Install Claude Code CLI for the fix round
step_install_claude_fix() {
  if [ -z "$INPUT_CLAUDE_CODE_CLI_VERSION" ] || [ "$INPUT_CLAUDE_CODE_CLI_VERSION" = "latest" ]; then
    VERSION="$(npm view @anthropic-ai/claude-code version)"
  else
    VERSION="$INPUT_CLAUDE_CODE_CLI_VERSION"
  fi
  echo "Installing @anthropic-ai/claude-code@${VERSION}"
  npm install -g "@anthropic-ai/claude-code@${VERSION}"
  echo "Installed @anthropic-ai/claude-code version: $(claude --version)"
}
if success && [ "$PLAN_mode" = platform ] && [ "$PLAN_can_fix" = true ] && [ "$JOB_verdict" = fail ]; then
  run_step install-claude-fix "Install Claude Code CLI for the fix round" step_install_claude_fix
fi

# Fix the reported issues
step_platform_fix() {
  export ANTHROPIC_API_KEY="$INPUT_ANTHROPIC_API_KEY"
  export CLAUDE_CODE_OAUTH_TOKEN="$INPUT_CLAUDE_CODE_OAUTH_TOKEN"
  export IRONBEE_PROMPT_NONCE="${BITBUCKET_BUILD_NUMBER}-${BITBUCKET_STEP_RUN_NUMBER}"
  # Claude Code refuses --dangerously-skip-permissions as root unless told it
  # is in a sandbox, which the pipe's container is.
  if [ "$(id -u)" = "0" ]; then
    export IS_SANDBOX=1
  fi

  PROMPT_FILE=.ironbee/fix-prompt.txt
  set +e
  node "$IRONBEE_BITBUCKET_HOME/scripts/build-fix-prompt.js" \
    .ironbee/artifacts/job.json "$PROMPT_FILE" "$JOB_job_url"
  BUILD_CODE=$?
  set -e

  # Exit 2 means the verdict carried no issues to work from. Not an error:
  # a failing verdict without issues is a report a person has to read.
  if [ "$BUILD_CODE" = "2" ]; then
    annotate_warning "the verdict reported no issues to fix"
    exit 0
  fi
  if [ "$BUILD_CODE" != "0" ]; then
    annotate_error "could not build the fix prompt"
    exit 1
  fi

  # The tree before the fix: what the install and the build left in it is
  # not the fix.
  node "$IRONBEE_BITBUCKET_HOME/scripts/fix-paths.js" snapshot .ironbee/pre-fix-tree || {
    annotate_warning "the tree before the fix could not be recorded; what changed is read from git status"
    : > .ironbee/pre-fix-tree
  }

  group_start "Fixing the reported issues"
  cat "$PROMPT_FILE" | claude --output-format stream-json --verbose \
    --max-turns 60 \
    --dangerously-skip-permissions \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    2>&1 | tee .ironbee/claude-fix.log.raw | jq -r --unbuffered --arg verbose "$PLAN_verbose" '
      if .type == "assistant" and .message.content then
        (.message.content[] |
          if .type == "text" then "🤖 " + .text
          elif .type == "tool_use" then (if $verbose == "true" then "🔧 " + .name else empty end)
          else empty end)
      elif .type == "result" then
        "✅ Fix round done (cost: $" + (.total_cost_usd // 0 | tostring) + ")"
      else empty end
    ' 2>/dev/null || true
  group_end

  # Only what changed since the snapshot, and `.ironbee` never: this action
  # writes into it — the job body, the prompts, the logs. Counting those, or
  # a build's output, as "the agent changed something" would report a fix
  # on a run that produced none, and then re-verify against unchanged code.
  node "$IRONBEE_BITBUCKET_HOME/scripts/fix-paths.js" changed .ironbee/pre-fix-tree .ironbee/fix-paths || {
    annotate_warning "what the fix changed could not be read; no path counts as fixed"
    : > .ironbee/fix-paths
  }
  if [ -s .ironbee/fix-paths ]; then
    # The agent's own account of the fixes, for the re-verification's
    # prompt. The final result event carries its closing message, which is
    # the summary the fix prompt asks for — every other assistant turn is
    # thinking-aloud between tool calls, and concatenating them would
    # spend the prompt budget on narration.
    jq -r 'select(.type == "result") | .result // empty' \
      .ironbee/claude-fix.log.raw > .ironbee/fix-summary.txt 2>/dev/null || true
    # A run that ended without one still has its assistant turns, and a
    # partial account beats none.
    if [ ! -s .ironbee/fix-summary.txt ]; then
      jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text' \
        .ironbee/claude-fix.log.raw > .ironbee/fix-summary.txt 2>/dev/null || true
    fi

    echo "fixed=true" >> "$IRONBEE_OUTPUT"
  else
    echo "fixed=false" >> "$IRONBEE_OUTPUT"
    annotate_warning "the fix round changed no files"
  fi
}
if success && [ "$PLAN_mode" = platform ] && [ "$PLAN_can_fix" = true ] && [ "$JOB_verdict" = fail ]; then
  run_step platform-fix "Fix the reported issues" step_platform_fix
fi

# A second verification, and only where it can mean anything. A tunnel
# target serves the fixed code the moment the application restarts; a
# deployed URL still serves what was deployed, so re-running against it
# would verify the same bytes and report a result unrelated to the fix.

# Re-verify after the fix
step_platform_reverify() {
  export IRONBEE_API_KEY="$INPUT_IRONBEE_API_KEY"
  export API_URL_OVERRIDE="$INPUT_IRONBEE_API_URL"
  export CLI_ARGS="$PLAN_cli_args"
  export INPUT_APP_SECRET_HEADERS
  export APP_BUILD_COMMAND="$INPUT_APP_BUILD_COMMAND"
  export APP_START_COMMAND="$INPUT_APP_START_COMMAND"
  export APP_RESTART_COMMAND="$INPUT_APP_RESTART_COMMAND"
  # The restarted application reports to the same collector as the first
  # run (IRONBEE_API_KEY is already in this step's environment).
  export IRONBEE_COLLECTOR_URL="$PLAN_collector_url"
  export USER_PROMPT="$INPUT_VERIFICATION_PROMPT"

  if [ -n "$API_URL_OVERRIDE" ]; then
    export IRONBEE_API_URL="$API_URL_OVERRIDE"
  fi

  # The running application is the pre-fix code, and is replaced first.
  restart_app

  ARGS=()
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      ARGS+=("$line")
    fi
  done <<< "$CLI_ARGS"

  # Emitted straight into this step rather than carried on a step output:
  # a step output is a file on the runner that outlives the step, and this
  # one carries the caller's secret.
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      ARGS+=("$line")
    fi
  done < <(node "$IRONBEE_BITBUCKET_HOME/scripts/resolve-plan.js" --secret-header-args)

  # The caller's own prompt, which the first verification also carried,
  # plus what the fix round says it repaired. Without the second half the
  # run reads a repository that predates the fixes and reports them as
  # unfixed; without the first it answers a narrower question than the
  # verification it is repeating.
  node "$IRONBEE_BITBUCKET_HOME/scripts/build-reverify-prompt.js" \
    .ironbee/fix-summary.txt .ironbee/reverify-prompt.txt || true
  if [ -s .ironbee/reverify-prompt.txt ]; then
    ARGS+=("--prompt-file" ".ironbee/reverify-prompt.txt")
  fi

  set +e
  ironbee verify run web "${ARGS[@]}" > .ironbee/raw-output.txt
  EXIT_CODE=$?
  set -e

  grep -v '^::add-mask::' .ironbee/raw-output.txt > .ironbee/artifacts/job.json || true

  echo "exit_code=$EXIT_CODE" >> "$IRONBEE_OUTPUT"
  echo "Re-verification exited $EXIT_CODE"
}
if success && [ "$PLATFORM_FIX_fixed" = true ] && [ "$PLAN_needs_app" = true ]; then
  run_step platform-reverify "Re-verify after the fix" step_platform_reverify
fi

# Read the re-verification job
step_read_job_reverified() {
  node "$IRONBEE_BITBUCKET_HOME/scripts/read-job.js" \
    .ironbee/artifacts/job.json "$PLAN_console_url"
}
if success && [ "$PLATFORM_REVERIFY_conclusion" = success ]; then
  run_step job-reverified "Read the re-verification job" step_read_job_reverified
fi

# ── Discard IronBee-generated file changes ───────────────────────

# Discard IronBee config changes
step_discard_config() {
  # Revert tracked files modified by ironbee install
  git checkout -- .mcp.json .gitignore .claude/ .ironbee/config.json 2>/dev/null || true
}
if [ "$PLAN_mode" = local ] && [ "$PLAN_exclude_files" = true ]; then
  run_step discard-config "Discard IronBee config changes" step_discard_config
fi

# ── Collect Evidence ───────────────────────────────────────────────

# Extract verdict
step_extract_verdict() {
  STATUS="unknown"
  SESSION_ID=""

  # Prefer the most recently modified verdict.json (has both status and session_id)
  VERDICT_FILE=$(find .ironbee/sessions -name "verdict.json" -type f 2>/dev/null | xargs -r ls -t 2>/dev/null | head -1)
  if [ -n "$VERDICT_FILE" ] && [ -f "$VERDICT_FILE" ]; then
    STATUS=$(node -e "const v=JSON.parse(require('fs').readFileSync('$VERDICT_FILE','utf8'));console.log(v.status||'unknown')" 2>/dev/null || echo "unknown")
    # The session is the directory under sessions/: the verdict sits in it,
    # or in its owning agent's directory below it.
    SESSION_PATH="${VERDICT_FILE#.ironbee/sessions/}"
    SESSION_ID="${SESSION_PATH%%/*}"
    if [ "$PLAN_verbose" = "true" ]; then
      group_start "Verdict details"
      cat "$VERDICT_FILE" | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))" 2>/dev/null || cat "$VERDICT_FILE"
      group_end
    fi
  fi

  # Fallback: derive status/session_id from the latest verdict_write event,
  # read across every agent's actions.jsonl as the report reads them
  if [ -z "$SESSION_ID" ] || [ "$STATUS" = "unknown" ]; then
    EXTRACTED=$(node "$IRONBEE_BITBUCKET_HOME/scripts/build-report.js" --last-verdict .ironbee 2>/dev/null || echo "")
    if [ -n "$EXTRACTED" ]; then
      [ "$STATUS" = "unknown" ] && STATUS="${EXTRACTED%%|*}"
      [ -z "$SESSION_ID" ] && SESSION_ID="${EXTRACTED##*|}"
    fi
  fi

  # Fallback: session_id from the final result event in claude-output.log.raw
  if [ -z "$SESSION_ID" ] && [ -f ".ironbee/artifacts/claude-output.log.raw" ]; then
    SESSION_ID=$(node -e "
      const lines=require('fs').readFileSync('.ironbee/artifacts/claude-output.log.raw','utf8').split('\n').filter(Boolean);
      for (let i=lines.length-1;i>=0;i--) {
        try { const e=JSON.parse(lines[i]); if (e.type==='result' && e.session_id) { console.log(e.session_id); return; } } catch {}
      }
    " 2>/dev/null || echo "")
  fi

  # Final fallback: any session directory under .ironbee/sessions/
  if [ -z "$SESSION_ID" ]; then
    SESSION_DIR=$(find .ironbee/sessions -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1)
    [ -n "$SESSION_DIR" ] && SESSION_ID=$(basename "$SESSION_DIR")
  fi

  echo "status=$STATUS" >> "$IRONBEE_OUTPUT"
  echo "session_id=$SESSION_ID" >> "$IRONBEE_OUTPUT"
  echo "Verdict: $STATUS"
  echo "Session: ${SESSION_ID:-<none>}"
}
if [ "$PLAN_mode" = local ]; then
  run_step verdict "Extract verdict" step_extract_verdict
fi

# Collect session artifacts
step_collect() {
  ARTIFACTS_DIR=".ironbee/artifacts"
  HAS_ARTIFACTS=false

  # Copy each session to artifacts whole: its verdicts and actions sit in
  # its agents' directories
  for session_dir in .ironbee/sessions/*/; do
    if [ -d "$session_dir" ]; then
      SESSION_ID=$(basename "$session_dir")
      mkdir -p "$ARTIFACTS_DIR/sessions/$SESSION_ID"
      cp -R "$session_dir". "$ARTIFACTS_DIR/sessions/$SESSION_ID/" 2>/dev/null || true
      HAS_ARTIFACTS=true
    fi
  done

  # Check for any cycle directories with evidence
  if [ -n "$(find "$ARTIFACTS_DIR" -maxdepth 1 -name 'cycle-*' -type d 2>/dev/null)" ]; then
    HAS_ARTIFACTS=true
  fi

  if [ "$PLAN_verbose" = "true" ] && [ "$HAS_ARTIFACTS" = "true" ]; then
    group_start "Collected artifacts"
    find "$ARTIFACTS_DIR" -type f | sort
    group_end
  fi

  echo "has_artifacts=$HAS_ARTIFACTS" >> "$IRONBEE_OUTPUT"
}
if [ "$PLAN_mode" = local ]; then
  run_step collect "Collect session artifacts" step_collect
fi

# Upload verification evidence
step_upload_artifacts() {
  # The upload itself is the step's `artifacts:` (.ironbee/upload/**), which
  # Bitbucket collects from the clone when the step ends. The evidence is put
  # there now, as the action uploads it at this point.
  mkdir -p .ironbee/upload
  cp -R .ironbee/artifacts/. .ironbee/upload/
  echo "artifact-url=$(bitbucket_step_url https://bitbucket.org "$BITBUCKET_REPO_FULL_NAME" "$BITBUCKET_BUILD_NUMBER" "$BITBUCKET_STEP_UUID")" >> "$IRONBEE_OUTPUT"
}
if [ "$PLAN_mode" = local ] && [ "$COLLECT_has_artifacts" = true ]; then
  run_step upload-artifacts "Upload verification evidence" step_upload_artifacts
fi

# ── The report ─────────────────────────────────────────────────────
#
# One body, two sources. A local run leaves artifacts behind and the report
# is assembled from them; a platform run leaves a job body. The builder
# shares the header, the badge and the footer between the two so a reader
# sees one product rather than two tools that comment on the same PR.

# Build the verification report
step_report() {
  BODY_FILE="$(pwd)/.ironbee/report.md"
  mkdir -p .ironbee

  if [ "$PLAN_mode" = "platform" ]; then
    EARLIER_JOB_URL=""
    if [ -n "$JOB_REVERIFIED_job_url" ]; then
      EARLIER_JOB_URL="$JOB_job_url"
    fi
    node "$IRONBEE_BITBUCKET_HOME/scripts/build-report.js" \
      --job .ironbee/artifacts/job.json \
      --version "$INSTALL_CLI_ironbee_version" \
      --console "$PLAN_console_url" \
      --job-url "${JOB_REVERIFIED_job_url:-$JOB_job_url}" \
      --earlier-job-url "$EARLIER_JOB_URL" \
      --failure-code "$JOB_failure_code" \
      > "$BODY_FILE"
  else
    node "$IRONBEE_BITBUCKET_HOME/scripts/build-report.js" \
      ".ironbee/artifacts" \
      "$INSTALL_CLI_ironbee_version" \
      "$UPLOAD_ARTIFACTS_artifact_url" \
      "$PLAN_console_url" \
      "$VERDICT_session_id" \
      > "$BODY_FILE"
  fi

  echo "body_file=$BODY_FILE" >> "$IRONBEE_OUTPUT"
  # Bitbucket has no step summary: in its place the report goes to the log,
  # under its own header, and into the step's artifacts, in both modes.
  group_start "IronBee Verification Report"
  cat "$BODY_FILE"
  group_end
  mkdir -p .ironbee/upload
  cp "$BODY_FILE" .ironbee/upload/report.md
}
if [ -n "$PLAN_mode" ]; then
  run_step report "Build the verification report" step_report
fi

# Post the report on the pull request
step_post_report() {
  export BITBUCKET_OAUTH_TOKEN="$INPUT_BITBUCKET_OAUTH_TOKEN"
  export BODY_FILE="$REPORT_body_file"
  export PR_NUMBER="$BITBUCKET_PR_ID"
  # The job the report was built from: the re-verified one when it ran.
  export PLATFORM_PUBLISHES="${JOB_REVERIFIED_platform_publishes:-$JOB_platform_publishes}"

  # The platform writes this run on the pull request itself (a status,
  # inline comments, a summary), so a comment from here would be a second
  # summary. An older report comment is not updated either.
  if [ "$PLATFORM_PUBLISHES" = "true" ]; then
    annotate_notice "the platform publishes this run on the pull request itself; the report stays in the step log"
    exit 0
  fi

  # Without the step's token there is nothing to write a comment with.
  if [ -z "$BITBUCKET_OAUTH_TOKEN" ]; then
    annotate_warning "no BITBUCKET_OAUTH_TOKEN is set, so the report stays in the step log"
    exit 0
  fi

  # Updated in place rather than appended to: a PR that is pushed to
  # repeatedly would otherwise collect one comment per run.
  node "$IRONBEE_BITBUCKET_HOME/scripts/bitbucket-api.js" upsert-comment --id "$PR_NUMBER" --body-file "$BODY_FILE"
}
if [ -n "$REPORT_body_file" ] && [ "$EVENT_NAME" = merge_request ]; then
  run_step post-report "Post the report on the pull request" step_post_report
fi

# ── Land the fixes ─────────────────────────────────────────────────
#
# On a pull request the fix belongs on the PR's own branch. This is the path
# that previously had no push step at all: the prompt asked the agent to
# commit, and whether the commit was ever pushed depended on the agent
# deciding to run `git push`.
#
# Bitbucket runs a pull request pipeline on the source merged with the
# destination, a commit that belongs to no branch, so the push names the
# source branch explicitly.
#
# Bitbucket starts a pipeline for every push, and without a skip the fix
# commit would verify itself, and fix itself, forever. `[skip ci]` in the
# commit message skips every pipeline the push starts, so both fix commits
# carry it; Bitbucket takes no push option.
#
# The push goes to REPOSITORY_URL, and the token reaches git through the
# credential helper pipe.sh set, never the command line.
#
# A fix the re-verification rejected is not pushed, the same rule the fix PR
# follows and for a stronger reason: this branch belongs to whoever opened
# the pull request, and putting an unverified commit on it is more intrusive
# than opening a pull request they can ignore. Only `fail` blocks — an empty
# verdict means no re-verification ran and `unknown` means one ran without
# concluding, and neither is evidence against the fix.
#
# With fixing off nothing is committed: a file the run changed then — a
# build's output, an agent that strayed from its prompt — is not a fix.

# Commit the fixes to the pull request branch
step_commit_fixes() {
  export HEAD_REF="$BITBUCKET_BRANCH"
  export BITBUCKET_OAUTH_TOKEN="$INPUT_BITBUCKET_OAUTH_TOKEN"

  # The paths the fix touched and nothing else: what an install or a build
  # left in the tree is not a fix. The index is emptied first, so nothing
  # the agent staged itself comes along.
  git reset -q || true
  node "$IRONBEE_BITBUCKET_HOME/scripts/fix-paths.js" stage .ironbee/fix-paths
  # The IronBee setup was written before the snapshot, so it is never among
  # those paths: a caller who keeps it in the commits has it staged here.
  if [ "$PLAN_exclude_files" != "true" ]; then
    stage_setup_paths
  fi
  # Always unstaged: this action's own working files. The rest only when
  # the caller asked for the IronBee setup to stay out of their commits.
  git reset HEAD -- .ironbee/ 2>/dev/null || true
  if [ "$PLAN_exclude_files" = "true" ]; then
    git reset HEAD -- .mcp.json .gitignore .claude/ 2>/dev/null || true
  fi

  if [ -z "$(git diff --cached --name-only)" ]; then
    echo "No fixes to commit"
    exit 0
  fi

  # Without the step's token the fix exists only in this pipe — the same
  # reason a push that cannot land fails below.
  if [ -z "$BITBUCKET_OAUTH_TOKEN" ]; then
    annotate_error "there are fixes to push to ${HEAD_REF}, and no BITBUCKET_OAUTH_TOKEN to push them with"
    exit 1
  fi

  git commit -m "fix: apply IronBee verification fixes [skip ci]"

  # A push that cannot land fails the step even when the verification
  # passed, and deliberately: the fix exists only in this pipe's
  # filesystem, and a green build over a fix nobody received is worse than
  # a red one that says why.
  if ! git push "$REPOSITORY_URL" "HEAD:refs/heads/${HEAD_REF}"; then
    annotate_error "could not push the fixes to ${HEAD_REF} — the branch may have moved since this run checked it out"
    exit 1
  fi
  echo "Pushed the fixes to ${HEAD_REF}"
}
if [ -n "$PLAN_mode" ] \
  && [ "$PLAN_can_fix" = true ] \
  && { [ "$PLATFORM_FIX_fixed" = true ] || [ "$CLAUDE_VERIFY_fixed" = true ]; } \
  && [ "$EVENT_NAME" = merge_request ] \
  && [ "$IS_FORK" != true ] \
  && [ "$JOB_REVERIFIED_verdict" != fail ] \
  && [ "$VERDICT_status" != fail ]; then
  run_step commit-fixes "Commit the fixes to the pull request branch" step_commit_fixes
fi

# ── Fix PR for non-PR events ──────────────────────────────────────
# A fix the re-verification rejected opens nothing. The PR's whole claim is
# that it repairs what the run reported, and the one piece of evidence about
# that says otherwise — so opening it would put a claim in front of a
# reviewer that the run itself already contradicted.
#
# Only `fail` blocks. An empty verdict means no re-verification ran (a
# deployed URL serves what was deployed, so a second run there would verify
# the same bytes), and `unknown` means one ran without reaching a verdict —
# neither is evidence against the fix, and discarding it on either would
# throw away good work over a missing signal.
#
# With fixing off nothing is opened, for the reason the push above gives.

# Create fix PR
step_create_fix_pr() {
  export BITBUCKET_OAUTH_TOKEN="$INPUT_BITBUCKET_OAUTH_TOKEN"
  export BODY_FILE="$REPORT_body_file"

  ORIGINAL_SHA="$COMMIT_SHA"

  # Nothing to open a PR for when neither the agent nor the fix round
  # touched a file.
  # `.ironbee` excluded for the same reason as in the fix step: this
  # action's own working files are not the agent's changes.
  if [ "$ORIGINAL_SHA" = "$(git rev-parse HEAD)" ] \
     && [ -z "$(git status --porcelain -- ':(exclude).ironbee')" ]; then
    echo "No changes detected — verification passed or issues require manual review"
    exit 0
  fi

  SHORT_SHA=$(echo "$ORIGINAL_SHA" | cut -c1-7)
  BRANCH="ironbee/fix-${SHORT_SHA}-${BITBUCKET_BUILD_NUMBER}"

  # Only the paths the fix touched, and the IronBee setup when the caller
  # keeps it, from an emptied index, as on a pull request.
  git reset -q || true
  node "$IRONBEE_BITBUCKET_HOME/scripts/fix-paths.js" stage .ironbee/fix-paths
  if [ "$PLAN_exclude_files" != "true" ]; then
    stage_setup_paths
  fi
  if [ "$PLAN_exclude_files" = "true" ]; then
    git reset HEAD -- .mcp.json .gitignore .claude/ 2>/dev/null || true
  fi
  git reset HEAD -- .ironbee/ 2>/dev/null || true
  if [ -n "$(git diff --cached --name-only)" ]; then
    git commit -m "fix: apply IronBee verification fixes for ${SHORT_SHA} [skip ci]"
  fi

  if [ "$ORIGINAL_SHA" = "$(git rev-parse HEAD)" ]; then
    echo "No commits to push"
    exit 0
  fi

  # Move the fix commits onto their own branch and put the checkout back
  # where it started, so nothing here can be mistaken for a push to the
  # branch the run was triggered on.
  git branch "$BRANCH"
  git reset --hard "$ORIGINAL_SHA"

  # Without the step's token there is nothing to push the branch or open the
  # pull request with.
  if [ -z "$BITBUCKET_OAUTH_TOKEN" ]; then
    annotate_error "there are fixes to open a pull request for, and no BITBUCKET_OAUTH_TOKEN to push them with"
    exit 1
  fi
  # Skipped and credentialed as the push to a pull request branch is.
  git push "$REPOSITORY_URL" "$BRANCH"

  if [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ]; then
    node "$IRONBEE_BITBUCKET_HOME/scripts/bitbucket-api.js" create-pr \
      --title "fix: IronBee verification fixes for ${SHORT_SHA}" \
      --body-file "$BODY_FILE" \
      --target "$REF_NAME" \
      --source "$BRANCH"
  else
    node "$IRONBEE_BITBUCKET_HOME/scripts/bitbucket-api.js" create-pr \
      --title "fix: IronBee verification fixes for ${SHORT_SHA}" \
      --description "IronBee applied these fixes. The verification report is not available for this run." \
      --target "$REF_NAME" \
      --source "$BRANCH"
  fi
}
if [ -n "$PLAN_mode" ] \
  && [ "$PLAN_can_fix" = true ] \
  && { [ "$PLATFORM_FIX_fixed" = true ] || [ "$CLAUDE_VERIFY_fixed" = true ]; } \
  && [ "$EVENT_NAME" != merge_request ] \
  && [ "$JOB_REVERIFIED_verdict" != fail ] \
  && [ "$VERDICT_status" != fail ]; then
  run_step create-fix-pr "Create fix PR" step_create_fix_pr
fi

# ── Teardown ───────────────────────────────────────────────────────
#
# After everything that could still need the application: the fix round and
# the re-verification both run against it.
# Before the stop, not after: whatever holds the logs is usually the same
# thing the stop removes.

# Collect the application's own logs
step_collect_app_logs() {
  export APP_LOGS_COMMAND="$INPUT_APP_LOGS_COMMAND"

  mkdir -p .ironbee/artifacts
  bash -c "$APP_LOGS_COMMAND" > .ironbee/artifacts/app-service-logs.txt 2>&1 \
    || annotate_warning "APP_LOGS_COMMAND failed; the evidence carries no application logs"
}
if [ "$PLAN_needs_app" = true ] && [ -n "$INPUT_APP_LOGS_COMMAND" ]; then
  run_step collect-app-logs "Collect the application's own logs" step_collect_app_logs
fi

# Stop the application
step_stop_app() {
  # The whole process group, as the restart stops it.
  if [ -f .ironbee/app.pid ]; then
    stop_app_process "$(cat .ironbee/app.pid)"
    rm -f .ironbee/app.pid
  fi
  if [ -f .ironbee/forward-port.pid ]; then
    kill "$(cat .ironbee/forward-port.pid)" 2>/dev/null || true
    rm -f .ironbee/forward-port.pid
  fi
}
if [ "$PLAN_needs_app" = true ]; then
  run_step stop-app "Stop the application" step_stop_app
fi

# Upload the application log
step_upload_app_log() {
  # Into .ironbee/upload/, which the step's `artifacts:` keeps when the step
  # ends; a log that was never written is left out.
  mkdir -p .ironbee/upload
  for file in app.log app-service-logs.txt; do
    if [ -f ".ironbee/artifacts/$file" ]; then
      cp ".ironbee/artifacts/$file" .ironbee/upload/
    fi
  done
}
if [ "$PLAN_needs_app" = true ]; then
  run_step upload-app-log "Upload the application log" step_upload_app_log
fi

# The action's outputs, now that every step that sets one has run.
write_outputs_env
write_output_variables

# ── The gate ───────────────────────────────────────────────────────
#
# The last step in the file, deliberately. The step that ran the
# verification could not fail the pipe — the report, the outputs and the
# teardown all had to run first — so the code it recorded is exited here,
# after all of them.

# Fail the job when the verification did
step_gate() {
  export MODE="$PLAN_mode"
  export PLATFORM_CODE="${PLATFORM_REVERIFY_exit_code:-$PLATFORM_VERIFY_exit_code}"
  export PLATFORM_VERDICT="${JOB_REVERIFIED_verdict:-$JOB_verdict}"
  export LOCAL_VERDICT="$VERDICT_status"

  node "$IRONBEE_BITBUCKET_HOME/scripts/gate.js"
}
if [ -n "$PLAN_mode" ]; then
  run_step gate "Fail the job when the verification did" step_gate
fi

if [ -n "$STEP_FAILED" ]; then
  exit 1
fi
exit 0
