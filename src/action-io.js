import { appendFileSync } from "node:fs";
import process from "node:process";

export function input(env, name) {
  const actionName = `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
  const shellName = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
  const value = env[actionName] ?? env[shellName];
  return value === undefined || value === "" ? null : value;
}

export function requiredInput(env, name) {
  const value = input(env, name);
  if (!value) {
    throw new Error(`Missing required input: ${name}`);
  }

  return value;
}

export function writeOutput(name, value, env) {
  if (value === undefined || value === null) {
    return;
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
    return;
  }

  process.stdout.write(`${name}=${value}\n`);
}
