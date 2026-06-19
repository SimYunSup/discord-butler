import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Absolute path to the repo root. NOTE: this matches the BUNDLED layout — the
 * whole app is bundled into `dist/index.mjs`, so at runtime `import.meta.url`
 * points at `dist/`, one level under the repo root (same convention as
 * config.ts and bridge.ts). Do not change to "two levels up" based on the src/
 * source layout; the bundler flattens it.
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ (bundled) -> repo root
  return resolve(here, '..');
}

/** Resolves a skill path: absolute paths as-is, others against the repo root. */
export function resolveSkillPath(p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot(), p);
}

/**
 * `.skill` files are ZIP archives (e.g. `linkedin-tech-curator.skill` contains
 * `linkedin-tech-curator/SKILL.md`). This extracts the FIRST entry whose name
 * ends in `SKILL.md` (case-insensitive) from a single- or multi-entry ZIP, using
 * only Node's built-in zlib — no runtime dependency.
 *
 * We parse local file headers sequentially (the format Claude's skill packager
 * emits): each entry begins with the local-file-header signature 0x04034b50,
 * followed by fixed fields, then the file name, optional extra field, then the
 * (possibly compressed) data. Method 0 = stored, method 8 = raw DEFLATE.
 *
 * Returns the decoded UTF-8 text, or undefined if no SKILL.md entry is found.
 */
function extractSkillMdFromZip(buf: Buffer): string | undefined {
  const LOCAL_SIG = 0x04034b50;
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== LOCAL_SIG) break; // reached central directory / not a local header
    const method = buf.readUInt16LE(off + 8);
    // bit 3 (data descriptor) would put sizes after the data; the packager does
    // not set it, so we rely on the header's compressed size.
    const flags = buf.readUInt16LE(off + 6);
    const compressedSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const nameStart = off + 30;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;

    if ((flags & 0x08) !== 0 || compressedSize === 0) {
      // Streaming/data-descriptor mode (size only known after data): we cannot
      // safely walk past this entry. Give up rather than risk garbage.
      return undefined;
    }
    const data = buf.subarray(dataStart, dataStart + compressedSize);

    if (name.toLowerCase().endsWith('skill.md')) {
      if (method === 0) return data.toString('utf8'); // stored
      if (method === 8) return inflateRawSync(data).toString('utf8'); // DEFLATE
      return undefined; // unsupported compression
    }
    off = dataStart + compressedSize;
  }
  return undefined;
}

/** Whether a buffer starts with the ZIP local-file-header magic (`PK\x03\x04`). */
function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

/**
 * Reads one skill file's injectable content. Plain `.md` files are returned
 * verbatim; `.skill` (and any) ZIP archives have their inner `SKILL.md`
 * extracted. Returns undefined (with a console warning) if the file can't be
 * read or a ZIP has no SKILL.md — so a missing skill never breaks provisioning.
 *
 * @param skillPath absolute or repo-relative path to the skill file
 */
export async function readSkillContent(skillPath: string): Promise<string | undefined> {
  const abs = resolveSkillPath(skillPath);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (err) {
    console.warn(`[skills] could not read skill file ${abs}:`, err);
    return undefined;
  }
  if (looksLikeZip(buf)) {
    const inner = extractSkillMdFromZip(buf);
    if (!inner) {
      console.warn(`[skills] ${abs} is a ZIP but no SKILL.md entry was extracted.`);
    }
    return inner;
  }
  return buf.toString('utf8');
}
