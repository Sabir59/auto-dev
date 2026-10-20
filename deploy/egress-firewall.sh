#!/bin/sh
# Egress rules for the per-person uids (AIW_UID_BASE+1 … AIW_UID_BASE+9999): their consoles, workers,
# browsers and git may reach the public internet and the gateway's model endpoint, but not this
# machine's other services, private networks or the cloud metadata service. The gateway itself
# (root) is not affected. Needs iptables and NET_ADMIN in the network namespace the processes run in
# (the container's). docs/CLOUD_DEPLOYMENT.md §6.
set -eu
BASE=${AIW_UID_BASE:-20000}
RANGE="$((BASE + 1))-$((BASE + 9999))"
MODEL_PORT=${AIW_MODEL_PORT:-8090}
CHAIN=AIW_EGRESS

for IPT in iptables ip6tables; do
  command -v "$IPT" >/dev/null 2>&1 || continue
  "$IPT" -N "$CHAIN" 2>/dev/null || "$IPT" -F "$CHAIN"
  "$IPT" -C OUTPUT -m owner --uid-owner "$RANGE" -j "$CHAIN" 2>/dev/null || "$IPT" -I OUTPUT 1 -m owner --uid-owner "$RANGE" -j "$CHAIN"
  # Replies on connections the gateway opened to a console (its loopback port) are allowed.
  "$IPT" -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
done

# IPv4: the model endpoint and DNS on loopback; nothing else on this machine or a private network.
iptables -A "$CHAIN" -d 127.0.0.1 -p tcp --dport "$MODEL_PORT" -j RETURN
iptables -A "$CHAIN" -d 127.0.0.0/8 -p udp --dport 53 -j RETURN
iptables -A "$CHAIN" -d 127.0.0.0/8 -p tcp --dport 53 -j RETURN
for NET in 127.0.0.0/8 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do
  iptables -A "$CHAIN" -d "$NET" -j REJECT
done
# The resolvers this machine uses (often on a private address: cloud VPC DNS, Docker's 127.0.0.11)
# stay reachable, for DNS only. AIW_DNS_SERVER adds one.
for NS in ${AIW_DNS_SERVER:-} $(awk '/^nameserver [0-9.]+$/ { print $2 }' /etc/resolv.conf 2>/dev/null); do
  iptables -I "$CHAIN" 2 -d "$NS" -p udp --dport 53 -j RETURN
  iptables -I "$CHAIN" 2 -d "$NS" -p tcp --dport 53 -j RETURN
done
if command -v ip6tables >/dev/null 2>&1; then
  for NET in ::1/128 fc00::/7 fe80::/10 ::ffff:0:0/96; do ip6tables -A "$CHAIN" -d "$NET" -j REJECT; done
fi
echo "egress firewall installed for uids $RANGE"
