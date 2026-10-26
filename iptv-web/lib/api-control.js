'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({ enabled: true });

function createApiControl(dataDir) {
  const file = path.join(dataDir, 'api-control.json');

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { enabled: parsed.enabled !== false };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return { ...DEFAULTS };
    }
  }

  function save(input) {
    if (!input || typeof input.enabled !== 'boolean') {
      throw Object.assign(new Error('enabled must be true or false.'), { statusCode: 400 });
    }
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ enabled: input.enabled }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    return read();
  }

  return { read, save };
}

module.exports = { createApiControl };
