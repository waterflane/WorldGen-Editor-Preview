# WorldGen Editor Preview

Companion map editor for [WorldGen Editor](https://github.com/waterflane/WorldGen-Editor), Minecraft 1.21.1 / NeoForge.

## Two map modes

- **Island mask (offline):** open `index.html`. All quality levels use the same deterministic 64-bit noise; quality changes sampling density. Mask colors are not a prediction of Minecraft terrain or biome IDs.
- **Minecraft biomes (Java):** run the local preview engine, then use its HTTP URL. This samples the same Java generation core, Minecraft noises and block-level biome boundary refinement as the mod.

The exact engine currently supports Minecraft + WGE, without loading third-party biome mods.
The default height mode is **Base surface**. Optional relief shading reuses the calculated heights. Y=300/64/0/-32 show actual slices, which can differ from surface biomes.
Rivers use their biome colors. Feature-generated lakes, structures, trees and other decoration are outside this base-generation preview.
The legend lists visible biomes; hovering the map displays the sampled biome ID and Y. The status shows sampling distance: overview pixels represent a grid, and one-block sampling is required for detailed boundaries.

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
A disabled or empty offline mask is displayed neutrally, because the real mod delegates to vanilla in that case.

Rendering uses a bounded world-space tile cache, a coarse first pass for Java maps, and cancellation of obsolete work. Dragging reuses the last image while new tiles arrive. Reopening an area reuses computed results.
Zooming immediately scales the last image while the new view is computed. Changing seed, configuration or height mode clears the old map; a Java error is displayed instead of presenting old pixels as a new result.

## Tests

Node.js 20+:

```powershell
node --test tests/mask.test.cjs
node tests/benchmark.cjs
```

Keep the mod repository beside this one for the Java golden fixtures, or provide their path with `WGE_FIXTURES`.
The mod repository contains real NeoForge GameTests for biome/base-height parity and a separate TerraBlender verification.

## License

MIT; see [LICENSE.txt](LICENSE.txt).
