const DEFAULT_CONFIG = {
  enabled: true,
  outer_ocean: "minecraft:deep_ocean",
  entries: [
    { type: "island", name: "Spawn Island", x: 0, z: 0, radius: 880, shape_power: 2.2, roughness: 0.18, shore_width: 0.18, temperature: "temperate", biome_patch_size: 768, exclude_biomes: ["minecraft:desert", "minecraft:savanna"], noise: { seed: "spawn" } },
    {
      type: "ocean",
      name: "Central Strait",
      x: 360,
      z: 80,
      radius_x: 230,
      radius_z: 980,
      rotation: 24,
      shape_power: 1.35,
      roughness: 0.18,
      shore_width: 0.22,
      temperature: "standard",
      biome_patch_size: 1024,
      noise: { seed: "central_strait", scale: 3.4 },
    },
    {
      type: "island",
      name: "Eastern Highlands",
      x: 1500,
      z: -430,
      radius: 620,
      stretch_x: 1.12,
      stretch_z: 1.32,
      rotation: 18,
      shape_power: 2.8,
      roughness: 0.2,
      noise: { seed: "east_highlands", scale: 3.6 },
    },
    {
      type: "archipelago",
      name: "Western Archipelago",
      x: -1700,
      z: 720,
      radius: 1100,
      count: 16,
      min_radius: 90,
      max_radius: 250,
      spread: 0.88,
      spacing: 1.15,
      min_stretch: 0.7,
      max_stretch: 1.65,
      min_shape_power: 1.2,
      max_shape_power: 3.7,
      roughness: 0.22,
      shore_width: 0.17,
      temperature: "warm",
      biome_patch_size: 1024,
      exclude_biomes: ["#minecraft:is_badlands"],
      noise: { seed: "western_archipelago" },
    },
  ],
};

const DEFAULT_AMPLITUDES = [1.0, 0.78, 0.55, 0.34];
const DEFAULT_NOISE_SCALE = 3.2;
const DEFAULT_FIRST_OCTAVE = -1;
const DEFAULT_MULTIPLIER = 1.0;
const DEFAULT_NOISE_STRENGTH = 0.18;
const DEFAULT_EDGE_WIDTH = 0.16;
const DEFAULT_SHAPE_POWER = 2.0;
const MIN_SHAPE_POWER = 0.75;
const MAX_SHAPE_POWER = 8.0;
const DEFAULT_ARCHIPELAGO_COUNT = 12;
const DEFAULT_ARCHIPELAGO_SPREAD = 0.9;
const DEFAULT_ARCHIPELAGO_SPACING = 1.2;
const DEFAULT_ARCHIPELAGO_MIN_STRETCH = 0.65;
const DEFAULT_ARCHIPELAGO_MAX_STRETCH = 1.6;
const DEFAULT_ARCHIPELAGO_MIN_SHAPE_POWER = 1.2;
const DEFAULT_ARCHIPELAGO_MAX_SHAPE_POWER = 3.8;
const FULL_OCEAN_MASK = 0.30;
const LAND_MASK = 0.58;
const BEACH_START_MASK = 0.50;
const BEACH_END_MASK = 0.56;
const DEEP_OCEAN_MASK = 0.08;
const SPATIAL_CELL_SIZE = 512;

const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d", { alpha: false });
const renderBufferCanvas = document.createElement("canvas");
const renderBufferCtx = renderBufferCanvas.getContext("2d", { alpha: false });
const jsonInput = document.querySelector("#jsonInput");
const seedInput = document.querySelector("#seedInput");
const fileInput = document.querySelector("#fileInput");
const stateBadge = document.querySelector("#stateBadge");
const coords = document.querySelector("#coords");
const zoomLabel = document.querySelector("#zoomLabel");
const statsLabel = document.querySelector("#statsLabel");
const islandList = document.querySelector("#islandList");
const gridToggle = document.querySelector("#gridToggle");
const labelsToggle = document.querySelector("#labelsToggle");
const thresholdToggle = document.querySelector("#thresholdToggle");
const childLabelsToggle = document.querySelector("#childLabelsToggle");
const qualitySelect = document.querySelector("#qualitySelect");

let compiled = [];
let config = DEFAULT_CONFIG;
let worldSeed = 0n;
let view = { x: 0, z: 0, blocksPerPixel: 8 };
let pointer = { down: false, x: 0, y: 0, startX: 0, startZ: 0 };
let renderQueued = false;
let renderExactNoise = false;
let renderWorker = null;
let renderSequence = 0;
let latestRenderSequence = 0;
let workerBusy = false;
let pendingWorkerMessage = null;
let lastRenderElapsedMs = 0;
let lastRenderedView = null;
let lastRenderedSize = null;
let isInteracting = false;
let idleRenderTimer = 0;
let renderMode = "final";

