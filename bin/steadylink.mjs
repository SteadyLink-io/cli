#!/usr/bin/env node

import { run } from "../src/cli.mjs";

run()
  .then((result) => {
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })
  .catch((error) => {
    process.stderr.write(`steadylink: ${error.message}\n`);
    process.exitCode = 1;
  });
