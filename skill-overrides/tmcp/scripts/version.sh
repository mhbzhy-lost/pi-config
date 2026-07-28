#!/usr/bin/env bash

# TMCP plugin 当前依赖的最低正式版 um CLI。
TMCP_MIN_UM_VERSION="${TMCP_MIN_UM_VERSION:-0.2.65}"

# 判断实际版本是否不低于一个稳定版下限。
# 支持 v 前缀、build metadata 和 prerelease；与下限同 core 的 prerelease 不通过。
tmcp_semver_at_least() {
  local actual="${1#v}"
  local minimum="${2#v}"
  local actual_without_build="${actual%%+*}"
  local minimum_without_build="${minimum%%+*}"
  local actual_core="${actual_without_build%%-*}"
  local minimum_core="${minimum_without_build%%-*}"
  local actual_major actual_minor actual_patch
  local minimum_major minimum_minor minimum_patch

  IFS=. read -r actual_major actual_minor actual_patch <<<"$actual_core"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<<"$minimum_core"

  [[ "$actual_core" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ "$minimum_core" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1

  if [ "$actual_major" -ne "$minimum_major" ]; then
    [ "$actual_major" -gt "$minimum_major" ]
    return
  fi
  if [ "$actual_minor" -ne "$minimum_minor" ]; then
    [ "$actual_minor" -gt "$minimum_minor" ]
    return
  fi
  if [ "$actual_patch" -ne "$minimum_patch" ]; then
    [ "$actual_patch" -gt "$minimum_patch" ]
    return
  fi

  # 当前下限是稳定版；同 core 的 beta/rc 仍低于正式版。
  [ "$actual_without_build" = "$actual_core" ]
}
