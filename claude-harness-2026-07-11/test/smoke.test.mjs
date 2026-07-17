// harness 스모크 테스트 — 필수 자산 존재·JS 문법을 검사한다.
// 실행: node test/smoke.test.mjs (install.mjs가 배포 전 게이트로도 실행한다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { walk } from '../scripts/manifest-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[1] 필수 자산이 존재한다');
const REQUIRED = [
  'install.mjs',
  'CLAUDE.md',
  'contracts/workflow-result.schema.json',
  'contracts/run-summary.schema.json',
  'contracts/validate.mjs',
  'workflows/red-review.js',
  'workflows/deep-audit.js',
  'hooks/guard.js',
  'hooks/guard.test.js',
  'hooks/secrets-guard.mjs',
  'hooks/secrets-guard.test.mjs',
  'hooks/format-changed.mjs',
  'hooks/format-changed.test.mjs',
  'agents/red-reviewer.md',
  'agents/verifier.md',
  'agents/scout.md',
  'skills/harness/SKILL.md',
  'skills/kickoff/SKILL.md',
  'skills/red-review/SKILL.md',
  'skills/wrapup/SKILL.md',
  'scripts/manifest-lib.mjs',
  'scripts/memory-audit.mjs',
  'scripts/local-maintenance.mjs',
  'scripts/run-hidden.vbs',
  'scripts/install-maintenance-task.ps1',
];
for (const rel of REQUIRED) {
  check(`존재: ${rel}`, fs.existsSync(path.join(REPO, ...rel.split('/'))));
}

console.log('[2] 모든 JS/MJS가 문법 오류 없이 파싱된다');
const jsFiles = [...walk(REPO)].filter((f) => /\.(js|mjs)$/.test(f));
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  check(`문법: ${path.relative(REPO, f)}`, r.status === 0, (r.stderr || '').split('\n')[0]);
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
