import type { Bot } from './types.js';

/** A model/effort pair selected for a single turn. Both optional (a bot may pin
 *  neither, one, or both). */
export interface RuntimeTier {
  model?: string;
  effort?: string;
}

/**
 * Resolves the model/effort a turn should run at, given the bot's base tier and
 * its (optional) escalation config, by matching the user's raw text on two
 * INDEPENDENT axes that compose: a model trigger bumps the model, an effort
 * trigger bumps the effort, and a message hitting both reaches the top (e.g.
 * "opus" + "deep" → Opus xhigh). Matching is a case-insensitive substring test.
 *
 * STICKY: an escalation carries forward. `sticky` is the tier this conversation
 * last resolved to (persisted in session-map); a triggerless message keeps it
 * rather than snapping back to the base. Per axis the precedence is:
 *   1. a de-escalation (reset) trigger → back to the base value (an explicit
 *      "go back" beats an escalate word in the same message);
 *   2. otherwise an escalate trigger → the escalated value;
 *   3. otherwise the sticky value carried from last turn (or the base if none).
 * No config leaves every axis at the base.
 */
export function resolveModelTier(
  base: RuntimeTier,
  esc: Bot['modelEscalation'],
  text: string,
  sticky: RuntimeTier = {},
): RuntimeTier {
  if (!esc) return base;
  const haystack = text.toLowerCase();
  const hits = (triggers: string[] | undefined) =>
    !!triggers && triggers.some((t) => haystack.includes(t.toLowerCase()));
  const axis = (
    escTriggers: string[],
    escalated: string,
    resetTriggers: string[] | undefined,
    baseVal: string | undefined,
    stickyVal: string | undefined,
  ) => {
    if (hits(resetTriggers)) return baseVal; // explicit de-escalation → base
    if (hits(escTriggers)) return escalated; // escalation trigger → escalated
    return stickyVal ?? baseVal; // carry the sticky tier forward, else base
  };
  return {
    model: axis(esc.modelTriggers, esc.escalatedModel, esc.modelResetTriggers, base.model, sticky.model),
    effort: axis(esc.effortTriggers, esc.escalatedEffort, esc.effortResetTriggers, base.effort, sticky.effort),
  };
}
