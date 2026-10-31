# Testing Floor CLI

Small Node CLI for uploading game artifacts to Testing Floor.

It currently handles two artifact types: **builds** (ready-to-run game folders) and **maps** (top-down level images plus their world-space bounds, used to render heatmaps and event overlays).

## Install

From this local checkout:

```sh
npm install -g .
```

Or run without installing:

```sh
node bin/testingfloor.js upload-build --help
```

## Sign in

On your own computer, sign in with your browser:

```sh
testingfloor login
```

The CLI shows a code and opens a Testing Floor page where you approve it. After you approve, it saves a token for this computer, and later commands use it. To print the link without opening a browser (for example, over SSH), add `--no-browser`. Use `--api-url` or `TESTING_FLOOR_API_URL` to sign in to a different Testing Floor server.

`testingfloor whoami` shows who is signed in. `testingfloor logout` deletes the saved token from this computer. Signing in again replaces the saved login.

In CI, don't sign in. Store an API token as a secret and pass it as `TESTING_FLOOR_API_TOKEN`, with `--token`, or as the GitHub Action's `api-token` input.

Commands use the first token they find: `--token`, then `TESTING_FLOOR_API_TOKEN`, then `token` in a `--config` file, then the saved login. The saved login is only sent to the API URL it was issued for.

The login is saved in `credentials.json`, which only you can read, in `$XDG_CONFIG_HOME/testingfloor` (by default `~/.config/testingfloor`), or in `%APPDATA%\testingfloor` on Windows. Set `TESTING_FLOOR_CONFIG_DIR` to keep it in a different folder.

## Single Build

```sh
export TESTING_FLOOR_API_TOKEN="tf_..."

testingfloor upload-build \
  --api-url https://api.testingfloor.com \
  --organization-id gamedepartment \
  --game-id 42 \
  --platform windows \
  --build-directory ./Builds/Windows \
  --filename game-windows.zip \
  --version 0.4.12 \
  --git-sha "$(git rev-parse HEAD)" \
  --launch-path Game.exe
```

The API token must belong to a user, include the `builds:create` scope, and the user must be able to manage games for the target game's organization.

Add `--description "Fixes input and updates the tutorial"` to include an optional plain text description of up to 1,000 characters. Line breaks are preserved. The description appears only in the website's build list. You can also set `TESTING_FLOOR_DESCRIPTION`, or add `description` at the top level of a build config file. A build's own `description` overrides that shared value; an empty string clears it for that build.

## How builds are uploaded

You point the CLI at the ready-to-run build folder; there's nothing else to choose. Each upload:

1. Diffs the folder against the platform's previous build with `butler` and uploads the wharf patch. The desktop recorder updates testers' installs from it. The GitHub Action installs butler for you; when running the CLI directly, put `butler` on `PATH` or pass `--butler-path`.
2. Splits the folder into content-addressed chunks of about 3 MiB. Boundaries follow the content, so an edit inside a large file only changes the chunks around it. Files under 256 KiB are packed together.
3. Asks Testing Floor which chunks the game hasn't stored yet, and uploads only those.
4. Sends the manifest (every folder, file and symlink with its permissions and checksum) and waits until Testing Floor has verified the chunks.
5. Completes the build, which makes it available to testers. Testing Floor serves its zip download (named by `--filename`) and the desktop recorder's fresh installs straight from the verified chunks. If the chunks fail, the build is still completed so the recorder can install it from its patch, and the upload fails.

The first upload sends the whole build, uncompressed; later builds send only what changed.

Requests that are safe to repeat are retried when the connection drops or Testing Floor answers with a server error: chunk uploads, the chunk and manifest requests, and status checks. Waiting for verification keeps going through failed checks until its 45-minute limit. Creating and completing a build aren't retried, because repeating them could make a second build or fail on one that already finished.

## Multiple Platforms

Create `testingfloor-builds.json`:

