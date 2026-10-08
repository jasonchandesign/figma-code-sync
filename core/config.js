'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG = 'figma-sync.config.js';

/**
 * Find the config by walking up from `start`. The walk stops at the first
 * directory that holds `.git`, so a config in `~` or a parent checkout is never
 * picked up (and executed) from an unrelated project.
 */
function loadConfig(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, CONFIG);
    if (fs.existsSync(file)) {
      delete require.cache[require.resolve(file)]; // a re-run after `init` edited it must see the new one
      const config = require(file);
      return { ...config, root: config.root ? path.resolve(dir, config.root) : dir };
    }
    const up = path.dirname(dir);
    if (up === dir || fs.existsSync(path.join(dir, '.git'))) {
      throw new Error(`no ${CONFIG} found here or above — run \`figma-code-sync init\` first`);
    }
    dir = up;
  }
}

module.exports = { CONFIG, loadConfig };
