#!/bin/sh
# The deployment image, run the way deploy/docker-compose.yml runs it: AIW_ENV=production, the
# gateway's seven capabilities only, no-new-privileges, the egress firewall on, a named volume.
# No real secrets: the provider key is a placeholder (no model call is made), so this proves
# startup, readiness, the firewall, sign-in, per-person uids, image contents, graceful stop and
# restart persistence, not a live model.
#   sudo sh bench/hosted/image-test.sh        (Linux with Docker; image ai-worker:pilot built)
set -u
IMG=${IMG:-ai-worker:pilot} NAME=aiw-imagetest VOL=aiw-imagetest PORT=18080 ORIGIN=https://aiworker.test
PW="correct-horse-battery-1"
pass=0 fail=0
ok() { pass=$((pass+1)); echo "PASS $*"; }
no() { fail=$((fail+1)); echo "FAIL $*"; }
cleanup() { docker rm -f $NAME >/dev/null 2>&1; docker volume rm $VOL >/dev/null 2>&1; }
cleanup
start() {
  docker run -d --name $NAME --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add NET_ADMIN \
    --security-opt no-new-privileges:true --stop-timeout 30 -v $VOL:/data -p 127.0.0.1:$PORT:8080 \
    -e AIW_PUBLIC_ORIGIN=$ORIGIN -e ANTHROPIC_API_KEY=sk-ant-placeholder-not-a-real-key -e AIW_EGRESS_FIREWALL=1 -e AIW_TRUST_PROXY=1 "$IMG" >/dev/null
  for i in $(seq 1 60); do curl -fs http://127.0.0.1:$PORT/healthz >/dev/null && return 0; sleep 1; done; return 1
}
U="http://127.0.0.1:$PORT"

# 1. The image holds no local state, no developer data, no node_modules from another OS.
leak=$(docker run --rm --entrypoint sh "$IMG" -c 'cd /app; ls -d worker-ui/runs worker-ui/scratch* worker-ui/workers worker-ui/teams worker-ui/*.json bench exports 2>/dev/null; grep -rIl -e "matwproject" -e "@pilot.test" /app/worker-ui /app/mcp/*.mjs 2>/dev/null')
[ -z "$leak" ] && ok "image contents: no run history, workers, Teams, workspaces, prompts, benchmarks or exports" || no "image contains: $leak"

# 2. Production start: firewall installed, then the gateway; /readyz 200 with every check passing.
if start; then ok "production start: healthy on /healthz"; else no "didn't start: $(docker logs $NAME 2>&1 | tail -5)"; fi
docker logs $NAME 2>&1 | grep -q "egress firewall installed" && ok "the egress firewall was installed at start" || no "no firewall line in the log"
r=$(curl -s -o /tmp/aiw-readyz.json -w '%{http_code}' $U/readyz)
[ "$r" = 200 ] && ok "/readyz 200: $(tr -d '\n' < /tmp/aiw-readyz.json | cut -c1-200)" || no "/readyz $r: $(cat /tmp/aiw-readyz.json)"
grep -q "sk-ant-placeholder" /tmp/aiw-readyz.json && no "/readyz shows the key" || ok "/readyz shows no secret"