if (typeof Worker !== "undefined") {
  try {
    renderWorker = new Worker("renderer.worker.js");
    renderWorker.addEventListener("message", handleWorkerMessage);
    renderWorker.addEventListener("error", (event) => {
      setState(`worker error: ${event.message}`, true);
      renderWorker = null;
      requestRender();
    });
  } catch (error) {
    renderWorker = null;
  }
}

jsonInput.value = JSON.stringify(DEFAULT_CONFIG, null, 2);
applyConfig();
fitToIslands();

document.querySelector("#applyButton").addEventListener("click", applyConfig);
document.querySelector("#loadDefaultButton").addEventListener("click", () => {
  jsonInput.value = JSON.stringify(DEFAULT_CONFIG, null, 2);
  applyConfig();
  fitToIslands();
});
document.querySelector("#fitButton").addEventListener("click", fitToIslands);
document.querySelector("#resetButton").addEventListener("click", () => {
  view = { x: 0, z: 0, blocksPerPixel: 8 };
  requestRender();
});
document.querySelector("#downloadButton").addEventListener("click", downloadConfig);
seedInput.addEventListener("change", applyConfig);
gridToggle.addEventListener("change", requestRender);
labelsToggle.addEventListener("change", requestRender);
thresholdToggle.addEventListener("change", requestRender);
childLabelsToggle.addEventListener("change", requestRender);
qualitySelect.addEventListener("change", () => requestRender("final"));

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  jsonInput.value = await file.text();
  applyConfig();
  fitToIslands();
  fileInput.value = "";
});

canvas.addEventListener("pointerdown", (event) => {
  beginInteraction();
  pointer.down = true;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.startX = view.x;
  pointer.startZ = view.z;
  canvas.classList.add("dragging");
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  const world = screenToWorld(event.offsetX, event.offsetY);
  coords.textContent = `x ${Math.round(world.x)}, z ${Math.round(world.z)}`;
  if (!pointer.down) return;
  view.x = pointer.startX - (event.clientX - pointer.x) * view.blocksPerPixel;
  view.z = pointer.startZ - (event.clientY - pointer.y) * view.blocksPerPixel;
  drawDragPreview();
  requestRender("interactive");
});

canvas.addEventListener("pointerup", (event) => {
  pointer.down = false;
  canvas.classList.remove("dragging");
  canvas.releasePointerCapture(event.pointerId);
  endInteractionSoon();
});

canvas.addEventListener("pointercancel", () => {
  pointer.down = false;
  canvas.classList.remove("dragging");
  endInteractionSoon();
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  beginInteraction();
  const before = screenToWorld(event.offsetX, event.offsetY);
  const factor = event.deltaY < 0 ? 0.82 : 1.22;
  view.blocksPerPixel = clamp(view.blocksPerPixel * factor, 1, 96);
  const after = screenToWorld(event.offsetX, event.offsetY);
  view.x += before.x - after.x;
  view.z += before.z - after.z;
  requestRender("interactive");
  endInteractionSoon();
}, { passive: false });

window.addEventListener("resize", requestRender);

function applyConfig() {
  try {
    config = JSON.parse(jsonInput.value);
    worldSeed = parseSeed(seedInput.value);
    compiled = parseConfig(config, worldSeed);
    renderIslandList();
    setState(config.enabled === false ? "disabled" : "ready", false);
    requestRender();
  } catch (error) {
    setState(error.message, true);
  }
}

function parseConfig(input, seed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Root must be an object");
  }
  if (!Array.isArray(input.entries)) {
    throw new Error("entries must be an array");
  }

  const compiledEntries = [];
  const landShapes = [];
  const oceanShapes = [];
  const sourceSummaries = [];

  input.entries.forEach((entry, index) => {
    const parsed = parseEntry(entry, index, seed);
    if (parsed.type === "archipelago") {
      const children = compileArchipelago(parsed, seed);
      compiledEntries.push(...children);
      landShapes.push(...children);
      sourceSummaries.push({ ...parsed, childCount: children.length });
    } else {
      compiledEntries.push(parsed);
      if (parsed.type === "ocean") oceanShapes.push(parsed);
      else landShapes.push(parsed);
      sourceSummaries.push({ ...parsed, childCount: 0 });
    }
  });

  compiledEntries.landShapes = landShapes;
  compiledEntries.oceanShapes = oceanShapes;
  compiledEntries.landGrid = buildSpatialGrid(landShapes);
  compiledEntries.oceanGrid = buildSpatialGrid(oceanShapes);
  compiledEntries.sourceSummaries = sourceSummaries;
  return compiledEntries;
}

