# Issue: tools that connect mid-task never become available; the user has to start a new task

**Reported by:** Sabir Nawaz (owner, Builder Page Engineer worker)
**Date:** 2026-10-25
**Severity:** High for usability. It breaks the flow on every task where a connection is opened late.

## What happened
1. A Builder Page Engineer task was started while the Figma desktop plugin was **not running**.
2. At startup the worker reported: "Not loaded in this run, because what they need wasn't available when it started: Read the open Figma file (plugin) … Plugin not running".
3. The REST link reader was available, but it failed twice with `Figma API error: terminated` on a large node (slow connection).
4. The user then **opened the plugin** in the file "MATW Local" and asked the worker to use it.
5. The worker searched its tools twice after that. The plugin tools never appeared, so the only option was "start a new task".
6. The user had to abandon the task and start again, losing context (API compatibility findings, open questions, plan). The worker saved notes to memory as a workaround.

## Why it's a problem
- The worker is general-purpose, not tied to one page type. Any task where a connection (Figma plugin, browser, Builder space…) becomes available after startup hits this.
- From the user's side it looks like a bug: they did what was asked (opened the plugin), and nothing changed.
- Restarting costs time and context, and pushes the worker to fill long-term memory with handoff notes for one task.

## Expected behaviour
When a required connection becomes available during a task, the worker should be able to use it in **the same task**, without a restart.

## Suggested fixes (any one helps; 1 or 2 preferred)
1. **Re-check access when a tool is needed:** if the worker looks for a tool that wasn't loaded (e.g. the Figma plugin), re-run the access check for that tool and load it if it's now available.
2. **"Reconnect / reload tools" action:** a worker tool or UI button that re-runs the startup requirement checks and adds newly available tools to the running task. The same scoping and permission rules still apply.
3. **Pre-start prompt:** before the task starts, if an optional connection is missing (plugin not running), show "Figma plugin isn't running: open it now or continue without it" and wait briefly. This avoids starting without it.
4. **At minimum:** if a restart really is unavoidable, carry the conversation and context into the new task automatically, so the user doesn't have to explain everything again.

## Environment
- Worker: Builder Page Engineer (Claude Code agent SDK)
- Tools at start: Builder (read and draft write, test space), browser-executor, figma-reader (REST). The Figma plugin tools weren't loaded.
- OS: Windows 11 Pro
