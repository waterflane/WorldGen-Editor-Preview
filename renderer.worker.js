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
const FULL_OCEAN_MASK = 0.30;
const LAND_MASK = 0.58;
const BEACH_START_MASK = 0.50;
const DEEP_OCEAN_MASK = 0.08;

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

function sampleMask(config, compiled, blockX, blockZ, exact) {
  if (config.enabled === false) return 0;
  let union = 0;
  let additive = 0;
  for (const island of compiled) {
    const value = sampleIsland(island, blockX, blockZ, exact);
    if (island.overlap) additive += value;
    else union = Math.max(union, value);
  }
  return clamp(Math.max(union, additive), 0, 1);
}

function sampleIsland(island, blockX, blockZ, exact) {
  const dx = blockX - island.centerX;
  const dz = blockZ - island.centerZ;
  const rotatedX = dx * island.cos - dz * island.sin;
  const rotatedZ = dx * island.sin + dz * island.cos;
  const normalizedX = rotatedX / island.xDivisor;
  const normalizedZ = rotatedZ / island.zDivisor;
  const distance = Math.hypot(normalizedX, normalizedZ);
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