function parseEntry(entry, index, seed) {
  const path = `entries[${index}]`;
  const name = stringValue(entry.name, `island_${index + 1}`);
  const type = parseEntryType(stringValue(entry.type, "island"), path);
  const noise = entry.noise && typeof entry.noise === "object" ? entry.noise : {};
  const radius = positiveNumber(entry.radius ?? entry.size, -1, `${path}.radius`);
  const radiusX = positiveNumber(entry.radius_x ?? entry.x_divisor, radius, `${path}.radius_x`);
  const radiusZ = positiveNumber(entry.radius_z ?? entry.z_divisor, radius, `${path}.radius_z`);
  if (radiusX <= 0 || radiusZ <= 0) {
    throw new Error(`${path} must define radius or both radius_x and radius_z`);
  }

  const centerX = finiteNumber(entry.x ?? entry.center_x, `${path}.x`);
  const centerZ = finiteNumber(entry.z ?? entry.center_z, `${path}.z`);
  const stretchX = positiveNumber(entry.stretch_x, 1, `${path}.stretch_x`);
  const stretchZ = positiveNumber(entry.stretch_z, 1, `${path}.stretch_z`);
  const amplitudes = Array.isArray(noise.amplitudes) ? noise.amplitudes.map((value, amplitudeIndex) => {
    const parsed = finiteNumber(value, `${path}.noise.amplitudes[${amplitudeIndex}]`);
    if (parsed < 0) throw new Error(`${path}.noise.amplitudes[${amplitudeIndex}] must be >= 0`);
    return parsed;
  }) : DEFAULT_AMPLITUDES;
  if (!amplitudes.length) throw new Error(`${path}.noise.amplitudes must not be empty`);

  const rotation = finiteNumber(entry.rotation ?? entry.rotation_degrees ?? 0, `${path}.rotation`);
  const radians = rotation * Math.PI / 180;
  const noiseSeed = stringValue(noise.seed, name);
  const xDivisor = radiusX * stretchX;
  const zDivisor = radiusZ * stretchZ;
  const clusterRadius = Math.max(xDivisor, zDivisor);
  const minRadius = type === "archipelago" ? positiveNumber(entry.min_radius, clusterRadius * 0.08, `${path}.min_radius`) : 0;
  const maxRadius = type === "archipelago" ? positiveNumber(entry.max_radius, clusterRadius * 0.18, `${path}.max_radius`) : 0;
  if (type === "archipelago" && minRadius > maxRadius) throw new Error(`${path}.min_radius must be <= max_radius`);
  const minStretch = type === "archipelago" ? positiveNumber(entry.min_stretch, DEFAULT_ARCHIPELAGO_MIN_STRETCH, `${path}.min_stretch`) : 0;
  const maxStretch = type === "archipelago" ? positiveNumber(entry.max_stretch, DEFAULT_ARCHIPELAGO_MAX_STRETCH, `${path}.max_stretch`) : 0;
  if (type === "archipelago" && minStretch > maxStretch) throw new Error(`${path}.min_stretch must be <= max_stretch`);
  const minShapePower = type === "archipelago" ? rangeNumber(entry.min_shape_power, DEFAULT_ARCHIPELAGO_MIN_SHAPE_POWER, MIN_SHAPE_POWER, MAX_SHAPE_POWER, `${path}.min_shape_power`) : 0;
  const maxShapePower = type === "archipelago" ? rangeNumber(entry.max_shape_power, DEFAULT_ARCHIPELAGO_MAX_SHAPE_POWER, MIN_SHAPE_POWER, MAX_SHAPE_POWER, `${path}.max_shape_power`) : 0;
  if (type === "archipelago" && minShapePower > maxShapePower) throw new Error(`${path}.min_shape_power must be <= max_shape_power`);

  const parsed = {
    type,
    name,
    overlap: Boolean(entry.overlap),
    centerX,
    centerZ,
    xDivisor,
    zDivisor,
    rotation,
    cos: Math.cos(radians),
    sin: Math.sin(radians),
    shapePower: rangeNumber(entry.shape_power, DEFAULT_SHAPE_POWER, MIN_SHAPE_POWER, MAX_SHAPE_POWER, `${path}.shape_power`),
    multiplier: positiveNumber(entry.multiplier ?? entry.size_multiplier, DEFAULT_MULTIPLIER, `${path}.multiplier`),
    noiseStrength: rangeNumber(entry.roughness ?? entry.noise_strength, DEFAULT_NOISE_STRENGTH, 0, 1, `${path}.roughness`),
    edgeWidth: positiveNumber(entry.shore_width ?? entry.edge_width, DEFAULT_EDGE_WIDTH, `${path}.shore_width`),
    noise: {
      seed: noiseSeed,
      firstOctave: integerNumber(noise.first_octave, DEFAULT_FIRST_OCTAVE, `${path}.noise.first_octave`),
      scale: positiveNumber(noise.scale, DEFAULT_NOISE_SCALE, `${path}.noise.scale`),
      amplitudes,
    },
    seed: mix(seed, stableStringSeed(noiseSeed)),
    seed32: hash32(`${seed.toString()}:${noiseSeed}`),
    exactNoiseCache: new Map(),
    count: type === "archipelago" ? positiveInteger(entry.count, DEFAULT_ARCHIPELAGO_COUNT, `${path}.count`) : 0,
    minRadius,
    maxRadius,
    spread: type === "archipelago" ? rangeNumber(entry.spread, DEFAULT_ARCHIPELAGO_SPREAD, 0.05, 1, `${path}.spread`) : 0,
    spacing: type === "archipelago" ? positiveNumber(entry.spacing, DEFAULT_ARCHIPELAGO_SPACING, `${path}.spacing`) : 0,
    minStretch,
    maxStretch,
    minShapePower,
    maxShapePower,
  };
  attachBounds(parsed);
  return parsed;
}

