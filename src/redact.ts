/**
 * PII detection + masking for sensitive bots (e.g. 상담).
 *
 * Two layers, and it MUST NEVER throw (a redaction failure must not break a turn):
 *  1. Regex (always runs): masks email / phone / 주민번호 / card / account. Fast,
 *     local, deterministic — the guaranteed baseline. No dependencies.
 *  2. Local Ollama (ONLY when OLLAMA_HOST is set): EXTRACTS extra PII spans the regex
 *     can't catch (names, addresses) and we mask them in code. The model only spots
 *     substrings — it never rewrites the body — so a small model (qwen2.5:3b) can't
 *     corrupt the text. Any Ollama problem just leaves the regex result intact.
 *
 * The function returns the MASKED copy + a hit count; it never mutates in place.
 * Callers decide whether to apply the masked copy — see the `redactScope` semantics
 * where the bridge invokes this.
 */

/** Result of a redaction pass: the (possibly) masked text + how many items were masked. */
export interface RedactResult {
  /** Text with PII replaced by `[REDACTED:type]` placeholders (or the original if none). */
  text: string;
  /** Number of PII items masked. */
  hits: number;
}

/**
 * Ordered regex rules. Order matters: more specific / distinctive patterns run
 * first so a substring already replaced by an earlier rule can't be re-matched by
 * a looser later one (e.g. a mobile number is consumed before the generic account
 * rule could grab it). Each rule may carry a `guard` to suppress false positives.
 */
interface RedactRule {
  type: string;
  re: RegExp;
  /** Optional extra check on a candidate match; return false to leave it untouched. */
  guard?: (match: string) => boolean;
}

/** Count of digits in a string (used to keep dates out of the account rule). */
function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

