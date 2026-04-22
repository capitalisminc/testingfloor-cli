# Testing Floor CLI

Small Node CLI for uploading ready-to-run game build archives to Testing Floor.

This first version is intentionally boring: point it at one or more zip files, tell it the platform and launch path, and it uploads each build through Testing Floor's direct-upload API.

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
- `archiveKind`: only `zip` is supported right now.

## Environment

- `TESTING_FLOOR_API_TOKEN`
- `TESTING_FLOOR_API_URL`
- `TESTING_FLOOR_GAME_ID`
- `TESTING_FLOOR_VERSION`
- `TESTING_FLOOR_GIT_SHA`

CLI flags override environment and config values.
