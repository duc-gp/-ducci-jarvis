#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '../package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const bumpTypes = {
  patch: `${major}.${minor}.${patch + 1}`,
  minor: `${major}.${minor + 1}.0`,
  major: `${major + 1}.0.0`,
};

const arg = process.argv[2];

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  console.log(`Current version: ${pkg.version}`);

  let newVersion;

  if (arg && bumpTypes[arg]) {
    newVersion = bumpTypes[arg];
  } else if (arg) {
    // treat as explicit version string
    newVersion = arg;
  } else {
    console.log(`  patch → ${bumpTypes.patch}`);
    console.log(`  minor → ${bumpTypes.minor}`);
    console.log(`  major → ${bumpTypes.major}`);
    const answer = await prompt('Bump type or explicit version [patch]: ');
    const choice = answer || 'patch';
    newVersion = bumpTypes[choice] ?? choice;
  }

  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Version updated to ${newVersion}`);

  try {
    execSync('npm publish --access public', { stdio: 'inherit' });
  } catch {
    // restore original version on failure
    pkg.version = `${major}.${minor}.${patch}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.error('Publish failed — version restored.');
    process.exit(1);
  }
}

main();
