# Testing Floor CLI

Small Node CLI for uploading game artifacts to Testing Floor.

It currently handles two artifact types: **builds** (ready-to-run game uploads, either zip or wharf delta) and **maps** (top-down level images plus their world-space bounds, used to render heatmaps and event overlays).

## Install

From this local checkout:

```sh
npm install -g .
```

Or run without installing:

```sh
node bin/testingfloor.js upload-build --help
```

## Single Build

```sh
export TESTING_FLOOR_API_TOKEN="tf_..."

testingfloor upload-build \
  --api-url https://testingfloor.com \
  --game-id 42 \
  --platform windows \
  --archive ./Builds/game-windows.zip \
  --version 0.4.12 \
  --git-sha "$(git rev-parse HEAD)" \
  --launch-path Game.exe
```

The API token must belong to a user, include the `builds:create` scope, and the user must be able to manage games for the target game's organization.

## Delta Builds

Use `archiveKind: "wharf"` or `--archive-kind wharf` to upload a wharf patch and signature instead of a full zip. The CLI asks Testing Floor for the latest base signature for the platform, runs `butler diff`, uploads `patch.pwr` plus `patch.pwr.sig`, and Testing Floor materializes the full fallback archive server-side.

```sh
testingfloor upload-build \
  --game-id 42 \
  --platform windows \
  --archive ./Builds/Windows \
  --archive-kind wharf \
  --butler-path butler \
  --filename game-windows.zip \
  --version 0.4.12 \
  --launch-path Game.exe
```

If no previous signature exists, the CLI uses butler's empty-container target for the first upload. `--archive` may point at a build directory or an archive that butler can read.

## Multiple Platforms

Create `testingfloor-builds.json`:

```json
{
  "gameId": 42,
  "version": "0.4.12",
  "gitSha": "abc123",
  "builds": [
    {
      "platform": "windows",
      "archive": "./Builds/game-windows.zip",
      "launchPath": "Game.exe"
    },
    {
      "platform": "macos",
      "archive": "./Builds/game-macos.zip",
      "launchPath": "Game.app"
    },
    {
      "platform": "linux",
      "archive": "./Builds/game-linux.zip",
      "launchPath": "Game.x86_64"
    }
  ]
}
```

Then run:

```sh
testingfloor upload-build --config testingfloor-builds.json
```

Archive paths in a config file are resolved relative to that config file.

## GitHub Actions

Use this repository directly as a GitHub Action:

```yaml
- name: Upload build to Testing Floor
  uses: capitalisminc/testingfloor-cli@main
  with:
    api-token: ${{ secrets.TF_BUILD_UPLOAD_TOKEN }}
    game-id: ${{ vars.TF_GAME_ID }}
    platform: windows
    build-directory: build/Mono/Release/${{ matrix.platform }}
    launch-path: Game.exe
    version: ${{ matrix.version }}
    git-sha: ${{ github.sha }}
    source-ref: |
      {
        "build_environment": "${{ matrix.build_environment }}",
        "scripting_backend": "Mono",
        "unity_platform": "${{ matrix.platform }}"
      }
```

The action accepts either `archive` or `build-directory`. When `build-directory` is supplied, the action creates a ZIP64 archive in Node before upload, without relying on runner-provided zip, tar, or PowerShell tooling.

For delta uploads, set `archive-kind: wharf`. The action passes `build-directory` directly to butler instead of zipping it first.

You can also run the CLI directly:

```yaml
- name: Upload builds to Testing Floor
  env:
    TESTING_FLOOR_API_TOKEN: ${{ secrets.TESTING_FLOOR_API_TOKEN }}
    TESTING_FLOOR_VERSION: ${{ github.ref_name }}
    TESTING_FLOOR_GIT_SHA: ${{ github.sha }}
  run: |
    npx @testingfloor/cli upload-build \
      --config testingfloor-builds.json \
      --source-ref run_id=${{ github.run_id }} \
      --source-ref run_number=${{ github.run_number }}
```

When `GITHUB_ACTIONS=true`, the CLI also includes basic GitHub metadata in `source_ref`.

## Maps

A "map" is a top-down image of a level plus its world-space bounds. Testing Floor uses it to render heatmaps and event overlays in the analytics workspace. Your editor tooling renders the PNG and reports the bounds; this CLI ships them to Testing Floor.

