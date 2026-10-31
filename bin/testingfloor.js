#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { main } from "../src/cli.js";

// Read here rather than in src/, which is also bundled into the GitHub
// Actions, where import.meta isn't available.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

main(process.argv.slice(2), process.env, process.cwd(), { cliVersion: version }).catch((error) => {
  console.error(`testingfloor: ${error.message}`);
  process.exitCode = 1;
});
