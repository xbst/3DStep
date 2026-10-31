# designer/js/import

How the designer turns STEP and GLB files into models and writes them back as GLB. Plain ES modules, no build step; `occt-worker.js` is the one classic script (a worker).

| File | What it does |
|---|---|
| `step-import.js` | `importStep(file, options)`: STEP to `Model` through occt-import-js in a worker; `readStepRaw` and `modelFromRaw` split the slow read from the cheap build; `buildModel` is the pure tree mapping; `rawTree` summarizes a read for an import dialog |
| `occt-worker.js` | Loads occt-import-js (`importScripts`, base URLs tried in order), runs `ReadStepFile`, posts the result back with typed arrays transferred |
| `model.js` | The `Model` shape (SPEC 13.1) and its operations: `deleteNodes`, `mergeGroup`, `replaceMesh`, `triangleCount`, `bboxOf`, `selectTiny`, `treeOf`, `estimateGlbSize`, `estimateHtmlSize`, `flattenForeign`, `checkModel` |
| `glb-writer.js` | `writeGlb(model)`: SPEC 7's conventions, the same as `glb.py`'s writer |
| `glb-reader.js` | `readGlb(bytes, options)`: 3DStep GLBs round-trip; foreign GLB / glTF files are converted |
| `simplify.js` | meshoptimizer's simplifier per primitive |
| `ids.js` | The id rule (SPEC 7), shared with `glb.py` through `tests/fixtures/ids-cases.json` |

## The Model

```js
Model = { name, units: "mm", up: "z", generator: "designer 0.1.0",
  nodes: [{ id, label, parent, children, mesh, src }],
  meshes: [{ primitives: [{ positions, normals, indices, color }], bbox: { min, max }, triangles }],
  stats }   // optional, from importStep / readGlb; the writer ignores it
```

- `nodes` are in document order (pre-order); `parent` is -1 for a root; a node is a part (`mesh` >= 0, no `children`) or a group (`mesh` -1), never both.
- One mesh per part, `meshes` in the order of the parts.
- `positions`: `Float32Array`, model space (mm, the CAD axes, placement applied). `normals`: `Float32Array` or `null`. `indices`: `Uint32Array`. `color`: linear RGBA 0 to 1, the glTF `baseColorFactor`. To show it as CSS, convert linear to sRGB.
- `src`: free-form provenance written to the node's `extras.src` (the occt tree path, `0/3` or `0/3#2` for a split body).
- Operations return a new model and share the typed arrays with the old one: treat them as read-only.

## How occt-import-js 0.0.23 reads a STEP file

From its `importer-step.cpp`, `importer-xcaf.cpp`, `importer-utils.cpp` and `js-interface.cpp`. `stepconv.py` (chunk 06) must reproduce this traversal to get the same ids and tree.

1. **Reading.** A `TDocStd_Document("XmlXCAF")`, `XCAFDoc_DocumentTool::SetLengthUnit(doc, 1.0, mm)` first (so coordinates come out in millimeters whatever the file says), then `STEPCAFControl_Reader` with `SetColorMode(true)` and `SetNameMode(true)`, `ReadStream`, `Transfer(doc)`. Failure, or no free shapes, gives `success: false`.
2. **Root.** An unnamed node whose children are the labels under `shapeTool->Label()` (in label order) that are free shapes (`GetShape` succeeds and `IsFree`). Each one is triangulated as a whole when the root's children are listed: `BRepMesh_IncrementalMesh(shape, lin, false, ang)` with `lin = mean(bbox extents) * linearDeflection` (bbox from `BRepBndLib::Add(shape, box, false)`; a void bbox skips the shape; `lin` under `Precision::Confusion()` becomes 1 mm). `linearDeflectionType: "absolute_value"` uses the value as is.
3. **Nodes.** A node's name is the `TDataStd_Name` of its label, following references to the referred shape. A label is a *mesh node* when it has no child labels, or one of its child labels is a sub-shape (`IsSubShape`), or none of them is a free shape; otherwise it is a group whose children are its free-shape child labels. A component (a reference label) has no child labels, so **every component of the top assembly is a mesh node: anything nested deeper is flattened into that component's meshes.** In `ToqueCAN.step` (a Fusion assembly around an EasyEDA board), the whole board is one node with 491 bodies.
4. **Meshes (bodies) of a mesh node**, from `shapeTool->GetShape(label)` (the located shape): every solid (`TopExp_Explorer(shape, TopAbs_SOLID)`), then every shell outside a solid (`TopExp_Explorer(shape, TopAbs_SHELL, TopAbs_SOLID)`), then one mesh with all faces outside a shell (`TopExp_Explorer(shape, TopAbs_FACE, TopAbs_SHELL)`), if any.
5. **Mesh name**: `shapeTool->Search(body, label)` (default flags: instance, component, sub-shape), then the label's name as in 3; empty when the search fails, and always empty for the standalone-faces mesh. For a flattened sub-assembly the names are usually the products' names (`M2.5x6 BHCS`).
6. **Mesh color**: `Search(body)`, then `XCAFDoc_ColorTool::GetColor(label, type)` for `XCAFDoc_ColorSurf`, `XCAFDoc_ColorCurv`, `XCAFDoc_ColorGen` in that order, following the reference when the label has none. `Quantity_Color::Red()` etc. are **linear RGB from 0 to 1**: OCCT reads the STEP values as sRGB and linearizes them (`COLOUR_RGB` 0.8 comes back as 0.6038, 0.66 as 0.3931). They are glTF `baseColorFactor` values as they are.
7. **Triangles.** For each face (`TopExp_Explorer(body, TopAbs_FACE)`): `BRep_Tool::Triangulation(face, location)`; a face without one adds nothing. Its nodes, transformed by `location`, are appended as new vertices (vertices are never shared between faces); `triangulation->ComputeNormals()` gives the normals, transformed by `location` and negated for a `TopAbs_REVERSED` face; triangles are the node indices minus 1 plus the vertex offset, with the second and third swapped for a reversed face. When some face had no normals, the mesh has none.
8. `brep_faces` lists each face's triangle range and color; 3DStep v1 ignores it (`ToqueCAN.step` has no face-only colors).

