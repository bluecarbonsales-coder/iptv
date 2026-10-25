'use strict';
const fs = require('fs');
const path = require('path');
function createMediaSettings(dataDir) {
  const file = path.join(dataDir, 'media-settings.json');
  function read() {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return { defaultProxy: value.defaultProxy !== false }; }
    catch { return { defaultProxy: true }; }
  }
  function save(input) {
    if (!input || typeof input.defaultProxy !== 'boolean') throw Object.assign(new Error('defaultProxy must be true or false.'), { statusCode: 400 });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, defaultProxy: input.defaultProxy }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    return read();
  }
  return { read, save, file };
}
module.exports = { createMediaSettings };