const RULES: readonly RedactRule[] = [
  // GitHub token: classic gh[pousr]_… (20+ base62) or fine-grained github_pat_… .
  // First so a token can't be partially consumed by a looser later rule. Defense in
  // depth — tokens flow via env, not text, but must never leak into logs.
  { type: 'gh-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  // 주민등록번호 (KR resident registration number): 6 digits + a 7th in 1-4 + 6 digits.
  { type: 'rrn', re: /\b\d{6}[-\s]?[1-4]\d{6}\b/g },
  // Card: four 4-digit groups.
  { type: 'card', re: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g },
  // KR mobile: 010/011/016/017/018/019 + 3~4 + 4.
  { type: 'phone', re: /\b01[016-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g },
  // Bank account: hyphenated digit groups, but only when there are ≥10 digits, so
  // dates like 2024-01-15 (8 digits) are NOT masked (avoid over-masking).
  {
    type: 'account',
    re: /\b\d{2,6}-\d{2,6}-\d{2,6}(?:-\d{2,6})?\b/g,
    guard: (m) => digitCount(m) >= 10,
  },
  // Email.
  { type: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/**
 * Pure, synchronous regex masking. Exported so it can be unit-tested directly and
 * reused as the guaranteed fallback. Never throws.
 */
export function regexRedactPII(text: string): RedactResult {
  if (!text) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const rule of RULES) {
    out = out.replace(rule.re, (match) => {
      if (rule.guard && !rule.guard(match)) return match;
      hits += 1;
      return `[REDACTED:${rule.type}]`;
    });
  }
  return { text: out, hits };
}

/** One PII span the model claims appears verbatim in the text. */
interface PiiSpan {
  value: string;
  type: string;
}

/**
 * The model EXTRACTS PII spans; it does NOT rewrite the text. A 3B model asked to
 * rewrite the whole body corrupts it (echoes the placeholder literally, drops chars).
 * Extraction + masking-in-code is robust: the model only has to spot substrings, and
 * we do the replacement ourselves so the rest of the text is byte-for-byte preserved.
 */
const EXTRACT_PROMPT = [
  'List every piece of personally identifiable information (PII) belonging to a specific person',
  'that appears VERBATIM in the text inside <text></text>. For each, give the exact substring as',
  '"value" and a "type" from: name, email, phone, rrn, card, account, address. Include Korean personal',
  'names. Do NOT include brand/product/company names, financial instrument or account-type names',
  '(e.g. 나스닥100, ETF, ISA, S&P500), dates, amounts, or percentages. Do not invent values not present.',
].join(' ');

/** Canonical PII types we accept from the model (anything else, e.g. "date", is dropped). */
const CANON_TYPES = new Set(['name', 'email', 'phone', 'rrn', 'card', 'account', 'address']);

/**
 * Drops a model-extracted span that's likely a false positive (the small model
 * over-tags brands/instruments/dates as PII): non-canonical types, number-types
 * (phone/rrn/card/account) without a digit (e.g. "ISA 계좌"), names containing a
 * digit (e.g. "나스닥100"), or "emails" without an @.
 */
export function isPlausibleSpan(value: string, type: string): boolean {
  if (value.length < 2 || value.includes('[REDACTED:')) return false;
  if (!CANON_TYPES.has(type)) return false;
  if ((type === 'phone' || type === 'rrn' || type === 'card' || type === 'account') && !/\d/.test(value)) return false;
  if (type === 'name' && /\d/.test(value)) return false;
  if (type === 'email' && !value.includes('@')) return false;
  return true;
}

/** Ollama structured-output schema forcing the {pii:[{value,type}]} shape. */
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    pii: {
      type: 'array',
      items: {
        type: 'object',
        properties: { value: { type: 'string' }, type: { type: 'string' } },
        required: ['value', 'type'],
      },
    },
  },
  required: ['pii'],
};

/** Normalizes a model-supplied type to a short `[REDACTED:<type>]` tag. */
function safeType(type: unknown): string {
  const t = String(type ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  return t || 'pii';
}

/**
 * Asks local Ollama to EXTRACT PII spans (names/addresses the regex can't catch).
 * Returns the spans, or null on any problem (so the caller just keeps the regex result).
 * Entirely OPT-IN: with no OLLAMA_HOST set this returns null immediately and redaction
 * is regex-only (no external dependency).
 */
async function tryOllamaExtract(text: string): Promise<PiiSpan[] | null> {
  const host = process.env.OLLAMA_HOST;
  if (!host) return null;
  // qwen2.5:3b: small + fast + multilingual (good Korean name/address recall).
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:3b';
  const controller = new AbortController();
  // Generous: cold model load + extraction. The 'log' scope runs this off the reply
  // path (non-blocking), so latency is hidden.
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${host.replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: '5m', // keep the model warm between turns
        options: { temperature: 0 },
        format: EXTRACT_SCHEMA,
        prompt: `${EXTRACT_PROMPT}\n\n<text>\n${text}\n</text>`,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    if (!data.response) return null;
    const parsed = JSON.parse(data.response) as { pii?: unknown };
    if (!Array.isArray(parsed.pii)) return null;
    return parsed.pii
      .filter((p): p is PiiSpan => !!p && typeof (p as PiiSpan).value === 'string')
      .map((p) => ({ value: p.value, type: safeType(p.type) }));
  } catch {
    // Ollama unreachable / aborted / bad JSON — keep the regex result.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Masks PII in `text`. The regex masker ALWAYS runs (email/phone/주민번호/card/account);
 * if local Ollama is configured it ADDITIONALLY masks the spans it extracts (names,
 * addresses, …) on top — applied in code, never letting the model rewrite the body.
 * NEVER throws and NEVER mutates the input.
 */
export async function redactPII(text: string): Promise<RedactResult> {
  if (!text) return { text, hits: 0 };
  const base = regexRedactPII(text);
  const spans = await tryOllamaExtract(text).catch(() => null);
  if (!spans || !spans.length) return base;

  let out = base.text;
  let hits = base.hits;
  for (const { value, type } of spans.slice(0, 64)) {
    // Drop the small model's false positives (brands/instruments/dates), and skip
    // anything regex already masked (its original substring is gone from `out`).
    if (!isPlausibleSpan(value, type)) continue;
    if (out.includes(value)) {
      out = out.split(value).join(`[REDACTED:${type}]`);
      hits += 1;
    }
  }
  return { text: out, hits };
}
