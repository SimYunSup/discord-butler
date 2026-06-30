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
 * No config (or no match on an axis) leaves that axis at the base.
 */
export function resolveModelTier(
  base: RuntimeTier,
  esc: Bot['modelEscalation'],
  text: string,
): RuntimeTier {
  if (!esc) return base;
  const haystack = text.toLowerCase();
  const hits = (triggers: string[]) => triggers.some((t) => haystack.includes(t.toLowerCase()));
  return {
    model: hits(esc.modelTriggers) ? esc.escalatedModel : base.model,
    effort: hits(esc.effortTriggers) ? esc.escalatedEffort : base.effort,
  };
}
