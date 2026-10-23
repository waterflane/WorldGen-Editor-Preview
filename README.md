# WorldGen Editor Preview

Companion map editor for [WorldGen Editor](https://github.com/waterflane/WorldGen-Editor), Minecraft 1.21.1 / NeoForge.

## Two map modes

- **Island mask (offline):** open `index.html`. All quality levels use the same deterministic 64-bit noise; quality changes sampling density. Mask colors are not a prediction of Minecraft terrain or biome IDs.
- **Minecraft biomes (Java):** run the local preview engine, then use its HTTP URL. This samples the same Java generation core, Minecraft noises and block-level biome boundary refinement as the mod.

The exact engine currently supports Minecraft + WGE, without loading third-party biome mods.
The default height mode is **Base surface**. Optional relief shading reuses the calculated heights. Y=300/64/0/-32 show actual slices, which can differ from surface biomes.
Rivers use their biome colors. Feature-generated lakes, structures, trees and other decoration are outside this base-generation preview.
Hovering the map shows a small tooltip with the sampled biome name. The status shows sampling distance: overview pixels represent a grid, and one-block sampling is required for detailed boundaries.

## Start the Java map

Install Java 21+ and keep the repositories side by side:

```text
WorldGen Editor/
WorldGen Editor Preview/
```

Prepare the runtime from the mod repository:

```powershell
.\gradlew.bat :preview-engine:preparePreview --no-daemon
```

Then, from this repository:

```powershell
.\start-preview.ps1
```

The script uses the Java installation recorded during preparation unless `-JavaHome` is supplied. To rebuild after changing Java sources, use `-Prepare`.
Open [the local map](http://127.0.0.1:8765/) after startup. The process binds only to loopback and defaults to a 512 MiB heap. It has no game window, world ticking or chunk save directory.
JREs and Minecraft client assets are not bundled; the required server runtime is prepared into the local Gradle cache.

## Editing and reproducibility

Open a `presets/*.json` file or the pinned `<world>/worldgen_editor/worldgen_editor.json` snapshot. The small global config that only selects `active_preset` is not an island layout.
Click **Apply JSON** to commit edits to the preview. Invalid text leaves the last valid configuration in use. World snapshots retain their generation version and per-world enable flag.
Enter the world's `/seed` value. Text seeds follow Minecraft's rules; a blank seed generates and displays a concrete random seed.
A disabled or legacy empty offline mask is displayed neutrally. An explicitly painted version 3 map with no painted land starts as ocean.

## Island map editor

The **Редактор карты** tab shares the preview's navigation and document. Start with **Новый океан**, use **Из пресета превью**, or open a project/preset. **Суша** and **Океан** replace each other; brush radius and shore roughness are adjustable. Roughness is baked into the mask, so changing the world seed does not move a painted coast.

- Left drag paints a continuous stroke. Middle drag or Space + drag pans; the wheel zooms.
- Each stroke is one undo action. Use the buttons or Ctrl+Z / Ctrl+Shift+Z.
- **Применить к точному превью** updates the exact Minecraft + WGE map. Drawing never starts Java generation. Unapplied changes are shown explicitly.
- **Сохранить проект** downloads a versioned `.wge.json` with seed, procedural base, paint and editor settings. **Экспорт пресета** downloads a self-contained `custom_map.json`; use the displayed numeric seed when creating a new **WGE: Custom Map (v3)** world. Copy the preset into `config/worldgen_editor/presets/custom_map.json` first.
- IndexedDB keeps a recoverable local draft after edits. Use **Восстановить черновик** after reopening. Opening a clean document does not overwrite the recovery draft. Unsaved work triggers a navigation warning.

Brush computation, validation and serialization run in workers. Only affected painted tiles are updated during a stroke; cached areas remain visible while panning/zooming. Large painted payloads stay separate from the main JSON text editor: it shows editable parameters, and **Download** includes the entire last applied preset. An explicit button removes the linked painted layer. Invalid imports leave the current document intact.

Limits: 4-block grid, 64×64 samples/tile, 4096 sparse tiles, Minecraft coordinate bounds, 32 MiB per imported/exported file. Undo is bounded to 100 strokes and 32 MiB; a single stroke beyond the history limit is rolled back with an error. History is not exported. The first editor controls only land/ocean; biome, height, river and structure tools are outside this version.

The Java API uses protocol 2 and advertises generation versions 1/2/3 and painted-map support. Update both repositories and prepare the runtime after Java changes. Exact preview has separate caches/revisions from the editor draft and supports **Minecraft + WGE** only, including when the exported map will be used in a modded world.

Rendering uses bounded world-space tile caches, a coarse first pass for Java maps, and cancellation of obsolete work. While dragging or scrolling, the UI immediately draws cached tile images, including areas outside the last viewport, without starting generation. Releasing a drag starts generation immediately; wheel bursts settle for 120 ms first. Previously loaded detail stays visible throughout refinement. Each image and sample cache retains up to 8192 tiles in memory.
**Balanced** is selected by default and uses up to 256 samples along the longer side; **Fast** uses up to 128. **Full exact** removes the overview sample cap and follows the window's pixel resolution (one-block sampling when fully zoomed in). More detail requires more Java samples. Finished tiles progressively replace the coarse map, starting near the center, while the remaining area continues to refine.
Zooming immediately recomposes cached tiles at the new scale. Changing seed, configuration, height mode or shading clears the old images; a Java error is displayed instead of presenting old pixels as a new result.
Loaded tiles keep their world coordinates and sampling level across zoom changes. Detailed terrain remains visible when zooming out, including during the initial coarse pass; coarser tiles cannot overwrite it. Coarse samples are derived from fine tiles where possible, and returning to a cached area avoids Java requests. The in-memory cache is bounded to 8192 tiles and lasts until the page is reloaded or the configuration changes.
The browser requests 16x16-sample tiles and follows the Java engine's advertised concurrency, with at most six visible tiles in flight. The engine reserves two logical processors when possible, uses fewer workers on smaller machines, and cancels obsolete work between samples. Surface mode uses exact base heights wherever biome selection depends on Y. In a proven constant ocean area, with relief disabled, the engine can select the exact biome without calculating a height. All four possible X/Z corners of Minecraft's biome boundary refinement must agree. Shores, standard-climate ocean variations and other uncertain cases retain the height calculation.

Enabling relief requests every base height and uses a separate tile-cache group; biome-only tiles cannot supply missing heights to shading. The engine reuses compiled density graphs for independent samplers, evaluates the original interpolation at query points and retains Minecraft aquifers. No terrain resolution or generation version changes. Fixed Y slices still sample their displayed Y directly.

Both passes stream completed tiles, including the very first coarse tile; unfinished areas stay neutral and have no biome tooltip. The HUD reports elapsed time for the entire browser render request (coarse pass, refinement, HTTP and worker communication), plus the time to its first frame. It does not report only the last Java tile or only the refinement pass. Startup is separate. Large uncached surface views still require many exact columns; sub-second API microbenchmarks do not imply a sub-second complete map.

All 64 Minecraft 1.21.1 biomes have distinct map colors, including ocean temperatures, forest variants, cherry groves and caves. Unknown registry IDs receive stable saturated colors based on their full namespaced ID. Hover over the map to see the biome name; unavailable data stays neutral without a tooltip. These colors are for map readability and do not change biome selection.

For a reproducible whole-view worker/API measurement, run `node tools/benchmark_viewport.cjs [config.json] [seed]` from the adjacent mod repository. It reports first tile, first frame, complete coarse and detailed passes, HTTP latency percentiles, cached redraw time and checksums. Set `WGE_BENCH_FORCE_HEIGHTS=1` to request all heights without shading, for comparison with the original path. Use a fresh Java process for a cold run and avoid creating other sessions during the benchmark. The mod repository's `tools/column-performance.json` records whole-view and one-block comparisons with the preceding implementation.

## Tests

Node.js 20+:

```powershell
node --test tests/*.test.cjs
node tests/benchmark.cjs
node tests/editor-benchmark.cjs
```

Keep the mod repository beside this one for the Java golden fixtures, or provide their path with `WGE_FIXTURES`.
The mod repository contains real NeoForge GameTests for biome/base-height parity and a separate TerraBlender verification.
The editor benchmark measures worker-model computation and serialization, not browser presentation. Browser canvas diagnostics `data-first-brush-frame-ms` measure the first actual brush draw; `?profile=1` logs main-thread tasks over 50 ms. Recorded results and the pinned mod compatibility matrix live in the mod repository's `docs/` and `tools/`.

## License

MIT; see [LICENSE.txt](LICENSE.txt).
