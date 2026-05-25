# WorldGen Editor Preview

WorldGen Editor Preview is a developer companion tool for the Minecraft mod [waterflane/WorldGen-Editor](https://github.com/waterflane/WorldGen-Editor).

It is a static preview tool for `continents.json`, made to help modpack and worldgen developers tune island layouts before generating test worlds in Minecraft.

Open `index.html` in a browser and load JSON with `Open JSON`, or edit the text directly in the left panel and press `Apply JSON`.

## What It Shows

- island shapes using the same mask algorithm as the mod;
- deep ocean, ocean, shore, land, and core zones;
- island centers, coordinate grid, zoom, and pan;
- quality modes for fast editing, balanced inspection, or exact final coastline checks;
- quick island focus from the list;
- loading and downloading `continents.json`.

## Important

This is an island mask preview, not a full Minecraft worldgen simulation. It does not simulate vanilla terrain, surface rules, structures, caves, or biome features. Its job is to quickly check size, position, rotation, roughness, and shape seed without creating new worlds over and over.

## License

WorldGen Editor Preview is licensed under the MIT License. See [LICENSE.txt](LICENSE.txt).
