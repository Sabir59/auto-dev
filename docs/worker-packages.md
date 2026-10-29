# Worker packages: cloning and sharing (2026-10-25)

A worker can be copied on this console (**Clone**) or given to someone else as a file (**Export**, then **Import** on their console). Both use the same `.workerpack` format and the same checks (`worker-ui/workerpack.mjs`).

## Using it
- **Clone…** (in a worker's editor) makes a new, independent worker on this console:
  - a new id and version 1;
  - a copy of its **learnings** (what it kept from its work with `LEARNED:` lines; formerly "memory"), each marked with the worker it came from, and no conversations (since 2026-10-29: before, a clone started with none);
  - the same definition, steps, knowledge and tools.

  A Git workflow worker's rules are copied, and you choose its repository. Repository access isn't copied.
- **Export…** (in a worker's editor) previews before you download:
  - what goes in the package and what stays here;
  - what the worker will need on the other console;
  - paths that will be replaced, or the text that stops the export.

  Downloading gives `<name>.workerpack`.
- **Import worker** (sidebar, under New worker): choose the file. The review shows:
  - its identity, steps, limits and knowledge;
  - its tools, as this console would give them in the chosen workspace;
  - its accounts and access, checked on this console now, each with where to set it up (Figma, GitHub);
  - the repositories it would need (you grant access to your own registered ones, or none);
  - its Git workflow rules and which repository to use;
  - anything this console doesn't support;
  - the name, if it's taken here.

  **Install worker** creates a new worker. If required access is still missing, it asks first. The worker asks for that access when a task needs it.

## The package (formats 1 and 2)
Format 2 (2026-10-25) is for workers with pinned integrations. `worker.json` (schema 2) carries:
- its integrations as `{ id, version, config }`, without settings a manifest marks secret;
- its explicit core capabilities, its own text and `extraRequirements`.

`dependencies.json` lists each integration's id, version, label and status.

On import, each reference resolves against the receiving console's catalogue:
- **exact:** that version is here, and it's pinned as it is;
- **another version:** of the same major, with its settings carried over. Installed only with the person's consent;
- **missing or unknown:** left out, only with consent.

The import page lists each one. Format 1 is still read and written, for workers made before integrations, and installs in that form (it can then be migrated).

### Format 1
A ZIP archive holding exactly these files. Anything else makes the package invalid.

| File | What it holds |
|---|---|
| `manifest.json` | `format: "ai-workforce.workerpack"`, `formatVersion: 1`, a package id, when and what made it, and a `sha256` and size for every other file |
| `worker.json` | Schema 1: name, specialization, mission, tools (capability ids), workflow steps, hard limits, the on-missing text, requirements (resource, access, need), and the request it was made from (description, integrations, starter tasks, workspace kind) |
| `dependencies.json` | What it needs where it's installed: tools, accounts and access, repositories (full name and level, never a grant), workflows |
| `knowledge/knowledge.md` | Its knowledge |
| `workflows/gitflow.json` | Optional, for a Git workflow worker: teams and their branch patterns, branch relationships, exclusion rules, shared and off-limits branches, ticket patterns |

**Never in a package:**
- credentials, tokens, cookies or connected accounts;
- learnings, conversations, run history, logs and checkpoints (a package goes to another person; learnings can hold details of one person's or customer's work, so only a clone on this console copies them);
- the worker's id, version history and dates;
- Team membership;
- repository grants;
- Git workflow people, emails and overrides, the repository location, audit trail, plans and notes;
- paths on the source computer.

**What happens to sensitive text on export:**
- **Text that looks like a credential stops the export.** The preview names the field; remove it from the worker.
- **Paths on this computer** (user folders, drive paths, UNC shares) are replaced with `<path on the source computer>`, and the preview lists them.
- **A local clone keeps its own paths,** because they're valid on the same computer.

## Checks when a package is read (untrusted input)
- **The archive, before any file is parsed:**
  - at most 2 MB packed, 512 KB per file, 2 MB unpacked, 16 entries;
  - a compression ratio of at most 200;
  - stored or deflate only; no encryption, ZIP64, links, duplicate names or multi-part archives;
  - every name a relative path of plain parts (no `..`, absolute or drive paths, backslashes or odd characters);
  - the CRC of every file.
- **The contents:**
  - only the files above;
  - the manifest format and version (newer formats are refused with "update this console"; formats 1 and 2 are read, and the worker schema must match its format);
  - every file's sha256 and size, matching the manifest, and nothing unlisted;
  - the worker schema;
  - `dependencies.json` agreeing with the worker's tools.
- **Nothing in a package runs.** Its text is shown for review, and text that looks like a credential, or a path from another computer, is flagged.

## What the installing console decides
- **Tools** must be in this console's catalogue. Anything else is installed only if you agree to leave it out.
- **What the worker actually gets** follows the usual rules in each run: workspace mode, platform, Team scope and policies.
- **Requirements** are checked against this console's own accounts.
- **Repository access** is only granted:
  - to a repository registered here;
  - at most at the level the package asked for;
  - when you choose it.
- **Git workflow settings** come from the package's rules plus your repository. People and overrides start empty, and proposal branches are off.
- **An existing worker is never replaced.** A taken name is refused, and a free one is suggested.
- **A checked package is held for 30 minutes,** and can be installed once.
- **Where an installed worker came from** is recorded as `origin` (clone or package, with the package id).

## Tests
`node bench/workspace-ui/workerpack-test.mjs` covers three areas:
- **The format:**
  - round trips;
  - what's never in a package;
  - unsafe, malformed, tampered, oversized and incompatible packages.
- **Two separate consoles,** each with its own data folder, port and fixture repository:
  - export and clone on one;
  - import on the other, covering name clashes, missing dependencies, unsupported tools and refused packages;
  - a round trip back.
- **The page flow** on both consoles.

## Limits
- **One console version tested.** Packages were tested between two independent consoles on one computer (separate data, ports and repositories), not between two computers or two different versions of the console. The checks don't depend on the computer.
- **Hosted product not tested.** The import flow there hasn't been run end to end.
- **Format 1 isn't converted on import.** It installs as a worker made before integrations, and is then migrated from "Review older workers" like any other.
- **File-based sharing only.** There's no marketplace and no share links; you send the file yourself.
- **Knowledge is text.** Workers here keep their knowledge as text, so there are no other files to package. Teams' uploaded knowledge files aren't part of a worker.
