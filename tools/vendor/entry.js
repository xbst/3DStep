// The curated export list for src/threedstep/viewer/vendor/three.bundle.js.
//
// build.py bundles this file with esbuild into one IIFE that defines
// window.THREE.  Only what is re-exported here ends up in the bundle: Three.js
// is tree-shaken to these names, so add a class here (and rebuild) before using
// a new THREE.<Name> in viewer.js or in the designer.  A local test checks that
// every THREE.<Name> used by the sources is listed here.

export {
  // renderer, render targets, textures
  WebGLRenderer, WebGLRenderTarget, DepthTexture, Texture, CanvasTexture, DataTexture,
  // scene graph
  Scene, Group, Object3D, Mesh, InstancedMesh, Line, LineSegments, LineLoop, Points, Sprite, Layers,
  // cameras
  Camera, PerspectiveCamera, OrthographicCamera,
  // math and utilities
  Vector2, Vector3, Vector4, Matrix3, Matrix4, Quaternion, Euler, Box3, Sphere, Ray, Plane, Frustum,
  Spherical, Triangle, Line3, Color, MathUtils, Raycaster, Clock, EventDispatcher, ColorManagement,
  // geometry
  BufferGeometry, BufferAttribute, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute,
  Int16BufferAttribute, Int8BufferAttribute, InterleavedBuffer, InterleavedBufferAttribute,
  PlaneGeometry, BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, TorusGeometry, TubeGeometry,
  CircleGeometry, RingGeometry, EdgesGeometry, WireframeGeometry, Curve, CatmullRomCurve3, LineCurve3,
  QuadraticBezierCurve3, Shape, ShapeGeometry, ExtrudeGeometry,
  // materials
  Material, ShaderMaterial, RawShaderMaterial, MeshBasicMaterial, MeshStandardMaterial, MeshLambertMaterial,
  MeshNormalMaterial, MeshDepthMaterial, LineBasicMaterial, LineDashedMaterial, PointsMaterial, SpriteMaterial,
  UniformsUtils, UniformsLib, ShaderLib, ShaderChunk,
  // lights
  AmbientLight, HemisphereLight, DirectionalLight, PointLight,
  // helpers (designer)
  AxesHelper, GridHelper, Box3Helper, BoxHelper, ArrowHelper, PlaneHelper,
  // constants
  REVISION, GLSL3, FloatType, HalfFloatType, UnsignedByteType, UnsignedIntType, UnsignedInt248Type,
  UnsignedShortType, ByteType, ShortType, IntType, NearestFilter, LinearFilter, LinearMipmapLinearFilter,
  ClampToEdgeWrapping, RepeatWrapping, RGBAFormat, RGBFormat, RedFormat, RGFormat, DepthFormat,
  DepthStencilFormat, FrontSide, BackSide, DoubleSide, NoBlending, NormalBlending, AdditiveBlending,
  MultiplyBlending, CustomBlending, SrcAlphaFactor, OneMinusSrcAlphaFactor, OneFactor, ZeroFactor, AddEquation,
  NeverDepth, AlwaysDepth, LessDepth, LessEqualDepth, EqualDepth, GreaterEqualDepth, GreaterDepth, NotEqualDepth,
  NoToneMapping, SRGBColorSpace, LinearSRGBColorSpace, NoColorSpace, StaticDrawUsage, DynamicDrawUsage,
} from 'three';

// Addons: the GLB loader, the camera and gizmo controls, geometry utilities
// and the post-processing pieces the viewer can use.
export { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
export { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
export { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
export * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
export { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
export { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
export { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
export { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
export { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