function parseEntryType(value, path) {
  const type = String(value).toLowerCase();
  if (type === "island" || type === "ocean" || type === "archipelago") return type;
  throw new Error(`${path}.type must be one of island, ocean, archipelago`);
}

function sampleMask(blockX, blockZ) {
  if (config.enabled === false) return 0;
  let union = 0;
  let additive = 0;
  const landCandidates = shapesNear(compiled, "land", blockX, blockZ);
  for (const island of landCandidates) {
    if (!containsPoint(island, blockX, blockZ)) continue;
    const value = sampleIsland(island, blockX, blockZ);
    if (island.overlap) additive += value;
    else union = Math.max(union, value);
  }
  const land = Math.max(union, additive);
  if (land <= 0) {
    return 0;
  }
  let ocean = 0;
  for (const oceanShape of shapesNear(compiled, "ocean", blockX, blockZ)) {
    if (!containsPoint(oceanShape, blockX, blockZ)) continue;
    ocean = Math.max(ocean, sampleIsland(oceanShape, blockX, blockZ));
  }
  return clamp(Math.min(land, 1 - ocean), 0, 1);
}

function sampleIsland(island, blockX, blockZ) {
  const dx = blockX - island.centerX;
  const dz = blockZ - island.centerZ;
  const rotatedX = dx * island.cos - dz * island.sin;
  const rotatedZ = dx * island.sin + dz * island.cos;
  const normalizedX = rotatedX / island.xDivisor;
  const normalizedZ = rotatedZ / island.zDivisor;
  const distance = superellipseDistance(normalizedX, normalizedZ, island.shapePower ?? DEFAULT_SHAPE_POWER);
  const edgeNoise = normalizedNoise(island, normalizedX * island.noise.scale, normalizedZ * island.noise.scale) * island.noiseStrength;
  const field = island.multiplier * (1 + edgeNoise) - distance;
  return smoothstep(-island.edgeWidth, island.edgeWidth, field);
}

function normalizedNoise(island, x, z) {
  let sum = 0;
  let amplitudeSum = 0;
  let frequency = 2 ** island.noise.firstOctave;
  for (const amplitude of island.noise.amplitudes) {
    sum += interpolatedValueNoise(island, x * frequency, z * frequency) * amplitude;
    amplitudeSum += amplitude;
    frequency *= 2;
  }
  return amplitudeSum === 0 ? 0 : sum / amplitudeSum;
}

