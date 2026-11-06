# Encryption at rest: threat model and options (design, 2026-11-04)

Status: **design for review. Nothing here is implemented except application-level encryption of provider credentials.** The owner approved the direction (application-level encryption + LUKS) but asked that LUKS wait until recovery and key management are final. For the pilot the priorities are application-level encryption, filesystem isolation and encrypted off-server backups.

## 1. What's on disk

| Data | Where | Sensitivity | Protected today by |
|---|---|---|---|
| Each person's AI provider credential | `/data/control/credentials/<id>.json` | High (spends their money) | AES-256-GCM under `AIW_SECRETS_KEY`, root-only folder |
| Accounts (scrypt hashes), sessions (sha256 of tokens) | `/data/control/` | Medium | Root-only folder; hashes, not secrets |
| Each person's GitHub, Figma and Builder credentials | `/data/users/<id>/github`, `/figma`, `/builder` | High | AES-256-GCM under the person's own key (HKDF of `AIW_SECRETS_KEY` and their id, `worker-ui/secret-file.mjs`), mode 600 in a mode-700 folder of their own uid. The key is given only to their console, in memory, and to their own live runs' Figma and Builder tool servers on request; it's never on the volume |
| Runs, workspaces, worker definitions, Teams | `/data/users/<id>/data` | Business data (customer code, documents) | Mode 700, the person's own uid. **Plaintext** |
| Claude Code sessions (and, later, a subscription login the CLI writes itself) | `/data/users/<id>/claude` | High (later) | Mode 700, own uid. **Plaintext**; the platform must not encrypt or touch a login the CLI manages |
| `AIW_SECRETS_KEY`, the GitHub App secret | `/etc/ai-worker.env` (boot disk) | Critical | Root, mode 600 |

## 2. Threats

| # | Threat | Example |
|---|---|---|
| T1 | A copy of the **data volume alone** leaves our control | volume snapshot shared by mistake, provider-side disk disposal, a leaked backup of `/data` |
| T2 | A copy of the **boot disk alone** leaves our control | a server image or snapshot |
| T3 | Copies of **both** disks, offline | a full-server snapshot plus a volume snapshot; an attacker with access to the Hetzner account |
| T4 | **Root on the running server** | a gateway or kernel exploit, a stolen SSH key |
| T5 | One person reading another's data | a worker escaping its tools |
| T6 | **Loss**: disk failure, deleted server, corrupted volume, lost key | operations |

Encryption at rest addresses T1–T3 only. **Nothing at rest protects against T4**: a running server holds every key in memory. T4 is covered by isolation (per-person uids, no capabilities, egress firewall, file guard), least privilege, patching and fast revocation (people can replace their own provider key). T5 is covered by the same isolation, tested in `hosted-test.mjs`. T6 is covered by backups and key escrow, and is where a careless encryption design does harm.

## 3. Options

| Option | How it unlocks after a reboot | T1 | T2 | T3 | Recovery without a person | New single points of failure |
|---|---|---|---|---|---|---|
| **A. Application-level only** (built for provider credentials) | Key in the env file | Credentials yes; other data no | Credentials yes (no ciphertext on the boot disk) | No | Yes | None |
| **B. LUKS, key file on the boot disk** | `crypttab` reads the key file | Yes | Yes | **No** | Yes | Losing the boot disk loses the key → escrow copy needed |
| **C. LUKS, passphrase typed at boot** | A person, via the Hetzner console | Yes | Yes | Yes | **No**: every reboot waits for a person | That person |
| **D. LUKS + network-bound unlock (Clevis/Tang)** | A key server elsewhere answers at boot; 2 Tang servers via Shamir (`sss`), plus a passphrase slot for break-glass | Yes | Yes | Yes, unless the Tang servers are also taken | Yes, while one Tang server is reachable | Tang availability (mitigated: 2 servers + passphrase slot) |
| **E. LUKS + key from a managed KMS/vault** | A boot service authenticates and fetches the key | Yes | Yes | Yes, unless the vault credential is on the boot disk (then as B) | Yes | The vault service |
| **F. TPM-sealed key** | — | — | — | — | — | Not available: Hetzner Cloud has no vTPM |

**The limitation the owner raised (option B):** the key file and the encrypted volume are both under the same Hetzner account. Anyone who obtains both, through account compromise or a full set of snapshots (T3), can decrypt. B still covers the common cases (T1, T2), but it isn't protection against our own account being compromised.

## 4. Recommendation

**Pilot (now):**
1. **Application-level encryption** for every credential the platform itself stores: provider keys and GitHub, Figma and Builder credentials (done, 2026-11-04). Not the CLI's own files. Reviewed, and holding no third-party credential: worker definitions (no integration declares secret settings), the browser (no persistent profile), accounts and sessions (hashes only), and the GitHub App secret (the gateway's environment).
2. **Filesystem isolation** as it is: per-person uid, mode 700, root-only control folder (verified by `image-test.sh` and `hosted-test.mjs`).
3. **Encrypted off-server backups:** restic to a separate provider or a Hetzner Storage Box, daily, with a restore test. The repository password is held on the server (backups must run unattended) **and** offline. The backup target is **append-only** for the server's credential, so a compromised server can't delete or rewrite history.
   - `AIW_SECRETS_KEY` is **not** in the backup: it lives in `/etc` and is escrowed offline.
   - So a stolen backup holds credentials it can't decrypt.
4. **Key escrow:** `AIW_SECRETS_KEY` and the restic password, both in the owner's password manager. This is the break-glass copy.
5. **Hetzner account hardening:** 2FA, and API tokens limited and rotated. This is the main T3 control while LUKS isn't in place.

**Later (before data beyond a pilot):** option **D**, with two Tang servers in different locations, a passphrase key slot escrowed offline, and Docker gated on the mount (`RequiresMountsFor`) so a failed unlock leaves the platform down rather than running on an empty `/data`. Fall back to **B** only if D's extra servers aren't justified, and then document that T3 isn't covered.

## 5. Open items before LUKS
- Who holds the break-glass passphrase, and the procedure for using it.
- Where the two Tang servers run, and how they're monitored.
- The moved storage: a Hetzner Volume mounted for `/data`, which changes the compose file's named volume to a bind mount. It needs a migration step and a test of restoring from backup onto a new server.
- **Rotating `AIW_SECRETS_KEY`:** not supported yet. Each stored credential records the key it was encrypted with. Rotation needs a re-encryption pass that accepts the previous key during the change.
