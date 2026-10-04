import { spawn } from 'node:child_process';
const children = [
  spawn('node', ['--import', 'tsx', 'src/battle/server.ts'], { stdio: 'inherit' }),
  spawn('node', ['node_modules/vite/bin/vite.js', '--config', 'web/vite.config.ts'], {
    stdio: 'inherit',
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => c.kill());
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