function interpolatedValueNoise(island, x, z) {
  const x0 = fastFloor(x);
  const z0 = fastFloor(z);
  const tx = smoothFraction(x - x0);
  const tz = smoothFraction(z - z0);
  const a = valueNoise(island, x0, z0);
  const b = valueNoise(island, x0 + 1, z0);
  const c = valueNoise(island, x0, z0 + 1);
  const d = valueNoise(island, x0 + 1, z0 + 1);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

function valueNoise(island, x, z) {
  if (renderExactNoise) {
    return exactValueNoise(island, x, z);
  }

  let mixed = island.seed32 ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(z, 0x85ebca77);
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return ((mixed >>> 0) / 4294967295) * 2 - 1;
}

function exactValueNoise(island, x, z) {
  const key = `${x},${z}`;
  const cached = island.exactNoiseCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (island.exactNoiseCache.size > 60000) {
    island.exactNoiseCache.clear();
  }

  let mixed = island.seed;
  mixed = mix(mixed, BigInt(x) * 341873128712n);
  mixed = mix(mixed, BigInt(z) * 132897987541n);
  const unsigned = BigInt.asUintN(64, mixed);
  const top53 = Number(unsigned >> 11n);
  const value = top53 * 2 ** -53 * 2 - 1;
  island.exactNoiseCache.set(key, value);
  return value;
}

function compileArchipelago(entry, seed) {
  const children = [];
  const placed = [];
  const baseSeed = stableStringSeed(entry.noise.seed);
  const parentRadians = entry.rotation * Math.PI / 180;
  const parentCos = Math.cos(parentRadians);
  const parentSin = Math.sin(parentRadians);

  for (let index = 0; index < entry.count; index++) {
    let accepted = false;
    for (let attempt = 0; attempt < 64; attempt++) {
      const attemptSeed = mix(baseSeed, BigInt(index * 4099 + attempt * 131));
      const angle = randomUnit(attemptSeed, 1n) * Math.PI * 2;
      const distance = Math.sqrt(randomUnit(attemptSeed, 2n)) * entry.spread;
      const localX = Math.cos(angle) * distance * entry.xDivisor;
      const localZ = Math.sin(angle) * distance * entry.zDivisor;
      const centerX = entry.centerX + localX * parentCos - localZ * parentSin;
      const centerZ = entry.centerZ + localX * parentSin + localZ * parentCos;
      const radius = lerp(entry.minRadius, entry.maxRadius, randomUnit(attemptSeed, 3n));
      const stretch = lerp(entry.minStretch, entry.maxStretch, randomUnit(attemptSeed, 4n));
      const stretchX = randomUnit(attemptSeed, 5n) < 0.5;
      const xDivisor = stretchX ? radius * stretch : radius;
      const zDivisor = stretchX ? radius : radius * stretch;
      const rotation = randomUnit(attemptSeed, 6n) * 360;
      const shapePower = lerp(entry.minShapePower, entry.maxShapePower, randomUnit(attemptSeed, 7n));
      const approximateRadius = Math.max(xDivisor, zDivisor);

      if (!hasSpacingConflict(placed, centerX, centerZ, approximateRadius, entry.spacing)) {
        const noiseSeed = `${entry.noise.seed}_${index + 1}`;
        const radians = rotation * Math.PI / 180;
        children.push({
          type: "island",
          name: `${entry.name} ${index + 1}`,
          overlap: entry.overlap,
          centerX,
          centerZ,
          xDivisor,
          zDivisor,
          rotation,
          cos: Math.cos(radians),
          sin: Math.sin(radians),
          shapePower,
          multiplier: entry.multiplier,
          noiseStrength: entry.noiseStrength,
          edgeWidth: entry.edgeWidth,
          noise: { ...entry.noise, seed: noiseSeed },
          seed: mix(0n, stableStringSeed(noiseSeed)),
          seed32: hash32(`0:${noiseSeed}`),
          exactNoiseCache: new Map(),
        });
        attachBounds(children[children.length - 1]);
        placed.push({ centerX, centerZ, radius: approximateRadius });
        accepted = true;
        break;
      }
    }
    if (!accepted) return children;
  }
  return children;
}

function attachBounds(shape) {
  const reach = Math.max(0.1, shape.multiplier * (1 + shape.noiseStrength) + shape.edgeWidth + 0.25);
  const rx = shape.xDivisor * reach;
  const rz = shape.zDivisor * reach;
  const extentX = Math.abs(shape.cos) * rx + Math.abs(shape.sin) * rz;
  const extentZ = Math.abs(shape.sin) * rx + Math.abs(shape.cos) * rz;
  shape.bounds = {
    minX: shape.centerX - extentX,
    maxX: shape.centerX + extentX,
    minZ: shape.centerZ - extentZ,
    maxZ: shape.centerZ + extentZ,
  };
  return shape;
}

function buildSpatialGrid(shapes) {
  const grid = new Map();
  for (const shape of shapes) {
    const bounds = shape.bounds || attachBounds(shape).bounds;
    const minCellX = Math.floor(bounds.minX / SPATIAL_CELL_SIZE);
    const maxCellX = Math.floor(bounds.maxX / SPATIAL_CELL_SIZE);
    const minCellZ = Math.floor(bounds.minZ / SPATIAL_CELL_SIZE);
    const maxCellZ = Math.floor(bounds.maxZ / SPATIAL_CELL_SIZE);
    for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
        const key = `${cellX},${cellZ}`;
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(shape);
      }
    }
  }
  return grid;
}

function shapesNear(compiledShapes, kind, blockX, blockZ) {
  const grid = kind === "ocean" ? compiledShapes.oceanGrid : compiledShapes.landGrid;
  const fallback = kind === "ocean" ? compiledShapes.oceanShapes || [] : compiledShapes.landShapes || compiledShapes;
  if (!grid) {
    return fallback;
  }
  const bucket = grid.get(`${Math.floor(blockX / SPATIAL_CELL_SIZE)},${Math.floor(blockZ / SPATIAL_CELL_SIZE)}`);
  if (!bucket || bucket.length === 0) {
    return [];
  }
  return bucket;
}

function containsPoint(shape, blockX, blockZ) {
  const bounds = shape.bounds;
  return !bounds || blockX >= bounds.minX && blockX <= bounds.maxX && blockZ >= bounds.minZ && blockZ <= bounds.maxZ;
}

function hasSpacingConflict(placed, centerX, centerZ, radius, spacing) {
  return placed.some((child) => {
    const dx = centerX - child.centerX;
    const dz = centerZ - child.centerZ;
    const minDistance = (radius + child.radius) * spacing;
    return dx * dx + dz * dz < minDistance * minDistance;
  });
}

function beginInteraction() {
  isInteracting = true;
  clearTimeout(idleRenderTimer);
}

function endInteractionSoon() {
  clearTimeout(idleRenderTimer);
  idleRenderTimer = setTimeout(() => {
    isInteracting = false;
    requestRender("final");
  }, 140);
}

