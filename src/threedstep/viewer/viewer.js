/* 3DStep viewer runtime: a stub.
 *
 * The real viewer (a Three.js scene with a step panel, exposing the full
 * window.ThreeDStep API) replaces this file wholesale. Until then a generated
 * page shows its static fallback: the renderer writes the assembly title and
 * every step's title and text into #tds, and boot() leaves them as they are,
 * so the page reads as a plain list of instructions.
 */
(function () {
  "use strict";
  window.ThreeDStep = {
    VERSION: "stub",
    boot: function () { /* shows the static fallback */ }
  };
})();
