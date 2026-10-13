// Run Git-backed test fixtures without inheriting the developer's global Git hooks.
// The actual repository hooks still run and still invoke this test command.
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'sudus-test-git-'));
try {
  const config = join(scratch, 'config');
  writeFileSync(config, '[user]\nname = Sudus Test\nemail = sudus-test@example.invalid\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config };
  // Git exports these to hooks; temporary fixture repositories must not inherit them.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) delete env[name];
  const tests = ['tests/*.test.mjs', 'tests/*.test.ts', 'tests/bench/*.test.mjs']
    .flatMap((pattern) => globSync(pattern)).sort();
  const result = spawnSync(process.execPath, ['--test', ...tests], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
