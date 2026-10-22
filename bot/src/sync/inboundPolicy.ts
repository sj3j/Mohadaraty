export interface ExistingInboundMapping {
  announcementId: string | null;
  skipped?: string | null;
  mediaGroupId?: string | null;
  messageIds: number[];
}

/** Empty/unsupported skips may become meaningful after an edit; poll-only may not. */
export function isPromotableSkip(mapping: ExistingInboundMapping | null): boolean {
  return mapping?.announcementId === null && mapping.skipped !== 'poll_only';
}

export function isGrowingAlbum(
  mapping: ExistingInboundMapping | null,
  incomingMessageIds: number[],
): boolean {
  return !!mapping?.mediaGroupId && incomingMessageIds.some(id => !mapping.messageIds.includes(id));
}
