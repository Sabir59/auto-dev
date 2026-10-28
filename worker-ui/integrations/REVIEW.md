# Integration manifests: ownership, review and release

Each folder here is one integration, and each file in it is one released version (`<id>/<semver>.json`).

`core.json` is the core capability catalogue: general-purpose tools that are never granted by default.

`manifest.schema.json` and `core.schema.json` are the formal schemas. The console checks every manifest against them when it starts, and refuses to start if one fails.

## Ownership
- **Every manifest names an owner.** `owner.team` maintains it, and `owner.accountable` is the person who answers for it. The same applies to `core.json`.
- **Every manifest names its tests (`tests`).** Those files must exist, and the console checks they do.

## Review
- **What needs review:** every change to a manifest, and every new version.
- **Review levels:**
  - **`platform`:** a reviewer from the owning team other than the author.
  - **`security`:** two reviewers, one outside the owning team. Use it when a change can widen access:
    - a capability added to `capabilities`, `base.enables` or a choice's `enables`;
    - a core tool added (`core`);
    - an account requirement removed;
    - `status` raised to `tested`.

  The `review` field in a manifest is the *minimum*. A change that widens access always needs `security`, whatever the manifest says.
- **Before releasing, the reviewer checks:**
  - the named tests pass;
  - `node bench/integrations/catalog-test.mjs` passes;
  - for a new version, the upgrade diff the console shows (`changes` describes it in words).

## Releasing
```text
node worker-ui/integrations/release.mjs <id>@<version>
```
This records the version's sha256 in `releases.lock.json`. From then on the version is **immutable**:
- if its file changes, the console refuses to start;
- released versions are never deleted, because workers pin them exactly.

To change an integration, add a new version file. Workers move to it only through the upgrade flow, after their owner reviews the diff. A permission expansion needs explicit approval there too.

`node worker-ui/integrations/release.mjs --check` lists unreleased and changed versions. An unreleased version loads only with `AIW_INTEGRATIONS_DEV=1`, in development and tests.

## Versions
Versions use semver:
- **Patch:** wording and instructions; no change to capabilities, accounts or configuration.
- **Minor:** new optional configuration or capabilities behind a choice. Existing configurations stay valid.
- **Major:** anything that makes an existing configuration invalid or changes what a choice grants.
