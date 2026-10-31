// Runs occt-import-js (OpenCascade compiled to WebAssembly) off the main
// thread. A classic worker, because occt-import-js is a classic script loaded
// with importScripts. step-import.js creates one worker per import and
// terminates it afterwards, which is the only way to give the WASM heap back.
//
// In:  { baseUrls: [absolute URLs ending in "/"], file: File | ArrayBuffer, name, params }
// Out: { type: "progress", phase, bytes? }
//      { type: "result", result, timings, heapBytes, base }   (arrays as typed arrays, transferred)
//      { type: "error", kind, message, log, heapBytes }
/* global occtimportjs */
"use strict";

const log = [];

function remember(text) {
  log.push(String(text));
  if (log.length > 40) log.shift();
}

function post(type, data, transfer) {
  self.postMessage(Object.assign({ type }, data), transfer || []);
}

// Try each base URL in order (the CDN, then the designer's own vendor/ folder).
async function loadLibrary(baseUrls) {
  const failures = [];
  for (const base of baseUrls) {
    try {
      importScripts(base + "occt-import-js.js");
      const occt = await occtimportjs({
        locateFile: path => base + path,
        print: remember,
        printErr: remember,
      });
      return { occt, base };
    } catch (err) {
      failures.push(`${base}: ${(err && err.message) || err}`);
    }
  }
  const error = new Error(`Could not load the STEP reader (occt-import-js). ${failures.join("; ")}`);
  error.kind = "load";
  throw error;
}

function heapBytes(occt) {
  return occt && occt.HEAPU8 ? occt.HEAPU8.length : 0;
}

// occt-import-js gives plain arrays; typed arrays transfer without a copy
// and take a quarter of the memory.
function toTyped(result, transfer) {
  for (const mesh of result.meshes || []) {
    const attrs = mesh.attributes || {};
    if (attrs.position) {
      attrs.position.array = Float32Array.from(attrs.position.array || []);
      transfer.push(attrs.position.array.buffer);
    }
    if (attrs.normal) {
      attrs.normal.array = Float32Array.from(attrs.normal.array || []);
      transfer.push(attrs.normal.array.buffer);
    }
    if (mesh.index) {
      mesh.index.array = Uint32Array.from(mesh.index.array || []);
      transfer.push(mesh.index.array.buffer);
    }
  }
}

self.onmessage = async function (ev) {
  const { baseUrls, file, params } = ev.data;
  const t0 = performance.now();
  let occt = null;
  try {
    post("progress", { phase: "load" });
    const loaded = await loadLibrary(baseUrls);
    occt = loaded.occt;
    const tLoaded = performance.now();

    let bytes = new Uint8Array(file instanceof Blob ? await file.arrayBuffer() : file);
    post("progress", { phase: "read", bytes: bytes.length });
    const tFile = performance.now();
    let result;
    try {
      result = occt.ReadStepFile(bytes, params);
    } catch (err) {
      const heap = heapBytes(occt);
      const text = `${(err && err.message) || err} ${log.join(" ")}`;
      const error = new Error(String((err && err.message) || err));
      // A failed allocation surfaces as an abort; the heap size tells it apart.
      error.kind = /OOM|out of memory|Cannot enlarge|bad_alloc/i.test(text) || heap >= 1024 * 1024 * 1024 ? "memory" : "crash";
      throw error;
    }
    bytes = null;
    const tRead = performance.now();
    if (!result || !result.success) {
      const error = new Error("occt-import-js could not read the file");
      error.kind = "read";
      throw error;
    }

    post("progress", { phase: "convert" });
    const transfer = [];
    toTyped(result, transfer);
    const tConvert = performance.now();
    post("result", {
      result,
      base: loaded.base,
      heapBytes: heapBytes(occt),
      timings: {
        loadMs: tLoaded - t0,
        fileMs: tFile - tLoaded,
        readMs: tRead - tFile,
        convertMs: tConvert - tRead,
      },
    }, transfer);
  } catch (err) {
    post("error", {
      kind: (err && err.kind) || "crash",
      message: String((err && err.message) || err),
      log: log.slice(-20),
      heapBytes: heapBytes(occt),
    });
  }
};
