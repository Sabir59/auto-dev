// The model provider: how the worker runtime (the Claude Code CLI the console spawns) is
// authenticated, chosen explicitly. The Worker, Team and Workspace logic never sees which one is in
// use; it only adds runtimeEnv() to each worker's environment.
//
//   claude-subscription  the CLI's own sign-in in its config dir (the owner's claude.ai plan).
//                        Local development only: Anthropic doesn't allow a claude.ai login to back a
//                        product offered to others (docs/HOSTED_RUNTIME_AUDIT.md §2), so a hosted
//                        console refuses it.
//   anthropic-api        an Anthropic API key (ANTHROPIC_API_KEY) on this computer, for a developer
//                        running the console locally with their own key. The key is in the worker's
//                        environment, so this is never used hosted.
//   anthropic-gateway    hosted: the control plane (gateway.mjs) holds the API key. Workers get the
//                        gateway's address and a per-console token (ANTHROPIC_BASE_URL +
//                        ANTHROPIC_AUTH_TOKEN, Claude Code's documented LLM-gateway variables); the
//                        key never reaches a console, a worker, the page or a log.
//
// MODEL_PROVIDER picks one; unset means claude-subscription locally and anthropic-gateway hosted.
// There is no fallback: a provider whose configuration is missing makes the console refuse to start.
export const PROVIDERS = {
  "claude-subscription": { label: "Claude Code sign-in on this computer (local development)", hosted: false },
  "anthropic-api": { label: "Anthropic API key on this computer (local development)", hosted: false },
  "anthropic-gateway": { label: "Anthropic API through the platform's model gateway", hosted: true },
};

export class ProviderConfigError extends Error {}

export function resolveProvider(env = process.env, { hosted = false } = {}) {
  const id = env.MODEL_PROVIDER || (hosted ? "anthropic-gateway" : "claude-subscription");
  const p = PROVIDERS[id];
  if (!p) throw new ProviderConfigError(`MODEL_PROVIDER "${id}" is unknown. Use one of: ${Object.keys(PROVIDERS).join(", ")}.`);
  if (hosted && !p.hosted) throw new ProviderConfigError(`MODEL_PROVIDER "${id}" can't be used by a hosted console: ${id === "claude-subscription" ? "a claude.ai sign-in may not back a hosted product" : "the API key would be in every worker's environment"}. Use anthropic-gateway.`);
  if (!hosted && p.hosted) throw new ProviderConfigError(`MODEL_PROVIDER "${id}" is only for consoles started by the hosted gateway.`);
  if (id === "anthropic-api" && !env.ANTHROPIC_API_KEY) throw new ProviderConfigError("MODEL_PROVIDER anthropic-api needs ANTHROPIC_API_KEY.");
  if (id === "anthropic-gateway") {
    let u; try { u = new URL(env.ANTHROPIC_BASE_URL || ""); } catch { throw new ProviderConfigError("MODEL_PROVIDER anthropic-gateway needs ANTHROPIC_BASE_URL (the gateway's model endpoint)."); }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) throw new ProviderConfigError("The model gateway must be on this machine's loopback address.");
    if (!/^[\w-]{32,}$/.test(env.ANTHROPIC_AUTH_TOKEN || "")) throw new ProviderConfigError("MODEL_PROVIDER anthropic-gateway needs the console's gateway token (ANTHROPIC_AUTH_TOKEN).");
  }
  return {
    id, ...p,
    // What each worker process gets, on top of the console's filtered environment. Claude Code
    // reads these itself; the console never logs them.
    runtimeEnv() {
      if (id === "claude-subscription") return {};
      if (id === "anthropic-api") return { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
      return {
        ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
        // No version checks, telemetry or release notes from a server: only model traffic, to the gateway.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      };
    },
    // Shown on the page: which provider, never a credential.
    summary() { return { id, label: p.label }; },
  };
}
