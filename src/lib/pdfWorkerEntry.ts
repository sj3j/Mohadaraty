/**
 * Entrypoint for the PDF.js Web Worker.
 *
 * Ensures that the Map.prototype.getOrInsertComputed and Promise.withResolvers
 * polyfills are loaded inside the DedicatedWorkerGlobalScope before Mozilla's
 * pdf.worker.min.mjs executes.
 */
import './pdfPolyfills';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
