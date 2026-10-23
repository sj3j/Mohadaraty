import type {
  ReaderInteractionState,
  SetInteractionResult,
} from './nativePdfViewer';

export const DEFAULT_READER_INTERACTION: ReaderInteractionState = {
  mode: 'read',
  tool: 'pencil',
  fingerDrawing: true,
  chromeVisible: true,
  webOverlayActive: false,
  revision: 0,
};

/**
 * Owns the monotonically increasing JS-side revision sequence. Native remains
 * authoritative: an acknowledgement is accepted only when it identifies the
 * latest requested revision and returns the matching applied state.
 */
export class PdfInteractionRevisionCoordinator {
  private desired: ReaderInteractionState;
  private latestRequestedRevision: number;

  constructor(initial: ReaderInteractionState = DEFAULT_READER_INTERACTION) {
    this.desired = { ...initial };
    this.latestRequestedRevision = initial.revision;
  }

  request(patch: Partial<Omit<ReaderInteractionState, 'revision'>>): ReaderInteractionState {
    const revision = this.latestRequestedRevision + 1;
    this.latestRequestedRevision = revision;
    this.desired = { ...this.desired, ...patch, revision };
    return { ...this.desired };
  }

  confirm(result: SetInteractionResult): ReaderInteractionState | null {
    if (
      result.appliedRevision !== this.latestRequestedRevision ||
      result.appliedState.revision !== result.appliedRevision
    ) {
      return null;
    }

    this.desired = { ...result.appliedState };
    return { ...this.desired };
  }

  rollbackLatest(revision: number, confirmed: ReaderInteractionState): boolean {
    if (revision !== this.latestRequestedRevision) return false;
    this.desired = { ...confirmed, revision: this.latestRequestedRevision };
    return true;
  }

  currentDesired(): ReaderInteractionState {
    return { ...this.desired };
  }

  latestRevision(): number {
    return this.latestRequestedRevision;
  }
}