```json
{
  "organizationId": "gamedepartment",
  "gameId": 42,
  "version": "0.4.12",
  "gitSha": "abc123",
  "builds": [
    {
      "platform": "windows",
      "buildDirectory": "./Builds/Windows",
      "filename": "game-windows.zip",
      "launchPath": "Game.exe"
    },
    {
      "platform": "macos",
      "buildDirectory": "./Builds/macOS",
      "filename": "game-macos.zip",
      "launchPath": "Game.app"
    },
    {
      "platform": "linux",
      "buildDirectory": "./Builds/Linux",
      "filename": "game-linux.zip",
      "launchPath": "Game.x86_64"
    }
  ]
}
```

Then run:

```sh
testingfloor upload-build --config testingfloor-builds.json
```

Build directories in a config file are resolved relative to that config file.

## GitHub Actions

Use this repository directly as a GitHub Action:

```yaml
- name: Upload build to Testing Floor
  uses: capitalisminc/testingfloor-cli@main
  with:
    api-token: ${{ secrets.TF_BUILD_UPLOAD_TOKEN }}
    organization-id: ${{ vars.TF_ORGANIZATION_ID }}
    game-id: ${{ vars.TF_GAME_ID }}
    platform: windows
    build-directory: build/Mono/Release/${{ matrix.platform }}
    launch-path: Game.exe
    version: ${{ matrix.version }}
    description: "Fixes input and updates the tutorial"
    git-sha: ${{ github.sha }}
    source-ref: |
      {
        "build_environment": "${{ matrix.build_environment }}",
        "scripting_backend": "Mono",
        "unity_platform": "${{ matrix.platform }}"
      }
```

