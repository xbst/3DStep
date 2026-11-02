// Cuts a big STEP file into pieces (step-pieces.js) off the main thread, for
// step-import.js to read one by one with occt-worker.js. A module worker: it
// keeps the file and its index until the last piece is written.
//
// In:  { type: "split", file: File | ArrayBuffer, budget }
//      { type: "plan", budget }   (the same file cut again, for another budget)
//      { type: "piece", k }
// Out: { type: "plan", pieces: [{ bytes, items, names }], geometryBytes, ms }
//        (names: the first few products a piece holds)
//      { type: "whole" }   (the file cannot be cut, or needs no cutting)
//      { type: "piece", k, blob, bytes }
//      { type: "error", message }
import { planPieces, productName, splitStep } from "./step-pieces.js";

let split = null;

function plan(t0) {
  self.postMessage({
    type: "plan",
    pieces: split.pieces.map(piece => ({
      bytes: piece.bytes,
      items: piece.items.length,
      names: piece.pds.slice(0, 3).map(pd => productName(split.index, pd)),
    })),
    geometryBytes: split.analysis.geometryBytes,
    ms: performance.now() - t0,
  });
}

self.onmessage = async ev => {
  const msg = ev.data;
  const t0 = performance.now();
  try {
    if (msg.type === "split") {
      const file = msg.file;
      const bytes = new Uint8Array(typeof Blob !== "undefined" && file instanceof Blob ? await file.arrayBuffer() : file);
      split = splitStep(bytes, { budget: msg.budget });
      if (!split) self.postMessage({ type: "whole" });
      else plan(t0);
    } else if (msg.type === "plan") {
      split.pieces = planPieces(split.analysis, msg.budget);
      plan(t0);
    } else if (msg.type === "piece") {
      const { parts, bytes } = split.piece(msg.k);
      self.postMessage({ type: "piece", k: msg.k, blob: new Blob(parts), bytes });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
