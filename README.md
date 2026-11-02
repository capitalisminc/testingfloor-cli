# Testing Floor CLI

Small Node CLI for uploading game builds, level maps and gameplay recordings to Testing Floor.

**Builds** are ready-to-run game folders. **Maps** are top-down level images with world-space bounds for heatmaps and event overlays. **Recordings** are existing gameplay videos, such as footage captured with OBS or exported from Steam Recording.

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

## Upload recordings

Upload a video to a named playtest:

```sh
testingfloor upload-recording \
  --playtest-id 123 \
  --file ./gameplay.mp4 \
  --tester-name "Example player"
```

Or upload a folder to a game's **Ongoing recordings**:

```sh
testingfloor upload-recording \
  --organization-id example-studio \
  --game-id my-game \
  --file ./recordings \
  --tester-email player@example.com
```

The API key needs `uploads:create`, and its owner must be able to manage the destination's playtests. Run `testingfloor login` again if your saved login predates recording uploads, or supply a key with that permission. Previously issued keys keep their existing permissions.

`--file` accepts a single video or a folder searched recursively. Each video becomes one recording. Common video extensions include MP4, MKV, MOV, WebM, AVI and M4V; hidden files, symbolic links and non-video sidecars are skipped in folders. Export Steam recordings to video files first. Videos are uploaded as-is, without transcoding or joining clips.

Identify the person who played with `--tester-name`, `--tester-email`, or `--tester-id` for an existing tester. You may combine name and email. A folder uses the same tester for every video; upload different testers' footage separately.

Optional metadata:

- `--version 1.2.3`: the recorded game version.
- `--recorded-at 2026-01-01T12:00:00Z`: when the gameplay was recorded, including its timezone.
- `--written-feedback "The menu was hard to find"`: the tester's feedback.

These values apply to every video in a folder. They can also be supplied in a JSON file using `--config`, with camelCase fields such as `file`, `playtestId`, `testerName`, `recordedAt` and `writtenFeedback`. Configured file paths are relative to the config file; `--file` is relative to the current directory. `TESTING_FLOOR_PLAYTEST_ID` supplies the playtest when the flag is omitted. Choose either a playtest or an organization/game destination.

### Resume an interrupted recording upload

Rerun the same command with the same API key. The CLI hashes each file and reuses the import for the same bytes, local file path, destination and metadata. It checks the upload server's confirmed byte range and sends the remaining bytes. Completed imports are reused, including when a completion response was lost. Expired uploads recover through Testing Floor using the same recording.

Keep the source files unchanged and in the same location until uploading finishes. Changing their path, bytes or metadata starts a different import. To deliberately import the same footage again, pass a new `--idempotency-key`, such as `--idempotency-key second-import`. In a folder, this is a batch key; each video still gets a distinct request key.

Progress goes to stderr. Results on stdout contain `recording_id`, `video_id`, `status_url` and the local filename for each video; `--json` suppresses progress. `uploaded` means the video transfer finished. Playback, transcripts and insights continue processing in Testing Floor. If a batch stops, earlier uploads remain available and rerunning reuses them.

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

For a ready-to-run build folder, each upload:

1. Splits the folder into content-addressed chunks. Content defines the boundaries, so an edit inside a large file changes only nearby chunks. Small files are packed together.
2. Uploads only chunks the game hasn't stored yet.
3. Sends the manifest and waits until Testing Floor has verified every chunk.
4. Completes the build, making it available for desktop installs, updates and ZIP downloads.

Uploads need only Node.js. No external patch tool is required. If chunk verification fails, the build stays unavailable and the command fails.

The first upload sends the whole build, uncompressed; later builds send only what changed.

