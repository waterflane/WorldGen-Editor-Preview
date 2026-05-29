let cachedKey = "";
let cachedConfig = null;
let cachedCompiled = [];
let cachedWorldSeed = 0n;

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
const DEEP_OCEAN_MASK = 0.08;
const SPATIAL_CELL_SIZE = 512;

self.onmessage = (event) => {
  const message = event.data;
  const started = performance.now();
  try {
    const { config, compiled } = getCompiled(message.configText, message.seedText);
    const data = new Uint8ClampedArray(message.width * message.height * 4);
    const exact = Boolean(message.exact);

    for (let y = 0; y < message.height; y++) {
      const blockZ = message.view.z + (y / message.quality - message.cssHeight / 2) * message.view.blocksPerPixel;
      for (let x = 0; x < message.width; x++) {
        const blockX = message.view.x + (x / message.quality - message.cssWidth / 2) * message.view.blocksPerPixel;
        const value = sampleMask(config, compiled, blockX, blockZ, exact);
        const color = colorForMask(value);
        const offset = (y * message.width + x) * 4;
        data[offset] = color[0];
        data[offset + 1] = color[1];
        data[offset + 2] = color[2];
        data[offset + 3] = 255;
      }
    }

    self.postMessage({
      id: message.id,
      width: message.width,
      height: message.height,
      cssWidth: message.cssWidth,
      cssHeight: message.cssHeight,
      quality: message.quality,
      exact,
      interactive: Boolean(message.interactive),
      view: message.view,
      elapsedMs: Math.round(performance.now() - started),
      buffer: data.buffer,
    }, [data.buffer]);
  } catch (error) {
    self.postMessage({ id: message.id, error: error.message || String(error) });
  }
};

function getCompiled(configText, seedText) {
  const key = `${seedText}\n${configText}`;
  if (key === cachedKey) {
    return { config: cachedConfig, compiled: cachedCompiled };
  }

  cachedKey = key;
  cachedConfig = JSON.parse(configText);
  cachedWorldSeed = parseSeed(seedText);
  cachedCompiled = parseConfig(cachedConfig, cachedWorldSeed);
  return { config: cachedConfig, compiled: cachedCompiled };
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

  input.entries.forEach((entry, index) => {
    const parsed = parseEntry(entry, index, seed);
    if (parsed.type === "archipelago") {
      const children = compileArchipelago(parsed, seed);
      compiledEntries.push(...children);
      landShapes.push(...children);
    } else {
      compiledEntries.push(parsed);
      if (parsed.type === "ocean") oceanShapes.push(parsed);
      else landShapes.push(parsed);
    }
  });

  compiledEntries.landShapes = landShapes;
  compiledEntries.oceanShapes = oceanShapes;
  compiledEntries.landGrid = buildSpatialGrid(landShapes);
  compiledEntries.oceanGrid = buildSpatialGrid(oceanShapes);
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

function sampleMask(config, compiled, blockX, blockZ, exact) {
  if (config.enabled === false) return 0;
  let union = 0;
  let additive = 0;
  const landCandidates = shapesNear(compiled, "land", blockX, blockZ);
  for (const island of landCandidates) {
    if (!containsPoint(island, blockX, blockZ)) continue;
    const value = sampleIsland(island, blockX, blockZ, exact);
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
    ocean = Math.max(ocean, sampleIsland(oceanShape, blockX, blockZ, exact));
  }
  return clamp(Math.min(land, 1 - ocean), 0, 1);
}

function sampleIsland(island, blockX, blockZ, exact) {
  const dx = blockX - island.centerX;
  const dz = blockZ - island.centerZ;
  const rotatedX = dx * island.cos - dz * island.sin;
  const rotatedZ = dx * island.sin + dz * island.cos;
  const normalizedX = rotatedX / island.xDivisor;
  const normalizedZ = rotatedZ / island.zDivisor;
  const distance = superellipseDistance(normalizedX, normalizedZ, island.shapePower ?? DEFAULT_SHAPE_POWER);
  const edgeNoise = normalizedNoise(island, normalizedX * island.noise.scale, normalizedZ * island.noise.scale, exact) * island.noiseStrength;
  const field = island.multiplier * (1 + edgeNoise) - distance;
  return smoothstep(-island.edgeWidth, island.edgeWidth, field);
}

function normalizedNoise(island, x, z, exact) {
  let sum = 0;
  let amplitudeSum = 0;
  let frequency = 2 ** island.noise.firstOctave;
  for (const amplitude of island.noise.amplitudes) {
    sum += interpolatedValueNoise(island, x * frequency, z * frequency, exact) * amplitude;
    amplitudeSum += amplitude;
    frequency *= 2;
  }
  return amplitudeSum === 0 ? 0 : sum / amplitudeSum;
}

function interpolatedValueNoise(island, x, z, exact) {
  const x0 = fastFloor(x);
  const z0 = fastFloor(z);
  const tx = smoothFraction(x - x0);
  const tz = smoothFraction(z - z0);
  const a = valueNoise(island, x0, z0, exact);
  const b = valueNoise(island, x0 + 1, z0, exact);
  const c = valueNoise(island, x0, z0 + 1, exact);
  const d = valueNoise(island, x0 + 1, z0 + 1, exact);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

function valueNoise(island, x, z, exact) {
  if (exact) {
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
  if (cached !== undefined) return cached;

  if (island.exactNoiseCache.size > 180000) {
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

function colorForMask(value) {
  if (value < DEEP_OCEAN_MASK) return [22, 63, 104];
  if (value < FULL_OCEAN_MASK) return [38, 118, 166];
  if (value < BEACH_START_MASK) return [62, 139, 174];
  if (value < LAND_MASK) return [216, 202, 142];
  if (value < 0.82) return [115, 167, 96];
  return [71, 123, 79];
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

function lerp(start, end, delta) {
  return start + (end - start) * delta;
}

function superellipseDistance(x, z, power) {
  return (Math.abs(x) ** power + Math.abs(z) ** power) ** (1 / power);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