function requestRender(mode = "final") {
  if (mode === "interactive") {
    renderMode = "interactive";
  } else if (!isInteracting) {
    renderMode = "final";
  }
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const rect = canvas.getBoundingClientRect();
  const requestedQuality = Number(qualitySelect.value) || 0.45;
  const interactive = renderMode === "interactive" || isInteracting;
  const quality = interactive ? Math.min(0.20, requestedQuality) : requestedQuality;
  renderExactNoise = !interactive && requestedQuality >= 0.99;
  const cssWidth = Math.max(1, Math.floor(rect.width));
  const cssHeight = Math.max(1, Math.floor(rect.height));
  const width = Math.max(1, Math.floor(cssWidth * quality));
  const height = Math.max(1, Math.floor(cssHeight * quality));
  const resized = ensureCanvasSize(cssWidth, cssHeight);
  if (resized) {
    drawDragPreview();
  }

  if (renderWorker) {
    queueWorkerRender({
      id: ++renderSequence,
      configText: jsonInput.value,
      seedText: seedInput.value,
      view: { ...view },
      width,
      height,
      cssWidth,
      cssHeight,
      quality,
      exact: renderExactNoise,
      interactive,
    });
    return;
  }

  renderOnMainThread(width, height, cssWidth, cssHeight, quality, renderExactNoise);
}

function queueWorkerRender(message) {
  latestRenderSequence = message.id;
  if (workerBusy) {
    pendingWorkerMessage = message;
    return;
  }

  workerBusy = true;
  renderWorker.postMessage(message);
}

function handleWorkerMessage(event) {
  const message = event.data;
  workerBusy = false;

  if (message.id === latestRenderSequence) {
    if (message.error) {
      setState(message.error, true);
    } else {
      lastRenderElapsedMs = message.elapsedMs;
      ensureCanvasSize(message.cssWidth, message.cssHeight);
      drawScaledMap(new ImageData(new Uint8ClampedArray(message.buffer), message.width, message.height), message.cssWidth, message.cssHeight, message.view);
      drawPostRenderOverlays();
      updateRenderLabels(message.exact, "worker", message.interactive);
    }
  }

  if (pendingWorkerMessage) {
    const next = pendingWorkerMessage;
    pendingWorkerMessage = null;
    queueWorkerRender(next);
  }
}