The API token must include the `maps:sync` scope.

### Single Map

```sh
export TESTING_FLOOR_API_TOKEN="tf_..."

testingfloor upload-map \
  --game-id 42 \
  --level-id factory \
  --image ./Builds/maps/factory.png \
  --bounds 0,0,200,200 \
  --app-version 0.4.12
```

`--bounds` is `center_x,center_z,size_x,size_z` in world units. `--app-version` is optional and pins the upload to a specific app version, so prior captures stay viewable when geometry changes between releases.

### Multiple Maps

Create `testingfloor-maps.json`:

```json
{
  "gameId": 42,
  "appVersion": "0.4.12",
  "maps": [
    {
      "levelId": "factory",
      "image": "./Builds/maps/factory.png",
      "bounds": { "centerX": 0, "centerZ": 0, "sizeX": 200, "sizeZ": 200 }
    },
    {
      "levelId": "warehouse",
      "image": "./Builds/maps/warehouse.png",
      "bounds": { "centerX": 50, "centerZ": -10, "sizeX": 128, "sizeZ": 128 }
    }
  ]
}
```

Then:

```sh
testingfloor upload-map --config testingfloor-maps.json
```

Image paths in a config file are resolved relative to that config file.

### GitHub Action

```yaml
- name: Upload map to Testing Floor
  uses: capitalisminc/testingfloor-cli/upload-map@main
  with:
    api-token: ${{ secrets.TF_MAPS_TOKEN }}
    game-id: ${{ vars.TF_GAME_ID }}
    level-id: factory
    image: build/maps/factory.png
    bounds: "0,0,200,200"
    app-version: ${{ github.ref_name }}
```

You can also pass bounds as four scalar inputs (`bounds-center-x`, `bounds-center-z`, `bounds-size-x`, `bounds-size-z`) if that's easier to wire up in your workflow.

### Other engines

Any engine that produces a top-down PNG can call the CLI as a subprocess. From a Unity editor script, for example:

```csharp
var psi = new ProcessStartInfo("testingfloor", $"upload-map --game-id 42 --level-id {level} --image \"{pngPath}\" --bounds {bounds} --app-version {Application.version}") {
    UseShellExecute = false,
};
psi.EnvironmentVariables["TESTING_FLOOR_API_TOKEN"] = token;
Process.Start(psi);
```

## Config Fields

Top-level:

- `apiUrl`: Testing Floor base URL. Defaults to `https://testingfloor.com`.
- `gameId`: numeric Testing Floor game id.
- `version`: version metadata. Required by the API.
- `gitSha`: optional git SHA metadata.
- `sourceRef`: optional JSON object stored with the build.
- `builds`: array of platform build objects.

Build object:

- `platform`: `windows`, `macos`, or `linux`.
- `archive`: zip file to upload.
- `launchPath`: executable path inside the extracted archive.
- `launchArgs`: optional array, defaults to `[]`.
- `workingDirectory`: optional extracted-archive working directory, defaults to `"."`.
- `filename`: optional server-visible archive filename.
- `archiveKind`: `zip` or `wharf`. `wharf` requires butler.
- `butlerPath`: optional path to the butler executable, defaults to `butler`.

Map config top-level:

- `gameId`, `apiUrl`, `token`: same as builds.
- `appVersion`: app version pinned to every map in the file. Per-map values override.
- `maps`: array of map objects.

Map object:

- `levelId`: level identifier (must match the value the game emits in telemetry).
- `image`: PNG, JPG, or WEBP path. Relative paths resolve from the config file's directory.
- `bounds`: object with `centerX`, `centerZ`, `sizeX`, `sizeZ` — or a `"cx,cz,sx,sz"` string.
- `horizontalAxis`, `verticalAxis`: world axes (`x`, `y`, `z`). Default to `x`/`z`. Must differ.
- `appVersion`: optional override of the top-level `appVersion`.

## Environment

- `TESTING_FLOOR_API_TOKEN`
- `TESTING_FLOOR_API_URL`
- `TESTING_FLOOR_GAME_ID`
- `TESTING_FLOOR_VERSION`
- `TESTING_FLOOR_GIT_SHA`
- `TESTING_FLOOR_BUTLER_PATH`

CLI flags override environment and config values.
