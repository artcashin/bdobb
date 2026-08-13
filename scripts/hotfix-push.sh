#!/usr/bin/env bash
# Break-glass: push straight to a protected branch, then re-arm it.
#
# main requires a PR plus three green CI checks, and that rule applies to
# admins too. That is the point -- it is why a broken commit can no longer
# reach main the way ef673a4 did -- but it also means there is no way to land
# a genuinely urgent fix without briefly stepping around it.
#
# This opens that window and, more importantly, always closes it: the re-arm
# runs from an EXIT trap, so a rejected push, a failed command, or Ctrl-C
# still leaves the branch protected. The script exits non-zero if it cannot
# confirm the branch was re-armed, so a silent failure cannot look like success.
#
# It toggles ONLY `enforce_admins`. The required-PR and required-check rules
# are never deleted, so a bug in here cannot wipe the protection config --
# the worst case is a branch that admins can push to until the next run.
#
#   scripts/hotfix-push.sh                                  # git push origin main
#   scripts/hotfix-push.sh git push --force-with-lease origin main
#   HOTFIX_YES=1 scripts/hotfix-push.sh                     # skip the prompt (CI/automation)
#   HOTFIX_BRANCH=release/v10.0.0 scripts/hotfix-push.sh    # a different protected branch
#
# Prefer a normal PR whenever the fix can wait for CI. Every use of this puts
# an unreviewed, untested commit on main -- so open a follow-up PR with the
# tests you skipped.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${HOTFIX_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
BRANCH="${HOTFIX_BRANCH:-main}"
API="repos/${REPO}/branches/${BRANCH}/protection/enforce_admins"

CMD=("$@")
[[ ${#CMD[@]} -eq 0 ]] && CMD=(git push origin "$BRANCH")

# The steady state is "enforcement on", so that is what we restore to -- even
# if we found it off, which would mean an earlier run died before its trap.
rearmed=0
# shellcheck disable=SC2329  # invoked indirectly, from the trap below
rearm() {
  if [[ $rearmed -eq 1 ]]; then
    return 0
  fi
  rearmed=1
  echo "==> Re-arming admin enforcement on ${REPO}@${BRANCH}" >&2
  local state=""
  for attempt in 1 2 3; do
    if gh api -X POST "$API" --silent 2>/dev/null; then
      state="$(gh api "$API" --jq .enabled 2>/dev/null || echo "")"
      if [[ "$state" == "true" ]]; then
        echo "==> ${BRANCH} is protected again." >&2
        return 0
      fi
    fi
    echo "    re-arm attempt ${attempt} failed, retrying..." >&2
    sleep 2
  done
  # Loud, actionable, and non-zero: an unprotected main must never be quiet.
  cat >&2 <<EOF

!!! FAILED TO RE-ARM PROTECTION ON ${REPO}@${BRANCH} !!!
!!! Admins can currently push directly to ${BRANCH}.
!!! Fix it now:
!!!   gh api -X POST ${API}
EOF
  return 1
}

enforced="$(gh api "$API" --jq .enabled 2>/dev/null || echo "unreadable")"
case "$enforced" in
  true) ;;
  false)
    echo "WARNING: admin enforcement on ${REPO}@${BRANCH} was already OFF." >&2
    echo "         An earlier run probably died before re-arming. Continuing;" >&2
    echo "         this run will turn it back on when it finishes." >&2
    ;;
  *)
    echo "ERROR: cannot read protection state for ${REPO}@${BRANCH}." >&2
    echo "       Check 'gh auth status' and that you have admin on the repo." >&2
    exit 1
    ;;
esac

if [[ "${HOTFIX_YES:-}" != "1" ]]; then
  if [[ ! -t 0 ]]; then
    echo "ERROR: refusing to bypass protection without a confirmation." >&2
    echo "       Re-run on a terminal, or set HOTFIX_YES=1 deliberately." >&2
    exit 1
  fi
  echo "About to bypass branch protection on ${REPO}@${BRANCH} and run:" >&2
  echo "    ${CMD[*]}" >&2
  read -r -p "This skips code review and CI. Continue? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted." >&2; exit 1 ;;
  esac
fi

trap rearm EXIT INT TERM

echo "==> Disabling admin enforcement on ${REPO}@${BRANCH}" >&2
gh api -X DELETE "$API" --silent

set +e
"${CMD[@]}"
status=$?
set -e

if [[ $status -ne 0 ]]; then
  echo "==> Command failed (exit ${status}); protection still restored below." >&2
fi
exit "$status"
