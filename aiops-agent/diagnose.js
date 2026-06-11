#!/usr/bin/env node
/**
 * Diagnose aiops installation issues
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { platform, homedir, EOL } from 'os';
import { join } from 'path';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';

console.log('🔍 AIOps Installation Diagnostics\n');

// 1. Node version
try {
  const ver = execSync('node --version', { encoding: 'utf8' }).trim();
  console.log(`✓ Node.js: ${ver}`);
} catch (e) {
  console.log('✗ Node.js: NOT FOUND');
}

// 2. npm version
try {
  const ver = execSync('npm --version', { encoding: 'utf8' }).trim();
  console.log(`✓ npm: v${ver}`);
} catch (e) {
  console.log('✗ npm: NOT FOUND');
}

// 3. OS
console.log(`✓ OS: ${platform()} (${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'})`);

// 4. npm global prefix
try {
  const prefix = execSync(IS_WIN ? 'cmd /c npm config get prefix' : 'npm config get prefix', { encoding: 'utf8' }).trim();
  console.log(`✓ npm global prefix: ${prefix}`);
  const binDir = IS_WIN ? prefix : join(prefix, 'bin');
  console.log(`  bin directory: ${binDir}`);

  // Check if aiops exists there
  const aiopsBinary = IS_WIN ? join(binDir, 'aiops.cmd') : join(binDir, 'aiops');
  if (existsSync(aiopsBinary)) {
    console.log(`  ✓ aiops binary found: ${aiopsBinary}`);
  } else {
    console.log(`  ✗ aiops binary NOT found at: ${aiopsBinary}`);
  }
} catch (e) {
  console.log('✗ npm config get prefix: FAILED');
  console.log(`  Error: ${e.message}`);
}

// 5. PATH check
console.log('\n📋 PATH Directories:');
const pathVar = process.env.PATH;
const paths = pathVar.split(IS_WIN ? ';' : ':');
console.log(`Total: ${paths.length} directories`);

// Look for npm-related paths
const npmPaths = paths.filter(p =>
  p.includes('npm') ||
  p.includes('node') ||
  p.includes('homebrew') ||
  p.includes('.npm')
);

if (npmPaths.length > 0) {
  console.log('npm-related paths in PATH:');
  npmPaths.forEach(p => console.log(`  ${p}`));
} else {
  console.log('⚠️  No npm-related paths found in PATH!');
}

// 6. Try to run aiops
console.log('\n🔨 Testing aiops command:');
try {
  const result = execSync('aiops --version', { encoding: 'utf8', stdio: 'pipe' }).trim();
  console.log(`✓ aiops works: v${result}`);
} catch (e) {
  console.log('✗ aiops command failed');
  console.log(`  Error: ${e.message}`);

  // Try with full path
  console.log('\n  Trying with full path:');
  try {
    const prefix = execSync(IS_WIN ? 'cmd /c npm config get prefix' : 'npm config get prefix', { encoding: 'utf8' }).trim();
    const aiopsBinary = IS_WIN ? join(prefix, 'aiops.cmd') : join(prefix, 'bin', 'aiops');

    if (existsSync(aiopsBinary)) {
      const result = spawnSync(IS_WIN ? 'cmd' : 'sh',
        IS_WIN ? ['/c', aiopsBinary, '--version'] : [aiopsBinary, '--version'],
        { encoding: 'utf8' }
      );
      if (result.status === 0) {
        console.log(`  ✓ Full path works: ${aiopsBinary} → v${result.stdout.trim()}`);
      } else {
        console.log(`  ✗ Full path failed: ${result.stderr}`);
      }
    } else {
      console.log(`  ✗ Binary not at: ${aiopsBinary}`);
    }
  } catch (err) {
    console.log(`  ✗ Full path check failed: ${err.message}`);
  }
}

// 7. Local binary check
console.log('\n📦 Local binary check:');
if (existsSync('dist/cli.cjs')) {
  console.log('✓ dist/cli.cjs exists');
  try {
    const result = spawnSync('node', ['dist/cli.cjs', '--version'], { encoding: 'utf8' });
    if (result.status === 0) {
      console.log(`  ✓ Works locally: node dist/cli.cjs → v${result.stdout.trim()}`);
    } else {
      console.log(`  ✗ Local run failed: ${result.stderr}`);
    }
  } catch (e) {
    console.log(`  ✗ Local run error: ${e.message}`);
  }
} else {
  console.log('✗ dist/cli.cjs NOT found');
}

// 8. Shell check
console.log('\n🐚 Shell check:');
console.log(`Current shell: ${process.env.SHELL || 'unknown'}`);

if (IS_MAC) {
  console.log('\nℹ️  macOS tip: If you just installed Node.js, try:');
  console.log('  1. Close and reopen Terminal/iTerm');
  console.log('  2. Or run: source ~/.zshrc');
}

if (IS_WIN) {
  console.log('\nℹ️  Windows tip: If you just installed Node.js:');
  console.log('  1. Close and reopen PowerShell/Command Prompt');
  console.log('  2. Run: npm install -g . --force');
}

console.log('\n' + '='.repeat(50));
console.log('If you see "✗ aiops command failed" above,');
console.log('try the fix in SETUP_TROUBLESHOOTING.md\n');
