import type { MarkType, RichBlock, RichEntity } from '../../../src/types/announcement.types.ts';
import { safeUrl } from '../../../src/lib/richText.ts';
import { TG_LIMITS, type TgMessageEntity } from '../telegram/types.ts';

/**
 * Telegram MessageEntity <-> RichEntity.
 *
 * This is a rename, not a re-encode, and that is by design: RichEntity's
 * offsets were specified in UTF-16 code units precisely because Telegram's are
 * (see the header of src/types/announcement.types.ts). An emoji is 2 on both
 * sides, an Arabic letter is 1 on both sides. Nothing here recomputes lengths.
 *
 * The mark set is CLOSED in one direction only. Telegram's vocabulary is wider
 * than MarkType, so inbound drops or downgrades; outbound may only ever emit
 * the six marks the app stores, because anything else would round-trip into a
 * MarkType that does not exist.
 */

const IN: Partial<Record<TgMessageEntity['type'], MarkType>> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strike',
  code: 'code',
  // Downgrade: the app has no block-code node, and adding one would force
  // RichBlock into a tree. Inline code keeps the monospace intent.
  pre: 'code',
  text_link: 'link',
};

const OUT: Record<MarkType, TgMessageEntity['type']> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strike: 'strikethrough',
  code: 'code',
  link: 'text_link',
};

/**
 * Entity types deliberately dropped, with the text kept.
 *
 *   spoiler / blockquote / expandable_blockquote - no MarkType, and quotes are
 *     block-level, which the flat RichBlock array refuses by construction.
 *   url - RichContent.autoLink already linkifies bare http(s) in unmarked runs,
 *     so marking it too would double-wrap the same text in two anchors.
 *   mention / hashtag / cashtag / bot_command / email / phone_number - Telegram
 *     renders these as links to Telegram-internal things the app cannot open.
 *   text_mention / custom_emoji - reference Telegram user and sticker ids that
 *     have no meaning outside Telegram.
 */

/** Inbound. Clamped to the text, unsafe links dropped, then sorted. */
export function tgEntitiesToRich(
  entities: TgMessageEntity[] | undefined,
  textLength: number,
): RichEntity[] {
  if (!entities?.length) return [];
  const out: RichEntity[] = [];

  for (const entity of entities) {
    const type = IN[entity.type];
    if (!type) continue;

    const offset = Math.max(0, entity.offset);
    const length = Math.min(entity.length, textLength - offset);
    if (length <= 0) continue;

    if (type === 'link') {
      // A channel admin is not more trusted than a moderator, and richText.ts
      // exists because React renders href="javascript:..." verbatim. Same
      // allowlist the composer uses; an entity that fails it is dropped, and
      // its text survives unmarked.
      const url = safeUrl(entity.url);
      if (!url) continue;
      out.push({ type, offset, length, url });
    } else {
      out.push({ type, offset, length });
    }
  }

  return out.sort((a, b) => a.offset - b.offset || a.length - b.length);
}

/** Outbound. Only the six storable marks are emitted, ever. */
export function richEntitiesToTg(entities: RichEntity[] | undefined): TgMessageEntity[] {
  if (!entities?.length) return [];
  const out: TgMessageEntity[] = [];

  for (const entity of entities) {
    const type = OUT[entity.type];
    if (!type) continue;
    if (entity.length <= 0) continue;

    if (entity.type === 'link') {
      const url = safeUrl(entity.url);
      if (!url) continue;
      out.push({ type, offset: entity.offset, length: entity.length, url });
    } else {
      out.push({ type, offset: entity.offset, length: entity.length });
    }
  }

  return out.sort((a, b) => a.offset - b.offset);
}

/**
 * A Telegram message body -> exactly ONE RichBlock.
 *
 * Not split on blank lines, tempting as that is. blocksToPlainText joins blocks
 * with '\n', so any split makes the join lossy and the mirror hash would never
 * settle across a round trip. One block is the only mapping where
 * blocksToPlainText(blocks) === msg.text character for character, which in turn
 * is what makes the outbound conversion an identity.
 *
 * `type: 'h'` is never produced inbound - Telegram has no heading.
 */
export function tgMessageToBlocks(text: string, entities?: TgMessageEntity[]): RichBlock[] {
  if (!text) return [];
  const converted = tgEntitiesToRich(entities, text.length);
  const block: RichBlock = { type: 'p', text };
  if (converted.length) block.entities = converted;
  return [block];
}

export interface TgText {
  text: string;
  entities: TgMessageEntity[];
}

/**
 * Blocks -> one Telegram text payload.
 *
 * Blocks are joined with '\n' to match blocksToPlainText exactly. A heading has
 * no Telegram equivalent, so it is emitted as bold over the whole block - the
 * closest honest rendering, and one that survives the trip back as plain text
 * rather than as a mark the app cannot store.
 */
export function blocksToTgText(blocks: RichBlock[]): TgText {
  let text = '';
  const entities: TgMessageEntity[] = [];

  blocks.forEach((block, index) => {
    if (index > 0) text += '\n';
    const base = text.length;
    text += block.text;

    for (const entity of richEntitiesToTg(block.entities)) {
      entities.push({ ...entity, offset: entity.offset + base });
    }
    if (block.type === 'h' && block.text.length > 0) {
      entities.push({ type: 'bold', offset: base, length: block.text.length });
    }
  });

  return { text, entities: entities.sort((a, b) => a.offset - b.offset) };
}

/**
 * Keeps only entities fully describable at this offset window, clipping any
 * that straddle the boundary rather than dropping them.
 */
function sliceEntities(entities: TgMessageEntity[], start: number, end: number): TgMessageEntity[] {
  const out: TgMessageEntity[] = [];
  for (const entity of entities) {
    const from = Math.max(entity.offset, start);
    const to = Math.min(entity.offset + entity.length, end);
    if (to <= from) continue;
    out.push({ ...entity, offset: from - start, length: to - from });
  }
  return out;
}

/**
 * Splits a body that exceeds Telegram's 4096-character message limit.
 *
 * Breaks at the last newline before the limit, then the last space, then hard -
 * and clips the entity array at every boundary, which is the part a naive
 * `slice()` gets wrong and which shows up as formatting bleeding across parts.
 *
 * Capped at `maxParts`: a runaway body should be truncated visibly, not
 * broadcast as fifteen consecutive channel posts.
 */
export function splitTgText(payload: TgText, limit: number = TG_LIMITS.textChars, maxParts = 4): TgText[] {
  if (payload.text.length <= limit) return [payload];

  const parts: TgText[] = [];
  let cursor = 0;

  while (cursor < payload.text.length && parts.length < maxParts) {
    const isLast = parts.length === maxParts - 1;
    let end = Math.min(cursor + limit, payload.text.length);

    if (end < payload.text.length && !isLast) {
      const window = payload.text.slice(cursor, end);
      const newline = window.lastIndexOf('\n');
      const space = window.lastIndexOf(' ');
      if (newline > limit * 0.5) end = cursor + newline;
      else if (space > limit * 0.5) end = cursor + space;
    }

    let text = payload.text.slice(cursor, end);
    let entities = sliceEntities(payload.entities, cursor, end);

    if (isLast && end < payload.text.length) {
      text = `${text.slice(0, limit - 1)}…`;
      entities = sliceEntities(entities, 0, text.length - 1);
    }

    parts.push({ text, entities });
    cursor = end;
    while (payload.text[cursor] === '\n' || payload.text[cursor] === ' ') cursor++;
  }

  return parts;
}