# 3. Sign-in through the gateway as in production (https origin: __Host- cookie, Secure).
docker exec -i $NAME node /app/worker-ui/users.mjs add alice@pilot.test --name Alice --password-stdin >/dev/null <<EOF
$PW
EOF
docker exec -i $NAME node /app/worker-ui/users.mjs add bob@pilot.test --name Bob --password-stdin >/dev/null <<EOF
$PW
EOF
login() { curl -s -D - -o /dev/null -H "Origin: $ORIGIN" -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PW\"}" $U/login | tr -d '\r' | sed -n 's/^set-cookie: \([^;]*\);.*/\1/Ip'; }
CA=$(login alice@pilot.test); CB=$(login bob@pilot.test)
hdr=$(curl -s -D - -o /dev/null -H "Origin: $ORIGIN" -H 'content-type: application/json' -d "{\"email\":\"alice@pilot.test\",\"password\":\"$PW\"}" $U/login | tr -d '\r' | grep -i '^set-cookie')
echo "$hdr" | grep -q "__Host-aiw_session=" && echo "$hdr" | grep -q "Secure" && echo "$hdr" | grep -q "HttpOnly" && ok "session cookie is __Host-, Secure, HttpOnly" || no "cookie: $hdr"
pa=$(curl -s -H "cookie: $CA" $U/platform); pb=$(curl -s -H "cookie: $CB" $U/platform)
echo "$pa" | grep -q '"hosted":true' && echo "$pa" | grep -q alice@pilot.test && echo "$pb" | grep -q bob@pilot.test && ok "both people reach their own console" || no "platform: $pa / $pb"
[ "$(curl -s -o /dev/null -w '%{http_code}' $U/runs)" = 401 ] && ok "signed out: the API refuses" || no "signed-out API answered"

# 4. Per-person uids and the egress firewall inside the running container.
uids=$(docker exec $NAME sh -c 'for p in /proc/[0-9]*; do grep -q 'worker-ui/server[.]mjs' $p/cmdline 2>/dev/null && stat -c %u $p; done' | sort -u | tr '\n' ' ')
[ "$uids" = "20001 20002 " ] && ok "consoles run as uids $uids" || no "console uids: $uids"
BOBDIR=$(docker exec $NAME sh -c 'for d in /data/users/*; do [ "$(stat -c %u $d)" = 20002 ] && echo $d; done')
cross=$(docker exec $NAME setpriv --reuid=20001 --regid=20001 --clear-groups sh -c "ls $BOBDIR/data 2>&1; cat /data/control/users.json 2>&1; ls /data/users 2>&1" | grep -c "Permission denied")
[ "$cross" -ge 3 ] && ok "uid 20001 can't read another person's folder, the account store, or list who has an account" || no "cross-person read possible ($cross denials)"
probe() { docker exec $NAME setpriv --reuid=20001 --regid=20001 --clear-groups node -e "fetch('$1',{signal:AbortSignal.timeout(8000)}).then(r=>console.log('reachable')).catch(e=>console.log('refused'))"; }
[ "$(probe http://169.254.169.254/latest/meta-data/)" = refused ] && ok "firewall: metadata refused for a person uid" || no "metadata reachable"
[ "$(probe http://127.0.0.1:8080/healthz)" = refused ] && ok "firewall: the gateway's public port refused for a person uid" || no "gateway port reachable from a person uid"
[ "$(probe https://api.github.com/zen)" = reachable ] && ok "firewall: the internet reachable for a person uid" || no "internet unreachable"
caps=$(docker exec $NAME sh -c 'for p in /proc/[0-9]*; do grep -q 'worker-ui/server[.]mjs' $p/cmdline 2>/dev/null && grep CapEff $p/status; done' | sort -u | tr -s ' \t' ' ')
[ "$caps" = "CapEff: 0000000000000000" ] && ok "consoles have no capabilities" || no "console capabilities: $caps"

# 5. Graceful stop and restart: sessions, accounts and data survive.
t0=$(date +%s); docker stop $NAME >/dev/null; t1=$(date +%s)
code=$(docker inspect -f '{{.State.ExitCode}}' $NAME)
docker logs $NAME 2>&1 | grep -q '"shutting down"' && [ "$code" = 0 ] && ok "graceful stop in $((t1-t0))s, exit 0, consoles stopped" || no "stop: exit $code; $(docker logs $NAME 2>&1 | tail -3)"
docker start $NAME >/dev/null; for i in $(seq 1 60); do curl -fs $U/healthz >/dev/null && break; sleep 1; done
curl -s -H "cookie: $CA" $U/auth/me | grep -q alice@pilot.test && ok "after a restart the session and account are still there" || no "session lost after restart"

cleanup
echo "$pass passed, $fail failed (image $IMG)"
[ $fail = 0 ]
