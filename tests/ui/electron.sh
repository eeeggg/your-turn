#!/bin/sh
set -eu

if ! command -v bwrap >/dev/null 2>&1; then
  echo 'Linux UI tests require bubblewrap (bwrap) with user namespaces enabled.' >&2
  exit 125
fi
: "${UI_EXECUTABLE:?Missing UI executable}"
: "${UI_STATUS:?Missing UI namespace status path}"

# Keep the launch group intact for Playwright's launch-failure cleanup.
exec bwrap --unshare-user --unshare-pid --die-with-parent --as-pid-1 \
  --dev-bind / / --proc /proc --json-status-fd 9 -- /bin/sh -c '
    [ -S /proc/self/fd/3 ] || { echo "Playwright owner socket is unavailable on descriptor 3" >&2; exit 125; }
    exec 5<&0
    "$@" 0<&5 5<&- &
    command=$!
    exec 5<&-
    { cat <&3 >/dev/null; kill -KILL -1; } &
    wait "$command"
  ' sh "$UI_EXECUTABLE" "$@" 9>"$UI_STATUS"