function renderOnMainThread(width, height, cssWidth, cssHeight, quality, exact) {
  const started = performance.now();
  const previousExact = renderExactNoise;
  renderExactNoise = exact;
  ctx.imageSmoothingEnabled = false;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let y = 0; y < height; y++) {
    const blockZ = view.z + (y / quality - cssHeight / 2) * view.blocksPerPixel;
    for (let x = 0; x < width; x++) {
      const blockX = view.x + (x / quality - cssWidth / 2) * view.blocksPerPixel;
      const value = sampleMask(blockX, blockZ);
      const color = colorForMask(value);
      const offset = (y * width + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
  renderExactNoise = previousExact;
  lastRenderElapsedMs = Math.round(performance.now() - started);
  drawScaledMap(image, cssWidth, cssHeight, { ...view });
  drawPostRenderOverlays();
  updateRenderLabels(exact, "main", false);
}

function drawScaledMap(image, cssWidth, cssHeight, renderedView) {
  if (renderBufferCanvas.width !== image.width || renderBufferCanvas.height !== image.height) {
    renderBufferCanvas.width = image.width;
    renderBufferCanvas.height = image.height;
  }
  renderBufferCtx.imageSmoothingEnabled = false;
  renderBufferCtx.putImageData(image, 0, 0);
  lastRenderedView = renderedView ? { ...renderedView } : { ...view };
  lastRenderedSize = { cssWidth, cssHeight };
  drawBufferedMap(0, 0);
}

function drawBufferedMap(offsetX, offsetY) {
  if (!lastRenderedSize || renderBufferCanvas.width <= 0 || renderBufferCanvas.height <= 0) {
    return;
  }

  ctx.imageSmoothingEnabled = false;
  fillPreviewBackground();
  ctx.drawImage(renderBufferCanvas, offsetX, offsetY, lastRenderedSize.cssWidth, lastRenderedSize.cssHeight);
}

function fillPreviewBackground() {
  ctx.fillStyle = "#163f68";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawDragPreview() {
  if (!lastRenderedView || !lastRenderedSize || view.blocksPerPixel !== lastRenderedView.blocksPerPixel) {
    fillPreviewBackground();
    drawPostRenderOverlays();
    return;
  }

  const offsetX = (lastRenderedView.x - view.x) / view.blocksPerPixel;
  const offsetY = (lastRenderedView.z - view.z) / view.blocksPerPixel;
  drawBufferedMap(offsetX, offsetY);
  drawPostRenderOverlays();
}

function ensureCanvasSize(width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}

function drawPostRenderOverlays() {
  const previousExact = renderExactNoise;
  renderExactNoise = false;
  ctx.save();
  drawOverlays(canvas.width, canvas.height);
  ctx.restore();
  renderExactNoise = previousExact;
}

function updateRenderLabels(exact, engine, interactive) {
  zoomLabel.textContent = `1 px = ${formatNumber(view.blocksPerPixel)} blocks`;
  const structures = (compiled.sourceSummaries || compiled).length;
  const childCount = compiled.length - structures;
  const quality = interactive ? "preview" : exact ? "exact" : "fast";
  statsLabel.textContent = `${structures} structures${childCount > 0 ? ` / ${childCount} child islands` : ""} | ${quality} ${engine} ${lastRenderElapsedMs} ms`;
}

function drawOverlays(width, height) {
  if (thresholdToggle.checked) drawThresholds(width, height);
  if (gridToggle.checked) drawGrid(width, height);
  drawAxes(width, height);
  if (labelsToggle.checked) drawLabels(width, height);
}

function drawGrid(width, height) {
  const step = gridStep(view.blocksPerPixel);
  const startX = Math.floor((view.x - width / 2 * view.blocksPerPixel) / step) * step;
  const endX = view.x + width / 2 * view.blocksPerPixel;
  const startZ = Math.floor((view.z - height / 2 * view.blocksPerPixel) / step) * step;
  const endZ = view.z + height / 2 * view.blocksPerPixel;
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += step) {
    const screen = worldToScreen(x, 0, width, height).x;
    ctx.moveTo(screen, 0);
    ctx.lineTo(screen, height);
  }
  for (let z = startZ; z <= endZ; z += step) {
    const screen = worldToScreen(0, z, width, height).y;
    ctx.moveTo(0, screen);
    ctx.lineTo(width, screen);
  }
  ctx.stroke();
}

function drawAxes(width, height) {
  const origin = worldToScreen(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(origin.x, 0);
  ctx.lineTo(origin.x, height);
  ctx.moveTo(0, origin.y);
  ctx.lineTo(width, origin.y);
  ctx.stroke();
}

function drawThresholds(width, height) {
  const stride = pointer.down ? 18 : 10;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const world = screenToWorld(x, y, width, height);
      const value = sampleMask(world.x, world.z);
      if (Math.abs(value - BEACH_START_MASK) < 0.012 || Math.abs(value - LAND_MASK) < 0.012) {
        ctx.fillStyle = value < LAND_MASK ? "rgba(243,221,142,0.46)" : "rgba(255,255,255,0.30)";
        ctx.fillRect(x, y, stride, stride);
      }
    }
  }
}

function drawLabels(width, height) {
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.textBaseline = "top";
  const items = childLabelsToggle.checked ? compiled : compiled.sourceSummaries || compiled;
  for (const island of items) {
    const screen = worldToScreen(island.centerX, island.centerZ, width, height);
    if (screen.x < -80 || screen.y < -30 || screen.x > width + 80 || screen.y > height + 30) continue;
    ctx.fillStyle = "rgba(14,18,20,0.75)";
    ctx.fillRect(screen.x + 7, screen.y - 8, Math.max(80, island.name.length * 7 + 12), 22);
    ctx.fillStyle = "#eef4ef";
    ctx.fillText(island.name, screen.x + 13, screen.y - 4);
    ctx.fillStyle = "#e2c25d";
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderIslandList() {
  islandList.innerHTML = "";
  const items = compiled.sourceSummaries || compiled;
  if (!items.length) {
    islandList.textContent = "No islands";
    return;
  }
  for (const island of items) {
    const item = document.createElement("button");
    item.className = "island-item";
    item.type = "button";
    const typeText = island.type === "archipelago" ? `archipelago: ${island.childCount} islands` : island.type || "island";
    item.innerHTML = `<span class="island-name">${escapeHtml(island.name)}</span><span class="island-meta">${escapeHtml(typeText)}</span><span class="island-meta">${Math.round(island.centerX)}, ${Math.round(island.centerZ)}</span><span class="island-meta">rx ${Math.round(island.xDivisor)} / rz ${Math.round(island.zDivisor)}</span><span class="island-meta">rot ${formatNumber(island.rotation)}</span>`;
    item.addEventListener("click", () => {
      view.x = island.centerX;
      view.z = island.centerZ;
      view.blocksPerPixel = clamp(Math.max(island.xDivisor, island.zDivisor) / 130, 2, 48);
      requestRender();
    });
    islandList.appendChild(item);
  }
}

function fitToIslands() {
  const items = compiled.sourceSummaries || compiled;
  if (!items.length) {
    view = { x: 0, z: 0, blocksPerPixel: 8 };
    requestRender();
    return;
  }
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const island of items) {
    const radius = Math.max(island.xDivisor, island.zDivisor) * 1.35;
    minX = Math.min(minX, island.centerX - radius);
    minZ = Math.min(minZ, island.centerZ - radius);
    maxX = Math.max(maxX, island.centerX + radius);
    maxZ = Math.max(maxZ, island.centerZ + radius);
  }
  const rect = canvas.getBoundingClientRect();
  view.x = (minX + maxX) / 2;
  view.z = (minZ + maxZ) / 2;
  view.blocksPerPixel = clamp(Math.max((maxX - minX) / Math.max(rect.width, 1), (maxZ - minZ) / Math.max(rect.height, 1)), 1, 96);
  requestRender();
}

function downloadConfig() {
  const blob = new Blob([jsonInput.value], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "continents.json";
  link.click();
  URL.revokeObjectURL(url);
}

function colorForMask(value) {
  if (value < DEEP_OCEAN_MASK) return [22, 63, 104];
  if (value < FULL_OCEAN_MASK) return [38, 118, 166];
  if (value < BEACH_START_MASK) return [62, 139, 174];
  if (value < LAND_MASK) return [216, 202, 142];
  if (value < 0.82) return [115, 167, 96];
  return [71, 123, 79];
}

function screenToWorld(x, y, width = canvas.getBoundingClientRect().width, height = canvas.getBoundingClientRect().height) {
  return {
    x: view.x + (x - width / 2) * view.blocksPerPixel,
    z: view.z + (y - height / 2) * view.blocksPerPixel,
  };
}

function worldToScreen(x, z, width, height) {
  return {
    x: (x - view.x) / view.blocksPerPixel + width / 2,
    y: (z - view.z) / view.blocksPerPixel + height / 2,
  };
}

function parseSeed(value) {
  const trimmed = String(value || "0").trim();
  if (/^-?\d+$/.test(trimmed)) return BigInt(trimmed);
  return stableStringSeed(trimmed);
}

function finiteNumber(value, path) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${path} must be a number`);
  return number;
}

function positiveNumber(value, fallback, path) {
  if (value === undefined || value === null) return fallback;
  const number = finiteNumber(value, path);
  if (number <= 0) throw new Error(`${path} must be positive`);
  return number;
}

function rangeNumber(value, fallback, min, max, path) {
  if (value === undefined || value === null) return fallback;
  const number = finiteNumber(value, path);
  if (number < min || number > max) throw new Error(`${path} must be between ${min} and ${max}`);
  return number;
}

function integerNumber(value, fallback, path) {
  if (value === undefined || value === null) return fallback;
  const number = finiteNumber(value, path);
  if (number !== Math.round(number)) throw new Error(`${path} must be an integer`);
  return number;
}

function positiveInteger(value, fallback, path) {
  const number = integerNumber(value, fallback, path);
  if (number <= 0) throw new Error(`${path} must be positive`);
  return number;
}

function stringValue(value, fallback) {
  return value === undefined || value === null ? fallback : String(value);
}

function gridStep(blocksPerPixel) {
  const target = blocksPerPixel * 110;
  const power = 10 ** Math.floor(Math.log10(target));
  const normalized = target / power;
  if (normalized < 2) return power;
  if (normalized < 5) return power * 2;
  return power * 5;
}

function mix(seed, value) {
  let mixed = BigInt.asIntN(64, seed ^ value);
  mixed = BigInt.asIntN(64, mixed ^ (BigInt.asUintN(64, mixed) >> 33n));
  mixed = BigInt.asIntN(64, mixed * -49064778989728563n);
  mixed = BigInt.asIntN(64, mixed ^ (BigInt.asUintN(64, mixed) >> 33n));
  mixed = BigInt.asIntN(64, mixed * -4265267296055464877n);
  mixed = BigInt.asIntN(64, mixed ^ (BigInt.asUintN(64, mixed) >> 33n));
  return mixed;
}

function randomUnit(seed, salt) {
  const mixed = mix(seed, salt * 0x9e3779b97f4a7c15n);
  return Number(BigInt.asUintN(64, mixed) >> 11n) * 2 ** -53;
}

function stableStringSeed(value) {
  let hash = 1125899906842597n;
  for (let index = 0; index < value.length; index++) {
    hash = BigInt.asIntN(64, 31n * hash + BigInt(value.charCodeAt(index)));
  }
  return hash;
}

function hash32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash | 0;
}

function fastFloor(value) {
  const floor = Math.trunc(value);
  return value < floor ? floor - 1 : floor;
}

function smoothFraction(value) {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function smoothstep(min, max, value) {
  const x = clamp((value - min) / (max - min), 0, 1);
  return x * x * (3 - 2 * x);
}

function superellipseDistance(x, z, power) {
  return (Math.abs(x) ** power + Math.abs(z) ** power) ** (1 / power);
}

function lerp(start, end, delta) {
  return start + (end - start) * delta;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setState(message, isError) {
  stateBadge.textContent = message.length > 22 ? `${message.slice(0, 21)}...` : message;
  stateBadge.title = message;
  stateBadge.classList.toggle("error", isError);
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}






