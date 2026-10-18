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

const {parseConfig, parseSeed, clamp, FULL_OCEAN_MASK, LAND_MASK, BEACH_START_MASK, DEEP_OCEAN_MASK}=WgeMask;
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
const biomeTooltip=document.querySelector("#biomeTooltip");
let lastBiomeMap=null;
let hoveredPoint=null;

const fallbackRenderer = WgeRenderer.create();
let compiled = [];
let config = DEFAULT_CONFIG;
let worldSeed = 0n;
let view = { x: 0, z: 0, blocksPerPixel: 8 };
let pointer = { down: false, x: 0, y: 0, startX: 0, startZ: 0 };
let renderQueued = false;
let renderExactNoise = true;
let appliedConfigText = "", appliedSeedText = "";
const mapSource = document.querySelector("#mapSource");
const heightMode = document.querySelector("#heightMode");
const reliefToggle = document.querySelector("#reliefToggle");
let backendAvailable = false;
let backendError = "Start the local Java preview and open its URL to view biomes";
let renderIdentity = "";
function updateModeControls(){
  const java=mapSource.value==="biomes";
  heightMode.disabled=!java;reliefToggle.disabled=!java||heightMode.value!=="surface";thresholdToggle.disabled=java;
}
updateModeControls();
for (const input of [mapSource,heightMode,reliefToggle]) input.addEventListener("change",()=>{updateModeControls();requestRender();});
if (location.protocol !== "file:") fetch("/api/info").then(r=>r.json()).then(info=>{
  backendAvailable=info.protocol===1&&info.minecraft==="1.21.1";
  if(!backendAvailable)backendError="Java preview version mismatch: expected protocol 1 / Minecraft 1.21.1";
  if(backendAvailable){mapSource.value="biomes";updateModeControls();requestRender();}
}).catch(()=>{});
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
  hoveredPoint=event.pointerType==="touch" ? null : {x:event.clientX,y:event.clientY};
  updateBiomeTooltip();
  if (!pointer.down) return;
  view.x = pointer.startX - (event.clientX - pointer.x) * view.blocksPerPixel;
  view.z = pointer.startZ - (event.clientY - pointer.y) * view.blocksPerPixel;
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
  hoveredPoint=null;
  biomeTooltip.hidden=true;
  canvas.classList.remove("dragging");
  endInteractionSoon();
});

canvas.addEventListener("pointerleave", () => {
  hoveredPoint=null;
  biomeTooltip.hidden=true;
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
    const nextDocument=JSON.parse(jsonInput.value);
    const nextConfig = WgeMask.readDocument(nextDocument).config;
    let seed = parseSeed(seedInput.value);
    if(seed===null){const bytes=crypto.getRandomValues(new Uint32Array(2));seed=BigInt.asIntN(64,(BigInt(bytes[0])<<32n)|BigInt(bytes[1]));seedInput.value=seed.toString();}
    const nextCompiled = parseConfig(nextConfig, seed);
    config=nextConfig;worldSeed=seed;compiled=nextCompiled;
    appliedConfigText=JSON.stringify(nextDocument);appliedSeedText=seed.toString();
    renderIslandList();
    setState(config.enabled === false ? "disabled" : "ready", false);
    requestRender();
  } catch (error) {
    setState(error.message, true);
  }
}

function beginInteraction() {
  isInteracting = true;
  biomeTooltip.hidden=true;
  clearTimeout(idleRenderTimer);
}

function endInteractionSoon() {
  clearTimeout(idleRenderTimer);
  idleRenderTimer = setTimeout(() => {
    isInteracting = false;
    updateBiomeTooltip();
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
    if(isInteracting)drawDragPreview();
    render();
  });
}

