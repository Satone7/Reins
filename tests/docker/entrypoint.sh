#!/usr/bin/env bash
set -euo pipefail

if [ -f "/workspace/reins/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source <(tr -d '\r' < /workspace/reins/.env)
  set +a
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "================================================================================" >&2
  echo "[ERROR] DEEPSEEK_API_KEY is not set." >&2
  echo "Before running the Docker test suite, copy .env.example to .env and set your key:" >&2
  echo "  cp .env.example .env" >&2
  echo "  # Edit .env and set DEEPSEEK_API_KEY=sk-..." >&2
  echo "================================================================================" >&2
  exit 1
fi

export REINS_TEST_MODEL="${REINS_TEST_MODEL:-deepseek-flash}"
export DEEPSEEK_MODEL="${REINS_TEST_MODEL}"
export REINS_CONFIG="/workspace/reins/config/reins.test.yaml"
export REINS_IGNORE_USER_CONFIG="1"
export REINS_DOCKER_TEST="1"

mkdir -p /run/sshd
/usr/sbin/sshd -p 2222

echo "[reins-docker] Verifying local SSH node connectivity (reins-ssh-node:2222)..."
ssh reins-ssh-node "tmux -V && node -v"

echo "[reins-docker] Running unit & protocol conformance tests (npm test)..."
npm test

echo "[reins-docker] Running live E2E verification with model=${REINS_TEST_MODEL} (npm run test:e2e)..."
npm run test:e2e
