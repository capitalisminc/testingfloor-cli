import process from "node:process";

import { input, requiredInput, writeOutput } from "./action-io.js";
import { resolveMapPlan, uploadMap } from "./cli.js";

export async function runMapAction(env = process.env, cwd = process.cwd()) {
  const options = readMapInputs(env);
  const plan = await resolveMapPlan(options, env, cwd);
  const result = await uploadMap(plan, plan.maps[0]);

  writeOutput("map-id", result.id, env);
  writeOutput("level-id", result.levelId, env);
  writeOutput("version", result.version, env);
  writeOutput("pinned", result.pinned, env);
  writeOutput("app-version", result.appVersion, env);
  writeOutput("variant-key", result.variantKey, env);
  writeOutput("variant-label", result.variantLabel, env);
  writeOutput("default-variant", result.defaultVariant, env);
  writeOutput("configured", result.configured, env);
}

export function readMapInputs(env) {
  return {
    apiUrl: input(env, "api-url") || undefined,
    appVersion: input(env, "app-version") || undefined,
    bounds: boundsFromInputs(env),
    gameId: requiredInput(env, "game-id"),
    horizontalAxis: input(env, "horizontal-axis") || undefined,
    image: requiredInput(env, "image"),
    levelId: requiredInput(env, "level-id"),
    mapVersion: input(env, "map-version") || undefined,
    organizationId: input(env, "organization-id") || undefined,
    token: requiredInput(env, "api-token"),
    variantKey: input(env, "variant-key") || input(env, "variant") || undefined,
    defaultVariant: input(env, "default-variant") || undefined,
    verticalAxis: input(env, "vertical-axis") || undefined
  };
}

function boundsFromInputs(env) {
  const single = input(env, "bounds");
  if (single) {
    return single;
  }

  const centerX = requiredInput(env, "bounds-center-x");
  const centerZ = requiredInput(env, "bounds-center-z");
  const sizeX = requiredInput(env, "bounds-size-x");
  const sizeZ = requiredInput(env, "bounds-size-z");
  return { centerX, centerZ, sizeX, sizeZ };
}
