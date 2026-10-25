'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const envExample = path.join(root, '.env.example');
const envFile = path.join(root, '.env');

const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  console.error(`This project targets Node.js 24 LTS; detected ${process.versions.node}.`);
  console.error('Install Node.js 24, then rerun: npm run setup');
  process.exit(1);
}

if (fs.existsSync(envFile)) {
  console.log('.env already exists; leaving it unchanged.');
} else {
  let env = fs.readFileSync(envExample, 'utf8');
  const token = () => crypto.randomBytes(32).toString('hex');
  env = env
    .replace('replace-with-a-long-random-refresh-token', token())
    .replace('replace-with-a-different-long-random-source-token', token())
    .replace('replace-with-a-third-long-random-agent-token', token())
    .replace(/^GITHUB_REPO_TOKEN=.*$/m, 'GITHUB_REPO_TOKEN=')
    .replace(/^EMAIL_SESSION_SECRET=.*$/m, `EMAIL_SESSION_SECRET=${token()}`)
    .replace(/^EMAIL_CREDENTIALS_KEY=.*$/m, `EMAIL_CREDENTIALS_KEY=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(envFile, env, { mode: 0o600, flag: 'wx' });
  console.log('Created .env with unique local tokens (file mode 600).');
}

console.log('');
console.log('Next:');
console.log('  npm run dev');
console.log('Open: http://127.0.0.1:3920');
console.log('The channel catalogue downloads in the background on first start.');
console.log('Use Ctrl+C to stop. No Docker required.');
