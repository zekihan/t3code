export interface IdentityPromptDeps {
  /** Resolves once the app is in the foreground; the KeyChain picker needs an Activity. */
  readonly foreground: () => Promise<void>;
  /** Resolves true when the person agrees to choose a certificate. */
  readonly confirm: (origin: string, reason: string) => Promise<boolean>;
  readonly choose: (origin: string) => Promise<unknown>;
  readonly now?: () => number;
  /** How long a dismissed or failed prompt stays quiet for the same origin. */
  readonly cooldownMs?: number;
}

/**
 * Asks for the identity again when a stored alias stops working (renewed or removed certificate).
 * Every reconnect attempt reports the problem, so prompts are deduplicated per origin.
 */
export function createIdentityPrompt(deps: IdentityPromptDeps) {
  const now = deps.now ?? Date.now;
  const cooldownMs = deps.cooldownMs ?? 5 * 60_000;
  const active = new Set<string>();
  const quietUntil = new Map<string, number>();
  return async (problem: { readonly origin: string; readonly reason: string }) => {
    const { origin, reason } = problem;
    if (active.has(origin) || now() < (quietUntil.get(origin) ?? 0)) return;
    active.add(origin);
    let chosen = false;
    try {
      await deps.foreground();
      if (await deps.confirm(origin, reason)) {
        chosen = (await deps.choose(origin)) !== null;
      }
    } catch {
      chosen = false;
    } finally {
      active.delete(origin);
      if (chosen) quietUntil.delete(origin);
      else quietUntil.set(origin, now() + cooldownMs);
    }
  };
}
