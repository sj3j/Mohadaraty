/**
 * Tiptap document JSON  <->  RichBlock[] (see src/types/announcement.types.ts).
 *
 * The editor speaks ProseMirror's nested node/mark JSON. Storage speaks flat
 * text plus offset ranges. This module is the only place that knows both, which
 * is what keeps the reader bundle free of any editor dependency.
 */

import type { MarkType, RichBlock, RichEntity } from '../types/announcement.types';

const MARKS: readonly MarkType[] = ['bold', 'italic', 'underline', 'strike', 'code', 'link'];

/**
 * Schemes a link mark may carry.
 *
 * Do not remove this in the belief that React escapes it. React renders
 * `href="javascript:..."` as written - it has never blocked the scheme, and the
 * dev-only warning that used to flag it was removed in React 18. A moderator is
 * trusted, but a moderator's account is not, and a pasted link is the cheapest
 * possible way in.
 */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

/** Returns a safe absolute URL, or null if the input cannot be trusted as one. */
export function safeUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // A bare "example.com/x" is what people actually type. Assume https rather
  // than letting it resolve as a relative path against the app's own origin.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    return SAFE_SCHEMES.includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

type PmMark = { type: string; attrs?: Record<string, any> };
type PmNode = { type: string; text?: string; marks?: PmMark[]; attrs?: Record<string, any>; content?: PmNode[] };

/** Merges ranges that are adjacent and carry the same mark, so a word typed in
 *  three keystrokes is one entity rather than three. */
function coalesce(entities: RichEntity[]): RichEntity[] {
  const sorted = [...entities].sort((a, b) => a.offset - b.offset || a.type.localeCompare(b.type));
  const out: RichEntity[] = [];

  for (const e of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.type === e.type && prev.url === e.url && prev.offset + prev.length === e.offset) {
      prev.length += e.length;
    } else {
      out.push({ ...e });
    }
  }
  return out;
}

/** One paragraph/heading node -> its plain text and the entities over it. */
function serializeBlock(node: PmNode): RichBlock | null {
  let text = '';
  const entities: RichEntity[] = [];

  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') {
      text += '\n';
      continue;
    }
    if (child.type !== 'text' || !child.text) continue;

    const offset = text.length;
    text += child.text;

    for (const mark of child.marks ?? []) {
      if (!MARKS.includes(mark.type as MarkType)) continue;

      if (mark.type === 'link') {
        const url = safeUrl(mark.attrs?.href);
        if (!url) continue;
        entities.push({ type: 'link', offset, length: child.text.length, url });
      } else {
        entities.push({ type: mark.type as MarkType, offset, length: child.text.length });
      }
    }
  }

  if (!text) return null;

  const block: RichBlock = { type: node.type === 'heading' ? 'h' : 'p', text };
  const merged = coalesce(entities);
  if (merged.length) block.entities = merged;
  return block;
}

/** Tiptap `editor.getJSON()` -> storable blocks. Empty blocks are dropped. */
export function docToBlocks(doc: PmNode | null | undefined): RichBlock[] {
  if (!doc?.content) return [];

  const blocks: RichBlock[] = [];
  for (const node of doc.content) {
    if (node.type !== 'paragraph' && node.type !== 'heading') continue;
    const block = serializeBlock(node);
    if (block) blocks.push(block);
  }
  return blocks;
}

/** Blocks -> Tiptap document JSON, for editing an existing post. */
export function blocksToDoc(blocks: RichBlock[]): PmNode {
  const content: PmNode[] = blocks.map(block => {
    const marksAt = (i: number): PmMark[] => {
      const marks: PmMark[] = [];
      for (const e of block.entities ?? []) {
        if (i >= e.offset && i < e.offset + e.length) {
          marks.push(e.type === 'link' ? { type: 'link', attrs: { href: e.url } } : { type: e.type });
        }
      }
      return marks;
    };

    // Cut the text wherever the active mark set changes, then split each run on
    // newlines so a soft break round-trips as a hardBreak node.
    const inline: PmNode[] = [];
    let runStart = 0;
    let runKey = block.text.length ? JSON.stringify(marksAt(0)) : '';

    const flush = (end: number, marks: PmMark[]) => {
      const slice = block.text.slice(runStart, end);
      if (!slice) return;
      slice.split('\n').forEach((part, idx) => {
        if (idx > 0) inline.push({ type: 'hardBreak' });
        if (part) inline.push({ type: 'text', text: part, ...(marks.length ? { marks } : {}) });
      });
    };

    for (let i = 1; i <= block.text.length; i++) {
      const key = i < block.text.length ? JSON.stringify(marksAt(i)) : null;
      if (key !== runKey) {
        flush(i, marksAt(runStart));
        runStart = i;
        runKey = key ?? '';
      }
    }

    return block.type === 'h'
      ? { type: 'heading', attrs: { level: 3 }, content: inline }
      : { type: 'paragraph', content: inline };
  });

  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** The flat string written to `text`/`content`. Read by the FCM function and
 *  the unread badge, neither of which knows about blocks. */
export function blocksToPlainText(blocks: RichBlock[]): string {
  return blocks.map(b => b.text).join('\n').trim();
}

/** A legacy plain-text post, opened for editing. Each line becomes a paragraph. */
export function plainTextToBlocks(text: string): RichBlock[] {
  if (!text.trim()) return [];
  return text.split('\n').map(line => ({ type: 'p' as const, text: line }));
}

export function isBlocksEmpty(blocks: RichBlock[] | undefined): boolean {
  return !blocks?.some(b => b.text.trim().length > 0);
}