## From the occt result to the Model (`buildModel`)

For each node under the unnamed root, in document order:

- children and no meshes: a group;
- meshes and no children: a part whose bodies are its primitives; when the bodies are not merged (`mergeBodies: false`, or the callback says so for this node) and there are several, a group with one part per body, labeled with the body's (mesh's) name, else `<label>_body<N>` (N counts the node's bodies from 1);
- both (occt-import-js never produces this): a group with a part `<label>` (or its body parts) for its own meshes first, then its children;
- no meshes anywhere below: skipped.

A node's label is its name, else its first mesh's name, else `part`. Ids are assigned by `assignIds` over every label in document order **before** any body is dropped. Then bodies with no triangles, or with a bounding-box diagonal under `minSize`, are dropped; then parts without bodies; then groups without parts. So a kept part has the same id whatever the quality and size filter. Within a part, bodies of the same color become one primitive, in the order each color first appears (same color = equal after rounding to four decimals, as `glb.py` keys materials). A body without normals gets area-weighted ones (smooth within each face, since faces do not share vertices). A color above 1 would be read as 0 to 255 (never seen).

Quality presets (SPEC 11.3): `fine` 0.0005 / 0.3 rad, `normal` 0.001 / 0.5 rad (the library's defaults), `coarse` 0.003 / 0.8 rad; `deflection` (mm) and `angle` (degrees) override them.

## Writing and reading GLB

`writeGlb` follows `glb.py`'s writer: node names are ids; `extras.label` and `extras.src`; part nodes carry `translation` = the mesh's bounding-box center and a uniform `scale` = the largest half extent (at least 1e-6); `POSITION` is `SHORT` normalized with a stride of 8 and `min`/`max` in quantized units; `NORMAL` is `BYTE` normalized with a stride of 4; indices are `UNSIGNED_SHORT` up to 65535 vertices, else `UNSIGNED_INT`; one material per color named `color_<rrggbb>` from the factor (plus alpha digits when alpha < 1), metallic 0, roughness 0.8, single-sided; `KHR_mesh_quantization` used and required; `asset.extras.threedstep = { version: 1, units, up, generator }`; JSON keys sorted, so the same model gives the same bytes.

`readGlb` reads a 3DStep GLB back to the same tree with positions within one quantization step (largest half extent / 32767) and normals within a degree. A foreign GLB (no `threedstep` metadata) or `.gltf` with embedded buffers is converted: node transforms baked into positions (normals through the inverse transpose, winding flipped under a mirroring matrix), the given unit scaled to mm and the given up axis rotated to `targetUp`, labels from node names (else the mesh name, else `part`) slugified by the id rule, every instance of a shared mesh its own part, nodes without geometry dropped, same-color primitives joined. Draco, meshopt compression and GPU instancing are refused with the extension's name; external buffers are refused.

## Simplification

`simplifyPrimitive` runs `MeshoptSimplifier.simplify` on the positions (target `ratio` of the triangles, `error` relative to the primitive's extent or absolute mm), then `compactMesh`. The simplifier keeps original vertices, so the surviving vertices keep occt's exact normals. occt's faces have their own vertices, but the copies along an edge are equal bit for bit (all fixtures; 48 of 433,575 vertices in `ToqueCAN.step` were only nearly equal). meshoptimizer treats them as seams, so faces stay closed and creases stay sharp. Do not weld before simplifying: the face structure is what keeps line art's creases.

## Measured on ToqueCAN.step

43.4 MB, a Fusion assembly (Raspberry Pi, the EasyEDA ToqueCAN v4 board, fasteners, fan assembly, USB2 board), normal quality: `ReadStepFile` takes about 42 s in Node and fills occt-import-js's WASM heap to its 2 GB maximum. The result has 541 bodies and 386,445 triangles. With a 2 mm size filter, 382 bodies are dropped, leaving 228,512 triangles and a 4.8 MB GLB. Simplifying to 50% gives 116,219 triangles and a 2.4 MB GLB in 65 ms. A larger assembly will run out of memory: the import then fails with a message that says to use the coarse quality or split the assembly into several STEP files (a project can hold several models).
