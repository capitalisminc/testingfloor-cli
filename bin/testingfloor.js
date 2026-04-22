#!/usr/bin/env node

import { main } from "../src/cli.js";

main().catch((error) => {
  console.error(`testingfloor: ${error.message}`);
  process.exitCode = 1;
});
