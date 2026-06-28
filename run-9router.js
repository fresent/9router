#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Enforce port 20128 right before booting up 
process.env.PORT = '20128';
process.env.NODE_ENV = 'production';

const repoDirectory = '/mnt/Workspace-Shared/github/fresent/9router';
const logPath = path.join(repoDirectory, '9router-failure.log');

/**
 * Log unexpected startup failure details.
 * Expected signals (SIGTERM/SIGINT) are NOT logged as failures.
 */
function logFailure(error) {
  const msg = `[${new Date().toISOString()}] Next.js exited unexpectedly.\nMessage: ${error.message}\nStack: ${error.stack}\n${'-'.repeat(50)}\n`;
  try { fs.appendFileSync(logPath, msg, 'utf8'); } catch (e) { /* best effort */ }
}

try {
  execSync('npx next start', {
    cwd: repoDirectory,
    stdio: 'inherit',
    windowsHide: true
  });
} catch (error) {
  // With stdio: 'inherit', error.stderr is usually undefined.
  // error.status holds the exit code; treat expected signals as clean exits.
  const exitCode = error.status ?? (error.signal ? 128 : 1);
  const isExpectedExit = exitCode === 130 // SIGINT
    || exitCode === 143 // SIGTERM
    || exitCode === 0
    || /SIGTERM|SIGINT|shutdown/i.test(error.message || '');

  if (isExpectedExit) {
    process.exit(exitCode);
  }

  logFailure(error);
  process.exit(exitCode);
}
