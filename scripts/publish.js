#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read package.json
const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

console.log(`Current version: ${packageJson.version}`);
console.log('Available commands:');
console.log('  npm run publish:patch  - Bump patch version and publish');
console.log('  npm run publish:minor  - Bump minor version and publish');
console.log('  npm run publish:major  - Bump major version and publish');
console.log('  npm run publish:dry    - Dry run (build and test only)');
console.log('  Add --no-git or set NO_GIT_PUSH=1 to skip git tag/push (publish to npm only).');

const command = process.argv[2];

if (!command) {
  console.log('\nUsage: node scripts/publish.js <command>');
  console.log('Commands: patch, minor, major, dry');
  process.exit(1);
}

async function runCommand(cmd, description) {
  console.log(`\n${description}...`);
  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log(`✅ ${description} completed successfully`);
  } catch (error) {
    console.error(`❌ ${description} failed:`, error.message);
    process.exit(1);
  }
}

async function publish(versionType) {
  try {
    // Clean and build
    await runCommand('npm run clean', 'Cleaning build directory');
    await runCommand('npm run build', 'Building package');
    
    // Run tests
    await runCommand('npm test', 'Running tests');
    
    if (versionType === 'dry') {
      console.log('\n✅ Dry run completed successfully!');
      return;
    }
    
    // Bump version
    await runCommand(`npm version ${versionType} --no-git-tag-version`, `Bumping ${versionType} version`);
    
    // Read new version
    const newPackageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    console.log(`\nNew version: ${newPackageJson.version}`);
    
    // Publish to npm
    await runCommand('npm publish', 'Publishing to npm');
    
    // Optional: create git tag and push (skip if NO_GIT_PUSH=1 or --no-git)
    const noGitPush = process.env.NO_GIT_PUSH === '1' || process.argv.includes('--no-git');
    if (!noGitPush) {
      try {
        await runCommand(`git tag v${newPackageJson.version}`, 'Creating git tag');
        await runCommand('git push --tags', 'Pushing tags to remote');
      } catch (e) {
        console.warn('\n⚠️  Publish to npm succeeded; git tag/push skipped (use NO_GIT_PUSH=1 or --no-git to suppress).');
      }
    }
    
    console.log(`\n🎉 Successfully published ${newPackageJson.name}@${newPackageJson.version} to npm!`);
    console.log(`📦 Package: https://www.npmjs.com/package/${newPackageJson.name}`);
    
  } catch (error) {
    console.error('❌ Publishing failed:', error.message);
    process.exit(1);
  }
}

// Run the appropriate command
publish(command);
