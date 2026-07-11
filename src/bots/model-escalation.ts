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
 * "opus" + "심층" → Opus xhigh). Matching is a case-insensitive substring test.
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

/**
 * Builds the REPL slash commands that switch a LIVE window from `active` to
 * `target`, emitting ONLY the commands whose value actually changes (so an
 * unchanged turn injects nothing). Used for mid-thread escalation: a kept-alive
 * window can't take launch flags (`--model`/`--effort`), and a task-memory bot
 * like research must NOT be torn down to relaunch (its in-RAM context, with no
 * memory.md, would be lost) — so we switch the running REPL in place instead.
 */
export function buildModelSwitchCommands(active: RuntimeTier, target: RuntimeTier): string[] {
  const cmds: string[] = [];
  if (target.model && target.model !== active.model) cmds.push(`/model ${target.model}`);
  if (target.effort && target.effort !== active.effort) cmds.push(`/effort ${target.effort}`);
  return cmds;
}

/** The trigger that fired on each axis for a turn — powers the user-facing "why did the
 *  tier change" banner markers (⬆️ escalate up, ⬇️ de-escalate down). Each field is the
 *  FIRST matching trigger string (same case-insensitive substring rule as
 *  {@link resolveModelTier}), or undefined when that axis had no match. NOTE: a field
 *  being set does NOT by itself mean the tier actually changed — a caller must still
 *  compare the resolved value against the base/escalated targets, since an axis whose
 *  escalated value equals the base is a no-op even on a match. */
export interface EscalationMatch {
  model?: string;
  effort?: string;
  /** First de-escalation (reset) word that fired on the model axis, if any. */
  modelReset?: string;
  /** First de-escalation (reset) word that fired on the effort axis, if any. */
  effortReset?: string;
}

export function matchedEscalationTriggers(esc: Bot['modelEscalation'], text: string): EscalationMatch {
  if (!esc) return {};
  const haystack = text.toLowerCase();
  const first = (triggers: string[] | undefined) =>
    triggers?.find((t) => haystack.includes(t.toLowerCase()));
  return {
    model: first(esc.modelTriggers),
    effort: first(esc.effortTriggers),
    modelReset: first(esc.modelResetTriggers),
    effortReset: first(esc.effortResetTriggers),
  };
}
