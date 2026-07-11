// harness 스모크 테스트 — 필수 자산 존재·JS 문법·manifest 정합을 검사한다.
// 실행: node test/smoke.test.mjs (install.mjs가 배포 전 게이트로도 실행한다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildManifest, MANIFEST_FILE } from '../scripts/manifest-lib.mjs';

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
  MANIFEST_FILE,
  'contracts/workflow-result.schema.json',
  'contracts/run-summary.schema.json',
  'contracts/validate.mjs',
  'hooks/guard.js',
  'hooks/guard.test.js',
  'hooks/secrets-guard.mjs',
  'hooks/secrets-guard.test.mjs',
  'agents/red-reviewer.md',
  'agents/verifier.md',
  'skills/harness/SKILL.md',
  'skills/kickoff/SKILL.md',
  'skills/red-review/SKILL.md',
  'skills/wrapup/SKILL.md',
];
for (const rel of REQUIRED) {
  check(`존재: ${rel}`, fs.existsSync(path.join(REPO, ...rel.split('/'))));
}

console.log('[2] 모든 JS/MJS가 문법 오류 없이 파싱된다');
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const jsFiles = [...walk(REPO)].filter(
  (f) => /\.(js|mjs)$/.test(f) && !f.includes('node_modules'),
);
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  check(`문법: ${path.relative(REPO, f)}`, r.status === 0, (r.stderr || '').split('\n')[0]);
}

console.log('[3] assets-manifest.json이 소스와 정합한다');
{
  const manifestPath = path.join(REPO, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    check('manifest 존재', false, 'node scripts/build-manifest.mjs 먼저 실행');
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const fresh = buildManifest(REPO);
    check('manifest contract v1', manifest.contract === 'assets-manifest/v1');
    check(
      'manifest 정합 (소스 == 스냅숏)',
      JSON.stringify(manifest.assets) === JSON.stringify(fresh.assets),
      '소스를 고쳤으면 node scripts/build-manifest.mjs 를 돌리고 함께 커밋한다',
    );
  }
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
