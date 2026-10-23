import assert from 'node:assert/strict';
import { PdfInteractionRevisionCoordinator } from '../src/lib/pdfInteractionState';

const coordinator = new PdfInteractionRevisionCoordinator();

const annotate = coordinator.request({ mode: 'annotate' });
const eraser = coordinator.request({ mode: 'annotate', tool: 'eraser' });

assert.equal(annotate.revision, 1, 'first transition receives revision 1');
assert.equal(eraser.revision, 2, 'rapid tool switch receives a newer revision');

assert.equal(
  coordinator.confirm({ appliedRevision: 1, appliedState: annotate }),
  null,
  'an out-of-order acknowledgement cannot confirm stale UI state',
);

assert.deepEqual(
  coordinator.confirm({ appliedRevision: 2, appliedState: eraser }),
  eraser,
  'the latest acknowledgement confirms the applied native state',
);

const read = coordinator.request({ mode: 'read' });
assert.equal(
  coordinator.confirm({
    appliedRevision: read.revision,
    appliedState: { ...read, revision: read.revision - 1 },
  }),
  null,
  'a mismatched applied-state revision is rejected',
);

assert.equal(coordinator.rollbackLatest(read.revision - 1, eraser), false, 'stale failures cannot roll state back');
assert.equal(coordinator.rollbackLatest(read.revision, eraser), true, 'the latest failed request rolls desired state back');
assert.equal(coordinator.currentDesired().mode, 'annotate', 'rollback restores the last confirmed mode');

console.log('PASS: PDF interaction revisions reject stale and mismatched acknowledgements');