`build-directory` is the ready-to-run build folder; see [How builds are uploaded](#how-builds-are-uploaded). Butler is installed automatically. Use `butler-path` or `butler-version` only when you need to override that.

The old `archive` and `archive-kind` inputs are no longer used. `archive-kind` only produces a warning and can be deleted; `archive` (a zip file) fails, because only a folder can be uploaded as chunks.

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
  --organization-id gamedepartment \
  --game-id 42 \
  --level-id factory \
  --image ./Builds/maps/factory.png \
  --bounds 0,0,200,200 \
  --app-version 0.4.12 \
  --variant-key ground-floor \
  --default-variant true
```

`--bounds` is `center_x,center_z,size_x,size_z` in world units. `--app-version` is optional telemetry metadata that lets Testing Floor match maps to captures from the same game build. Use `--variant-key` for alternate floors, view modes, or other same-version map variants. Use `--map-version` when you need to update a specific telemetry map version instead of letting the server choose the current version. Mark one variant with `--default-variant true` when it should be the default view for that level/version.

### Multiple Maps

Create `testingfloor-maps.json`:

```json
{
  "organizationId": "gamedepartment",
  "gameId": 42,
  "appVersion": "0.4.12",
  "mapVersion": 3,
  "maps": [
    {
      "levelId": "factory",
      "image": "./Builds/maps/factory.png",
      "bounds": { "centerX": 0, "centerZ": 0, "sizeX": 200, "sizeZ": 200 },
      "variantKey": "ground-floor",
      "defaultVariant": true
    },
    {
      "levelId": "warehouse",
      "image": "./Builds/maps/warehouse.png",
      "bounds": { "centerX": 50, "centerZ": -10, "sizeX": 128, "sizeZ": 128 },
      "variantKey": "roof"
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
    organization-id: ${{ vars.TF_ORGANIZATION_ID }}
    game-id: ${{ vars.TF_GAME_ID }}
    level-id: factory
    image: build/maps/factory.png
    bounds: "0,0,200,200"
    app-version: ${{ github.ref_name }}
    variant-key: ground-floor
    default-variant: "true"
```

You can also pass bounds as four scalar inputs (`bounds-center-x`, `bounds-center-z`, `bounds-size-x`, `bounds-size-z`) if that's easier to wire up in your workflow.

### Other engines

Any engine that produces a top-down PNG can call the CLI as a subprocess. From a Unity editor script, for example:

```csharp
var psi = new ProcessStartInfo("testingfloor", $"upload-map --organization-id gamedepartment --game-id 42 --level-id {level} --image \"{pngPath}\" --bounds {bounds} --app-version {Application.version} --variant-key {variant}") {
    UseShellExecute = false,
};
psi.EnvironmentVariables["TESTING_FLOOR_API_TOKEN"] = token;
Process.Start(psi);
```

## Config Fields

Top-level:

- `apiUrl`: Testing Floor base URL. Defaults to `https://api.testingfloor.com`.
- `organizationId`: organization slug or numeric id.
- `gameId`: numeric Testing Floor game id.
- `version`: version metadata. Required by the API.
- `gitSha`: optional git SHA metadata.
- `sourceRef`: optional JSON object stored with the build.
- `builds`: array of platform build objects.

Build object:

- `platform`: `windows`, `macos`, or `linux`.
- `buildDirectory`: the ready-to-run build folder (`archive` and `path` are accepted as older names).
- `launchPath`: executable path inside the build folder.
- `launchArgs`: optional array, defaults to `[]`.
- `workingDirectory`: optional working directory inside the build folder, defaults to `"."`.
- `filename`: optional name for the zip download. Defaults to the folder name plus `.zip`.
- `butlerPath`: optional path to the butler executable. The GitHub Action installs butler automatically.

Map config top-level:

- `organizationId`, `gameId`, `apiUrl`, `token`: same as builds.
- `appVersion`: app version pinned to every map in the file. Per-map values override.
- `mapVersion`: telemetry map version number pinned to every map in the file. Per-map values override.
- `maps`: array of map objects.

Map object:

- `levelId`: level identifier (must match the value the game emits in telemetry).
- `image`: PNG, JPG, or WEBP path. Relative paths resolve from the config file's directory.
- `bounds`: object with `centerX`, `centerZ`, `sizeX`, `sizeZ` — or a `"cx,cz,sx,sz"` string.
- `horizontalAxis`, `verticalAxis`: world axes (`x`, `y`, `z`). Default to `x`/`z`. Must differ.
- `appVersion`: optional override of the top-level `appVersion`.
- `mapVersion` or `version`: optional telemetry map version number override.
- `variantKey` or `variant`: optional variant key for floors, modes, or alternate views.
- `defaultVariant`: optional boolean that marks this variant as the default for its level/version.

## Environment

- `TESTING_FLOOR_API_TOKEN`
- `TESTING_FLOOR_API_URL`
- `TESTING_FLOOR_ORGANIZATION_ID`
- `TESTING_FLOOR_GAME_ID`
- `TESTING_FLOOR_VERSION`
- `TESTING_FLOOR_MAP_VERSION`
- `TESTING_FLOOR_GIT_SHA`
- `TESTING_FLOOR_BUTLER_PATH`
- `TESTING_FLOOR_CONFIG_DIR`: folder for the saved login (see [Sign in](#sign-in))

CLI flags override environment and config values.


## Telemetry field mappings

With a user API token scoped to `telemetry:configure` and permission to manage the game:

```sh
testingfloor get-telemetry-schema --organization-id example-studio --game-id my-game
testingfloor set-telemetry-schema --organization-id example-studio --game-id my-game --schema telemetry-schema.json
```

The schema file contains the mappings directly:

```json
{
  "map_id_path": "game_level.id",
  "app_version_path": "tf_context.app_version",
  "spatial_sources": {
    "player_position": { "x": "player.position.x", "y": "player.position.y", "z": "player.position.z" }
  }
}
```

Updates merge by default, preserving mappings not mentioned in the file. Use `--mode replace` to remove unspecified mappings. Arrays are replaced when merging. The server validates the full resulting configuration and refreshes affected recording snapshots. Use an empty string to clear an optional field path; use replacement to remove object entries.

The read response includes `schema_config` and the validation `schema`. The matching HTTP endpoint is `GET` / `PATCH /api/organizations/:organization_id/games/:game_id/telemetry/schema`. PATCH accepts `{ "schema_config": { ... }, "mode": "merge" }`.
