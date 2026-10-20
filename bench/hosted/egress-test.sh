#!/bin/sh
# Verifies deploy/egress-firewall.sh on Linux, as root: installs the rules, probes as a person uid
# and as root, then removes the rules. Probes: the model port on loopback (allowed), another
# loopback service (refused), a private address and the cloud metadata address (refused at once,
# not a timeout), the public internet (allowed), and root unaffected.
#   sudo sh bench/hosted/egress-test.sh      (needs iptables, setpriv, node, network access)
set -u
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
UID_P=20001 MODEL_PORT=18090 OTHER_PORT=18099
node -e "for (const p of [$MODEL_PORT, $OTHER_PORT]) require('http').createServer((q, s) => s.end('ok')).listen(p, '127.0.0.1')" &
SRV=$!
sleep 1
AIW_UID_BASE=20000 AIW_MODEL_PORT=$MODEL_PORT sh "$REPO/deploy/egress-firewall.sh" || { kill $SRV; exit 1; }
probe() { # who url -> reachable | refused (<code>)
  if [ "$1" = person ]; then RUN="setpriv --reuid=$UID_P --regid=$UID_P --clear-groups"; else RUN=""; fi
  $RUN node -e "const t=Date.now();fetch('$2',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('reachable',r.status)).catch(e=>console.log('refused',(e.cause&&e.cause.code)||e.name,(Date.now()-t)+'ms'))"
}
fail=0
check() { out=$(probe "$1" "$2"); echo "$1 $2 -> $out"; case "$out" in $3*) ;; *) fail=1; echo "  expected $3";; esac; }
check person "http://127.0.0.1:$MODEL_PORT/" reachable
check person "http://127.0.0.1:$OTHER_PORT/" refused
check person "http://10.255.255.1/" refused
check person "http://169.254.169.254/latest/meta-data/" refused
check person "https://api.github.com/zen" reachable
check root "http://127.0.0.1:$OTHER_PORT/" reachable
# remove the rules again
for IPT in iptables ip6tables; do
  "$IPT" -D OUTPUT -m owner --uid-owner 20001-29999 -j AIW_EGRESS 2>/dev/null; "$IPT" -F AIW_EGRESS 2>/dev/null; "$IPT" -X AIW_EGRESS 2>/dev/null
done
kill $SRV
[ $fail = 0 ] && echo "egress: all probes as expected" || { echo "egress: FAILED"; exit 1; }
