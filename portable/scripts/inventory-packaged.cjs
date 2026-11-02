'use strict';
/** Inventory actual ASAR package metadata, including the desktop shell's production dependencies. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2]);
const items = new Map();
function modules(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      for (const child of fs.readdirSync(candidate, { withFileTypes: true })) if (child.isDirectory()) record(path.join(candidate, child.name));
    } else record(candidate);
  }
}
function record(directory) {
  const filename = path.join(directory, 'package.json');
  if (!fs.existsSync(filename)) return;
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
    const key = manifest.name + '@' + manifest.version;
    const location = path.relative(root, directory).split(path.sep).join('/');
    const existing = items.get(key);
    if (existing) existing.locations.push(location);
    else items.set(key, { name: manifest.name, version: manifest.version, license: manifest.license || manifest.licenses || 'See bundled license files', repository: manifest.repository, locations: [location], licenseFiles: fs.readdirSync(directory).filter(name => /^(?:licen[sc]e|copying|notice)/i.test(name)) });
  }
  modules(path.join(directory, 'node_modules'));
}
modules(path.join(root, 'resources/app.asar/node_modules'));
modules(path.join(root, 'resources/app.asar/dsh/node_modules'));
modules(path.join(root, 'resources/runtime/primary-runtime/dependencies/node/bin/node_modules'));
modules(path.join(root, 'resources/runtime/primary-runtime/dependencies/pnpm/dist/node_modules'));
const report = { format: 1, upstream: JSON.parse(fs.readFileSync(path.join(root, 'portable.json'), 'utf8')), npmPackages: [...items.values()].sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version)), primaryRuntime: JSON.parse(fs.readFileSync(path.join(root, 'resources/runtime/primary-runtime/runtime.json'), 'utf8')), runtimeArchives: JSON.parse(fs.readFileSync(path.join(root, 'runtime-sources.json'), 'utf8')), microsoftRuntime: JSON.parse(fs.readFileSync(path.join(root, 'resources/portable/msvc-files.json'), 'utf8')) };
fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
console.log('Inventoried production npm packages:', items.size);
