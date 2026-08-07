'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadSkills(registry, { root = path.resolve(__dirname, '..', '..', 'skills') } = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'skill.json'), 'utf8'));
    const handler = require(path.join(directory, 'handler.js'));
    registry.register(manifest, handler);
  }
  return registry;
}

module.exports = { loadSkills };