Creation uses an idempotency key and completion is repeatable. The CLI retries ambiguous responses along with chunk, manifest and status requests, and respects versioned non-retryable errors. Waiting for verification continues through temporary failures until its deadline. See [retry recovery](#versioned-api-and-retry-recovery) for recovery across CLI invocations.

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
  uses: capitalisminc/testingfloor-cli@b65ab66674096e5d1c3a0f8b3f73b0f24026f506
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

`build-directory` is the ready-to-run build folder; see [How builds are uploaded](#how-builds-are-uploaded).

Choose `build-directory` for a ready-to-run folder or `archive` for an existing ZIP. Folder uploads use deduplicated chunks; ZIP inputs upload their existing bytes directly, including multipart transfer for large archives. ZIPs must contain the launch path at their root, without an extra enclosing folder. `archive-kind` is no longer needed; the source determines the format.

You can also run the CLI directly:

```yaml
- name: Upload builds to Testing Floor
  env:
    TESTING_FLOOR_API_TOKEN: ${{ secrets.TESTING_FLOOR_API_TOKEN }}
    TESTING_FLOOR_VERSION: ${{ github.ref_name }}
    TESTING_FLOOR_GIT_SHA: ${{ github.sha }}
  run: |
    npx --yes --package=https://github.com/capitalisminc/testingfloor-cli/archive/b65ab66674096e5d1c3a0f8b3f73b0f24026f506.tar.gz testingfloor upload-build \
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

A new map takes the game's world units per meter from its Testing Floor settings, such as 100 for an Unreal game. Leave it at that. `--world-units-per-meter` overrides it for one map, which is only right when that level really uses a different scale from the rest of the game.

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
  uses: capitalisminc/testingfloor-cli/upload-map@b65ab66674096e5d1c3a0f8b3f73b0f24026f506
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
- `buildDirectory`: a ready-to-run build folder or existing ZIP (`archive` and `path` remain accepted config names).
- `launchPath`: executable path inside the build folder.
- `launchArgs`: optional array, defaults to `[]`.
- `workingDirectory`: optional working directory inside the build folder, defaults to `"."`.
- `filename`: optional name for the zip download. Defaults to the folder name plus `.zip`.

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
- `worldUnitsPerMeter`: optional override of the game's world units per meter for this map. Leave it unset unless this level uses a different scale from the rest of the game.

## Environment

- `TESTING_FLOOR_API_TOKEN`
- `TESTING_FLOOR_API_URL`
- `TESTING_FLOOR_ORGANIZATION_ID`
- `TESTING_FLOOR_GAME_ID`
- `TESTING_FLOOR_VERSION`
- `TESTING_FLOOR_MAP_VERSION`
- `TESTING_FLOOR_GIT_SHA`
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

## Releasing

npm publishes this package from GitHub Actions through trusted publishing, so no npm token is stored in the repository.

1. Set `version` in `package.json` and `package-lock.json` with `npm version <version> --no-git-tag-version`, and merge that change.
2. Push a tag for the merged commit, for example `git tag v1.2.3 && git push origin v1.2.3`.

The tag starts the "Publish to npm" workflow, which runs the tests and publishes with provenance.


## Versioned API and retry recovery

This release sends `TestingFloor-Api-Version: 1` to the customer API at
`https://api.testingfloor.com/api`. Deploy support for that version before upgrading.
The CLI retries ambiguous create and completion responses. A create retry reuses
one idempotency key, so it recovers the same build rather than creating another.

To recover an upload across separate CLI invocations, pass `--idempotency-key`
(or `TESTING_FLOOR_IDEMPOTENCY_KEY`). Keep it unchanged for retries of the same
operation and change it for a new build. The content digest and upload metadata
must match; reusing an operation key for different content fails. For Actions,
the default includes repository, run ID and job; branch, platform and filename distinguish
builds. Set the `idempotency-key` input explicitly for other matrix dimensions.

## Event presentation

Data mappings and event styling are separate resources. `--schema` describes how
to interpret incoming data. `--presentation` controls event rules, common field
prefixes and topline keys. Replacing either resource preserves the other.

```sh
testingfloor get-event-presentation --organization-id example-studio --game-id my-game
testingfloor set-event-presentation --organization-id example-studio --game-id my-game --presentation event-presentation.json --mode replace
```

Both command groups require `telemetry:configure`. Their default update mode is
`merge`; `replace` clears only the configuration owned by that resource.

+
+## Reproducible client versions
+
+The Actions and `npx` examples pin the same immutable implementation commit.
+They require customer API version 1. Upgrade by reviewing a released tag or commit,
+then replace every pin together. The package version prepared here is 0.4.0;
+the source pin works without assuming that version has been published to npm.
+
