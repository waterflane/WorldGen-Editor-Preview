const DEFAULT_CONFIG = {
  enabled: true,
  entries: [
    { name: "Spawn Island", x: 0, z: 0, radius: 850, roughness: 0.2, noise: { seed: "spawn" } },
    {
      name: "Northern Long Island",
      x: -1350,
      z: -950,
      radius: 520,
      stretch_x: 1.55,
      stretch_z: 0.78,
      rotation: -28,
      roughness: 0.16,
      noise: { seed: "north_long" },
    },
    {
      name: "Eastern Highlands",
      x: 1420,
      z: -450,
      radius: 610,
      stretch_x: 1.05,
      stretch_z: 1.28,
      rotation: 18,
      roughness: 0.22,
      noise: { seed: "east_highlands", scale: 3.6 },
    },
    {
      name: "Southern Small Island",
      x: 620,
      z: 1460,
      radius: 360,
      rotation: 8,
      roughness: 0.12,
      noise: { seed: "south_small", amplitudes: [1.0, 0.6, 0.35] },
    },
    {
      name: "Western Small Island",
      x: -1780,
      z: 840,
      radius_x: 470,
      radius_z: 330,
      rotation: 31,
      roughness: 0.24,
      noise: { seed: "west_small", scale: 3.9 },
    },
  ],
};

const DEFAULT_AMPLITUDES = [1.0, 0.78, 0.55, 0.34];
const DEFAULT_NOISE_SCALE = 3.2;
const DEFAULT_FIRST_OCTAVE = -1;
const DEFAULT_MULTIPLIER = 1.0;
const DEFAULT_NOISE_STRENGTH = 0.18;
const DEFAULT_EDGE_WIDTH = 0.16;
const FULL_OCEAN_MASK = 0.30;
const LAND_MASK = 0.58;
const BEACH_START_MASK = 0.50;
const BEACH_END_MASK = 0.56;
const DEEP_OCEAN_MASK = 0.08;

const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d", { alpha: false });
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
const qualitySelect = document.querySelector("#qualitySelect");

let compiled = [];
let config = DEFAULT_CONFIG;
let worldSeed = 0n;
let view = { x: 0, z: 0, blocksPerPixel: 8 };
let pointer = { down: false, x: 0, y: 0, startX: 0, startZ: 0 };
let renderQueued = false;
let renderExactNoise = false;

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
qualitySelect.addEventListener("change", requestRender);

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  jsonInput.value = await file.text();
  applyConfig();
  fitToIslands();
  fileInput.value = "";
});

canvas.addEventListener("pointerdown", (event) => {
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
  requestRender();
});

canvas.addEventListener("pointerup", (event) => {
  pointer.down = false;
  canvas.classList.remove("dragging");
  canvas.releasePointerCapture(event.pointerId);
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const before = screenToWorld(event.offsetX, event.offsetY);
  const factor = event.deltaY < 0 ? 0.82 : 1.22;
  view.blocksPerPixel = clamp(view.blocksPerPixel * factor, 1, 96);
  const after = screenToWorld(event.offsetX, event.offsetY);
  view.x += before.x - after.x;
  view.z += before.z - after.z;
  requestRender();
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

  return input.entries.map((entry, index) => {
    const path = `entries[${index}]`;
    const name = stringValue(entry.name, `island_${index + 1}`);
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
    return {
      name,
      overlap: Boolean(entry.overlap),
      centerX,
      centerZ,
      xDivisor: radiusX * stretchX,
      zDivisor: radiusZ * stretchZ,
      rotation,
      cos: Math.cos(radians),
      sin: Math.sin(radians),
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
    };
  });
}

function sampleMask(blockX, blockZ) {
  if (config.enabled === false) return 0;
  let union = 0;
  let additive = 0;
  for (const island of compiled) {
    const value = sampleIsland(island, blockX, blockZ);
    if (island.overlap) additive += value;
    else union = Math.max(union, value);
  }
  return clamp(Math.max(union, additive), 0, 1);
}

function sampleIsland(island, blockX, blockZ) {
  const dx = blockX - island.centerX;
  const dz = blockZ - island.centerZ;
  const rotatedX = dx * island.cos - dz * island.sin;
  const rotatedZ = dx * island.sin + dz * island.cos;
  const normalizedX = rotatedX / island.xDivisor;
  const normalizedZ = rotatedZ / island.zDivisor;
  const distance = Math.hypot(normalizedX, normalizedZ);
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

function requestRender() {
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
  const quality = pointer.down ? Math.min(requestedQuality, 0.30) : requestedQuality;
  renderExactNoise = requestedQuality >= 0.99 && !pointer.down;
  const width = Math.max(1, Math.floor(rect.width * quality));
  const height = Math.max(1, Math.floor(rect.height * quality));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.imageSmoothingEnabled = false;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let y = 0; y < height; y++) {
    const blockZ = view.z + (y / quality - rect.height / 2) * view.blocksPerPixel;
    for (let x = 0; x < width; x++) {
      const blockX = view.x + (x / quality - rect.width / 2) * view.blocksPerPixel;
      const value = sampleMask(blockX, blockZ);
      const color = colorForMask(value);
      const offset = (y * width + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  ctx.save();
  ctx.scale(quality, quality);
  drawOverlays(rect.width, rect.height);
  ctx.restore();

  zoomLabel.textContent = `1 px = ${formatNumber(view.blocksPerPixel)} blocks`;
  statsLabel.textContent = `${compiled.length} islands`;
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
  for (const island of compiled) {
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
  if (!compiled.length) {
    islandList.textContent = "No islands";
    return;
  }
  for (const island of compiled) {
    const item = document.createElement("button");
    item.className = "island-item";
    item.type = "button";
    item.innerHTML = `<span class="island-name">${escapeHtml(island.name)}</span><span class="island-meta">${Math.round(island.centerX)}, ${Math.round(island.centerZ)}</span><span class="island-meta">rx ${Math.round(island.xDivisor)} / rz ${Math.round(island.zDivisor)}</span><span class="island-meta">rot ${formatNumber(island.rotation)}</span>`;
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
  if (!compiled.length) {
    view = { x: 0, z: 0, blocksPerPixel: 8 };
    requestRender();
    return;
  }
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const island of compiled) {
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
