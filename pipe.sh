#!/usr/bin/env bash
#
# The pipe's entry point.
#
# Bitbucket hands a pipe its variables under their own names, in the
# environment of everything the pipe starts. They are checked, given the
# defaults pipe.yml declares, and moved to the INPUT_<NAME>s scripts/run.sh
# reads, so no step hands a credential to a process the action's `env:` did
# not. Then git is given what the pipe's fetches and pushes need, the commit is
# resolved, and run.sh takes over.
#
# Sourcing this file defines its table and helpers and stops, which is how the
# tests reach them.

IRONBEE_BITBUCKET_HOME="${IRONBEE_BITBUCKET_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
export IRONBEE_BITBUCKET_HOME
# run.sh's helpers (the annotations), without its steps.
source "$IRONBEE_BITBUCKET_HOME/scripts/run.sh"

# Every variable the pipe takes, with pipe.yml's default. A credential defaults
# to the pipeline variable of its own name, which reaches a pipe only when the
# step passes it, so its default here is empty.
PIPE_VARIABLES=(
  'VERIFICATION_MODE=auto'
  'IRONBEE_API_KEY='
  'IRONBEE_API_URL='
  'IRONBEE_COLLECTOR_URL='
  'IRONBEE_CONSOLE_URL='
  'IRONBEE_CLI_VERSION=latest'
  'IRONBEE_PROJECT='
  'IRONBEE_ENVIRONMENT='
  'IRONBEE_BIND_REPOSITORY=true'
  'IRONBEE_JOB_TIMEOUT_MINUTES='
  'IRONBEE_BROWSER_DEVTOOLS=true'
  'IRONBEE_BACKEND_DEVTOOLS=false'
  'IRONBEE_NODE_DEVTOOLS=false'
  'IRONBEE_PYTHON_DEVTOOLS=false'
  'IRONBEE_TERMINAL_DEVTOOLS=false'
  'IRONBEE_EXTRA_CONFIG='
  'IRONBEE_EXCLUDE_FILES=true'
  'ANTHROPIC_API_KEY='
  'CLAUDE_CODE_OAUTH_TOKEN='
  'CLAUDE_CODE_CLI_VERSION=latest'
  'CLAUDE_CODE_MODEL='
  'CLAUDE_CODE_MAX_TURNS=100'
  'CLAUDE_CODE_ARGS='
  'VERIFICATION_PROMPT='
  'VERIFICATION_AUTO=true'
  'VERIFICATION_APPLY_FIX=true'
  'APP_INSTALL_COMMAND='
  'APP_BUILD_COMMAND='
  'APP_START_COMMAND='
  'APP_URL='
  'APP_PORT='
  'APP_RESTART_COMMAND='
  'APP_LOGS_COMMAND='
  'APP_WAIT_SECONDS='
  'APP_HEADERS='
  'APP_SECRET_HEADERS='
  'BITBUCKET_OAUTH_TOKEN='
  'EVENT_NAME='
  'WORKING_DIRECTORY=.'
  'VERBOSE=false'
)

# Each variable as INPUT_<NAME>: its value when the step passed one, empty
# included, as a component input given an empty value; its default when it
# did not. The variable itself leaves the environment.
map_variables() {
  local entry name
  for entry in "${PIPE_VARIABLES[@]}"; do
    name="${entry%%=*}"
    if [ -n "${!name+set}" ]; then
      printf -v "INPUT_${name}" '%s' "${!name}"
    else
      printf -v "INPUT_${name}" '%s' "${entry#*=}"
    fi
    export "INPUT_${name}"
    unset "$name"
  done
}

# There is no `required` in pipe.yml, so what the pipe itself cannot run
# without is checked here: the step's own variables, and EVENT_NAME, the one
# variable Bitbucket has no counterpart of. The action's one required input,
# IRONBEE_API_KEY, is resolve-plan.js's to check, after a run that is switched
# off has stopped quietly.
validate_variables() {
  local failed=0
  if [ -z "${BITBUCKET_REPO_FULL_NAME:-}" ] || [ -z "${BITBUCKET_COMMIT:-}" ]; then
    annotate_error "BITBUCKET_REPO_FULL_NAME and BITBUCKET_COMMIT are not set — the pipe runs in a Bitbucket Pipelines step"
    failed=1
  fi
  case "${INPUT_EVENT_NAME:-}" in
    '' | merge_request | push | manual | schedule)
      ;;
    *)
      annotate_error "EVENT_NAME must be one of merge_request, push, manual, schedule (got '${INPUT_EVENT_NAME}')"
      failed=1
      ;;
  esac
  return "$failed"
}

# The clone is mounted from the build container and owned by whoever cloned
# it, and git refuses a repository another user owns. The pipe's fetches and
# pushes authenticate as x-token-auth with the step's token, which the helper
# reads from the environment of the git it serves: the steps that fetch or
# push export it from its input, and nothing else does.
configure_git() {
  git config --global --add safe.directory "${BITBUCKET_CLONE_DIR:-$PWD}"
  git config --global credential.https://bitbucket.org.helper ''
  git config --global --add credential.https://bitbucket.org.helper \
    '!f() { echo username=x-token-auth; echo "password=$BITBUCKET_OAUTH_TOKEN"; }; f'
}

# A pull request pipeline names its commit by 12 characters, and every reader
# of it wants the full hash. Left as it is when this clone cannot resolve it.
resolve_commit() {
  local full
  if full="$(git rev-parse --verify --quiet "${BITBUCKET_COMMIT}^{commit}" 2>/dev/null)" && [ -n "$full" ]; then
    BITBUCKET_COMMIT="$full"
  fi
  export BITBUCKET_COMMIT
}

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

map_variables
if ! validate_variables; then
  exit 1
fi
configure_git
resolve_commit
# A pipe has no terminal: a refused credential fails rather than prompts.
export GIT_TERMINAL_PROMPT=0
# Inside the clone, where a custom cache of the step can keep the browsers.
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${BITBUCKET_CLONE_DIR:-$PWD}/.cache/ms-playwright}"

exec bash "$IRONBEE_BITBUCKET_HOME/scripts/run.sh"
