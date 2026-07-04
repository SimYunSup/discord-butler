---
name: sereview
description: Review a GitHub pull request line-by-line using a deterministic sereview packet (no API key). Use when asked to review a PR, code-review a pull request, or run a review on a PR URL / owner/repo#number / a local diff.
---

# Reviewing a pull request with sereview

**You are the reviewer.** The `sereview` CLI is deterministic and never calls a
model — it only parses the diff, bundles the changed files, and pre-matches a
rulebook so you look in the right places. Doing the actual review (reading code,
judging findings, writing comments) is your job, on the Claude Code session you
already run. No separate API key is involved.

## Procedure

1. **Build the packet.** Run the CLI and capture its stdout (JSON):
   - PR: `npx sereview packet <pr-url | owner/repo#number>`
   - Local diff: `git diff <base>... | npx sereview packet --diff -`
   - Large PRs: tune `--max-bundle-tokens <n>` (default 8000).
2. **Get context to read.** If the PR's repo is checked out locally at the PR head,
   you can `Read`/`Grep` the surrounding code (definitions, callers, related
   files) — do that. If you only have the packet, review from its hunks; the hunk
   lines and headers tell you exactly what changed and where.
3. **Review bundle by bundle.** For each bundle:
   - Read its `matchedRules`. These are **hints**, not verdicts — a match means
     "look here for this class of bug," nothing more. An empty `matchedRules` does
     not mean the bundle is clean; still read the hunks.
   - Walk each file's hunks. For anything suspicious, gather just enough context
     with `Read`/`Grep` to decide. Don't re-read the whole repo — the packet is
     already the pre-filtered surface; stay within it plus the context a finding
     needs.
4. **Anchor findings.** Every finding points at a **new-file line number** taken
   from an added/`context` line in the hunk (`newLine`). Never invent line numbers.
5. **Return a `ReviewResult`** in the shape below.

## Review discipline

- **Changed lines only.** Comment on added/modified lines, not pre-existing code
  the PR didn't touch (unless the change makes existing code newly wrong).
- **Justify every finding:** what's wrong, the impact, and how it triggers /
  reproduces. A finding without a concrete failure path is an `info` question.
- **No speculation.** If you can't substantiate it, drop it or file it as `info`
  phrased as a question. Don't pad the review.
- **No style nitpicks** unless a matched rule explicitly covers it. Formatting,
  naming taste, and preferences are out of scope.
- **Deduplicate.** Same root cause across several lines → one finding that lists
  the locations.
- **Honest severity.** Don't inflate to look thorough or deflate to look lenient.

## Severity

- **critical** — exploitable vulnerability, data loss/corruption, or a crash on a
  normal path.
- **high** — a bug on common input, or an authorization hole.
- **medium** — edge-case bug, race, resource leak.
- **low** — minor / unlikely impact.
- **info** — a question or suggestion; nothing proven wrong.

## Rulebook (security-leaning starter set)

`sql-injection` · `xss` · `ssrf` · `path-traversal` · `secret-exposure` ·
`authz` · `npe` · `race` · `n-plus-1`. Each carries `guidance` in the packet
describing what to check. Findings are not limited to these — they focus
attention, they don't cap it.

## Output: `ReviewResult`

Return JSON of this shape (also in `sereview`'s type exports):

```jsonc
{
  "schemaVersion": 1,
  "source": { /* copied from the packet's source */ },
  "findings": [
    {
      "bundleId": "bundle-1",
      "file": "src/db.ts",
      "line": 12,                 // NEW-file line the comment anchors to
      "endLine": 14,              // optional range end
      "severity": "high",
      "category": "security",
      "ruleId": "sql-injection",  // optional; set when a rulebook rule applies
      "title": "User id concatenated into SQL",
      "body": "Why it's wrong, the impact, and how it triggers.",
      "suggestion": "Use a parameterized query: db.query('… WHERE id = $1', [userId])."
    }
  ],
  "summary": "One paragraph: what changed and the headline risks.",
  "countsBySeverity": { "critical": 0, "high": 1, "medium": 0, "low": 0, "info": 0 }
}
```

When you find nothing, return `findings: []` and a `summary` stating **what you
checked** (files/bundles reviewed and the classes of issue you looked for), so the
empty result is trustworthy rather than ambiguous.

For a human-facing reply (e.g. in chat), group findings by severity, lead with the
counts, and keep each finding to its anchor + why + fix.

## Posting comments back to the PR

Out of scope for the MVP, and **never automatic**. Do not post review comments to
the PR on your own. Only if the user explicitly asks may you post them, and only
after you confirm with them first. (When embedding sereview in a chat/bot, route
the actual post through that surface's own human-approval gate.)
