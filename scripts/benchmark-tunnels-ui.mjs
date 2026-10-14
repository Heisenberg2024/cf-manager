// Read-only Git export of v2.8.2; build only the isolated frontend and run the same fixture.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync('/private/tmp/cfm-tunnels-baseline-');
try {
  execFileSync('tar', ['-x', '-C', temporary], { input: execFileSync('git', ['archive', '7a317de40bb05ea93834ed1ecc75e039e1c8da3e'], { cwd: root, maxBuffer: 30 * 1024 * 1024 }) });
  symlinkSync(resolve(root, 'frontend/node_modules'), resolve(temporary, 'frontend/node_modules'));
  execFileSync('npm', ['run', 'build'], { cwd: resolve(temporary, 'frontend'), stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('node', [resolve(root, 'scripts/test-tunnels-rules-ui.mjs')], { cwd: root, env: { ...process.env, BASELINE_UI: 'true', FRONTEND_DIST: resolve(temporary, 'frontend/dist'), UI_REPORT: resolve(root, 'docs/performance-v2.9-ui-before.json') }, stdio: 'inherit' });
} finally { rmSync(temporary, { recursive: true, force: true }); }
