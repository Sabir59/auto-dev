#!/bin/sh
# Container entrypoint: optionally installs the egress firewall for the person uids, then runs the
# gateway (which refuses to start if its configuration is incomplete).
set -e
if [ "${AIW_EGRESS_FIREWALL:-0}" = "1" ]; then
  /app/deploy/egress-firewall.sh
fi
exec node /app/worker-ui/gateway.mjs