function render() {
  const identity=[appliedConfigText,appliedSeedText,mapSource.value,heightMode.value].join("\n");
  if(identity!==renderIdentity){renderIdentity=identity;clearRenderedMap();}
  const rect = canvas.getBoundingClientRect();
  const requestedQuality = Number(qualitySelect.value) || 0.65;
  const interactive = renderMode === "interactive" || isInteracting;
  const quality = requestedQuality;
  const samplingQuality = interactive ? Math.min(0.20, requestedQuality) : requestedQuality;
  renderExactNoise = true;
  const cssWidth = Math.max(1, Math.floor(rect.width));
  const cssHeight = Math.max(1, Math.floor(rect.height));
  const width = Math.max(1, Math.floor(cssWidth * quality));
  const height = Math.max(1, Math.floor(cssHeight * quality));
  const resized = ensureCanvasSize(cssWidth, cssHeight);
  if (resized) {
    drawDragPreview();
  }

  setState(mapSource.value === "biomes" ? "rendering biomes" : "rendering mask",false);
  if (renderWorker) {
    queueWorkerRender({
      id: ++renderSequence,
      configText: appliedConfigText,
      seedText: appliedSeedText,
      view: { ...view },
      width,
      height,
      cssWidth,
      cssHeight,
      quality,
      samplingQuality,
      exact: true,
      shores: thresholdToggle.checked,
      source: mapSource.value,
      heightMode: heightMode.value,
      relief: reliefToggle.checked,
      backendAvailable,
      backendError,
      interactive,
    });
    return;
  }

  renderOnMainThread(width, height, cssWidth, cssHeight, quality, renderExactNoise, samplingQuality, interactive);
}

function queueWorkerRender(message) {
  latestRenderSequence=message.id;
  workerBusy=true;
  renderWorker.postMessage(message);
}

