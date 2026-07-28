#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=version.sh
source "$SCRIPT_DIR/version.sh"

assert_pass() {
  local actual="$1"
  if ! tmcp_semver_at_least "$actual" "$TMCP_MIN_UM_VERSION"; then
    echo "FAIL: expected $actual >= $TMCP_MIN_UM_VERSION" >&2
    exit 1
  fi
}

assert_fail() {
  local actual="$1"
  if tmcp_semver_at_least "$actual" "$TMCP_MIN_UM_VERSION"; then
    echo "FAIL: expected $actual < $TMCP_MIN_UM_VERSION" >&2
    exit 1
  fi
}

assert_pass "0.2.65"
assert_pass "v0.2.65"
assert_pass "0.2.65+build.1"
assert_pass "0.2.66-beta.1"
assert_pass "1.0.0"

assert_fail "0.2.64"
assert_fail "0.2.65-beta.18"
assert_fail "0.2"
assert_fail "1.2.3.4"
assert_fail "1.2.x"
assert_fail "not-a-version"

echo "PASS: um CLI semver gate >= $TMCP_MIN_UM_VERSION"