function handleWorkerMessage(event) {
  const message = event.data;
  workerBusy = false;

  if (message.id === latestRenderSequence) {
    if (message.error) {
      clearRenderedMap();
      setState(message.error, true);
    } else {
      lastRenderElapsedMs = message.elapsedMs;
      lastBiomeMap=message.biomesBuffer ? {...message,indices:new Uint16Array(message.biomesBuffer),heights:new Int16Array(message.heightsBuffer)} : null;
      setState(message.interactive ? "refining" : "ready",false);
      ensureCanvasSize(message.cssWidth, message.cssHeight);
      drawScaledMap(new ImageData(new Uint8ClampedArray(message.buffer), message.width, message.height), message.cssWidth, message.cssHeight, message.view);
      updateBiomeTooltip();
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


function renderOnMainThread(width,height,cssWidth,cssHeight,quality,exact,samplingQuality=quality,interactive=false) {
  const message={id:++renderSequence,configText:appliedConfigText,seedText:appliedSeedText,view:{...view},width,height,cssWidth,cssHeight,quality,
    exact:true,shores:thresholdToggle.checked,source:mapSource.value,heightMode:heightMode.value,relief:reliefToggle.checked,backendAvailable,backendError,samplingQuality,interactive};
  latestRenderSequence=message.id;
  fallbackRenderer.cancel(message.id);
  const active=()=>message.id===latestRenderSequence;
  void(async()=>{
    let preview;
    if(message.source==="biomes"&&!interactive){
      preview=await fallbackRenderer.render({...message,samplingQuality:Math.min(message.quality,32/Math.max(cssWidth,cssHeight))},active);
      if(preview&&active())handleWorkerMessage({data:{...preview,interactive:true}});
    }
    const result=await fallbackRenderer.render(message,active,{preview,onProgress:frame=>{if(active())handleWorkerMessage({data:frame});}});
    if(result&&active())handleWorkerMessage({data:result});
  })().catch(error=>{if(active()){clearRenderedMap();setState(error.message,true);}});
}

function clearRenderedMap(){
  lastBiomeMap=null;lastRenderedView=null;lastRenderedSize=null;
  biomeTooltip.hidden=true;statsLabel.textContent="Awaiting map data";
  coords.textContent=`x ${formatNumber(view.x)}, z ${formatNumber(view.z)}`;
  fillPreviewBackground();
}

function updateBiomeTooltip(){
  biomeTooltip.hidden=true;
  if(!hoveredPoint || !lastBiomeMap || pointer.down || isInteracting ||
      lastRenderedView?.x!==view.x || lastRenderedView?.z!==view.z ||
      lastRenderedView?.blocksPerPixel!==view.blocksPerPixel)return;
  const rect=canvas.getBoundingClientRect();
  const x=hoveredPoint.x-rect.left,y=hoveredPoint.y-rect.top;
  if(x<0 || y<0 || x>=rect.width || y>=rect.height)return;
  const px=Math.floor(x/rect.width*lastBiomeMap.width),py=Math.floor(y/rect.height*lastBiomeMap.height);
  const id=lastBiomeMap.palette[lastBiomeMap.indices[py*lastBiomeMap.width+px]];
  if(!id)return;
  biomeTooltip.textContent=id.replace(/^minecraft:/,"").replaceAll("_"," ");
  biomeTooltip.hidden=false;
  const width=biomeTooltip.offsetWidth,height=biomeTooltip.offsetHeight;
  const left=x+14+width<=rect.width-8 ? x+14 : x-width-14;
  const top=y+18+height<=rect.height-8 ? y+18 : y-height-14;
  biomeTooltip.style.left=`${Math.max(8,left)}px`;
  biomeTooltip.style.top=`${Math.max(8,top)}px`;
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

function drawBufferedMap(offsetX, offsetY, scale = 1) {
  if (!lastRenderedSize || renderBufferCanvas.width <= 0 || renderBufferCanvas.height <= 0) {
    return;
  }

  ctx.imageSmoothingEnabled = false;
  fillPreviewBackground();
  ctx.drawImage(renderBufferCanvas, offsetX, offsetY, lastRenderedSize.cssWidth * scale, lastRenderedSize.cssHeight * scale);
}

function fillPreviewBackground() {
  ctx.fillStyle = "#30353c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawDragPreview() {
  if (!lastRenderedView || !lastRenderedSize) {
    fillPreviewBackground();
    drawPostRenderOverlays();
    return;
  }

  const scale = lastRenderedView.blocksPerPixel / view.blocksPerPixel;
  const offsetX = (canvas.width - lastRenderedSize.cssWidth * scale) / 2 + (lastRenderedView.x - view.x) / view.blocksPerPixel;
  const offsetY = (canvas.height - lastRenderedSize.cssHeight * scale) / 2 + (lastRenderedView.z - view.z) / view.blocksPerPixel;
  drawBufferedMap(offsetX, offsetY, scale);
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
  renderExactNoise = true;
  ctx.save();
  drawOverlays(canvas.width, canvas.height);
  ctx.restore();
  renderExactNoise = previousExact;
}

function updateRenderLabels(exact, engine, interactive) {
  zoomLabel.textContent = `1 px = ${formatNumber(view.blocksPerPixel)} blocks`;
  const structures = (compiled.sourceSummaries || compiled).length;
  const childCount = compiled.length - structures;
  const quality = mapSource.value === "biomes" ? "biomes" : "exact mask";
  const sampling=lastBiomeMap ? ` | sample ${lastBiomeMap.sampleStep} blocks${lastBiomeMap.targetStep ? ` → ${lastBiomeMap.targetStep}` : ""}` : "";
  statsLabel.textContent = `${structures} structures${childCount > 0 ? ` / ${childCount} child islands` : ""} | ${quality} ${engine} ${lastRenderElapsedMs} ms${sampling}`;
}

function drawOverlays(width, height) {

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

function gridStep(blocksPerPixel) {
  const target = blocksPerPixel * 110;
  const power = 10 ** Math.floor(Math.log10(target));
  const normalized = target / power;
  if (normalized < 2) return power;
  if (normalized < 5) return power * 2;
  return power * 5;
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








if(new URLSearchParams(location.search).has("profile") && typeof PerformanceObserver!=="undefined") {
  try { new PerformanceObserver(list=>{for(const entry of list.getEntries())console.info(`WGE UI longtask ${entry.duration.toFixed(1)} ms`);}).observe({type:"longtask",buffered:true}); } catch {}
}
