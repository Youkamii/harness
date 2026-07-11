#!/usr/bin/env node
// 설치기: 이 레포(소스) → ~/.claude(배포본). 몇 번을 다시 돌려도 안전(멱등).
// 순서: ① assets-manifest 재생성(소스가 정본) → ② 테스트 게이트 → ③ skills/agents/hooks/contracts 복사
//       → ④ settings.json 훅 병합 → ⑤ CLAUDE.md 헌법 병합(마커 블록) → ⑥ manifest 기준 배포본 검증.
// `node install.mjs --verify` : 복사·병합 없이 드리프트 검사만 수행 (로컬 유지보수 작업이 재사용).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildManifest, verifyDeployed, MANIFEST_FILE } from './scripts/manifest-lib.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(os.homedir(), '.claude');

// --verify: 소스↔manifest 정합 + 배포본 드리프트만 검사하고 종료 (아무것도 바꾸지 않는다)
if (process.argv.includes('--verify')) {
  const manifestPath = path.join(REPO, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    console.error(`[verify] ${MANIFEST_FILE} 없음 — node scripts/build-manifest.mjs 먼저 실행`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const problems = verifyDeployed(CLAUDE, REPO, manifest);
  const fresh = buildManifest(REPO);
  if (JSON.stringify(fresh.assets) !== JSON.stringify(manifest.assets)) {
    problems.unshift(`${MANIFEST_FILE}: 소스와 불일치 — 소스 변경 후 build-manifest 미실행 상태`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`[verify] ${p}`);
    process.exit(1);
  }
  console.log('[verify] 드리프트 없음 — 소스·manifest·배포본이 일치합니다.');
  process.exit(0);
}

// ① manifest 재생성 — 설치 시점의 소스 상태를 고정한다
fs.writeFileSync(
  path.join(REPO, MANIFEST_FILE),
  JSON.stringify(buildManifest(REPO), null, 2) + '\n',
);
console.log(`[install] ${MANIFEST_FILE} 재생성`);

// ② 깨진 자산을 배포하지 않는다 — 테스트 실패 시 설치 중단
for (const test of [
  'hooks/guard.test.js',
  'hooks/secrets-guard.test.mjs',
  'contracts/contracts.test.mjs',
  'test/smoke.test.mjs',
  'test/constitution.test.mjs',
]) {
  const t = spawnSync(process.execPath, [path.join(REPO, ...test.split('/'))], { encoding: 'utf8' });
  if (t.status !== 0) {
    console.error(t.stdout || '', t.stderr || '');
    console.error(`[install] ${test} 실패 — 배포를 중단합니다.`);
    process.exit(1);
  }
  console.log(`[install] ${test} 통과`);
}

// ③ 파일 복사 (기존의 다른 스킬/에이전트는 건드리지 않고 병합) + manifest도 배포본에 복사
for (const dir of ['skills', 'agents', 'hooks', 'contracts']) {
  fs.cpSync(path.join(REPO, dir), path.join(CLAUDE, dir), { recursive: true });
  console.log(`[install] ${dir}/ 복사 완료`);
}
fs.copyFileSync(path.join(REPO, MANIFEST_FILE), path.join(CLAUDE, MANIFEST_FILE));

// ④ settings.json 병합 — 표준 matcher(Bash|PowerShell) 항목 안에서만 파일명으로 판별한다.
// 다른 matcher에 같은 파일이 등록돼 있어도 표준 항목에 반드시 등록해 커버리지를 보장한다 (리뷰 발견 #3).
const sp = path.join(CLAUDE, 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { /* 없으면 새로 만든다 */ }
if (!settings.language) settings.language = 'korean';
if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
let pre = settings.hooks.PreToolUse;
if (!Array.isArray(pre)) {
  // 배열이 아니면(잘못된 형식) 항목처럼 생긴 객체는 감싸고, 아니면 초기화 (리뷰 발견 #8)
  pre = settings.hooks.PreToolUse = pre && typeof pre === 'object' && pre.hooks ? [pre] : [];
}
let entry = pre.find((e) => e && e.matcher === 'Bash|PowerShell');
if (!entry) {
  entry = { matcher: 'Bash|PowerShell', hooks: [] };
  pre.push(entry);
}
if (!Array.isArray(entry.hooks)) entry.hooks = [];
for (const f of ['guard.js', 'secrets-guard.mjs']) {
  const want = path.join(CLAUDE, 'hooks', f);
  const existing = entry.hooks.find(
    (h) => h && Array.isArray(h.args) && h.args.some((a) => typeof a === 'string' && a.endsWith(f))
  );
  if (existing) {
    existing.command = process.execPath; // node 경로가 바뀌었을 수 있으니 갱신
    existing.args = [want];
  } else {
    entry.hooks.push({ type: 'command', command: process.execPath, args: [want], timeout: 10 });
    console.log(`[install] settings.json에 ${f} 훅 등록`);
  }
}
fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
JSON.parse(fs.readFileSync(sp, 'utf8')); // 쓰고 나서 파싱 재확인 — settings.json이 깨지면 전체 설정이 조용히 죽는다

// ⑤ CLAUDE.md 헌법 병합 — 마커 블록만 교체하므로 사용자의 다른 내용은 보존
const cm = path.join(CLAUDE, 'CLAUDE.md');
const BEGIN = '<!-- G-HARNESS BEGIN -->';
const END = '<!-- G-HARNESS END -->';
const block = `${BEGIN}\n${fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8').trim()}\n${END}`;
let doc = '';
try { doc = fs.readFileSync(cm, 'utf8'); } catch { /* 없으면 새로 만든다 */ }
if (doc.includes(BEGIN) && doc.includes(END)) {
  doc = doc.slice(0, doc.indexOf(BEGIN)) + block + doc.slice(doc.indexOf(END) + END.length);
} else {
  doc = (doc.trim() ? doc.trim() + '\n\n' : '') + block + '\n';
}
fs.writeFileSync(cm, doc);
console.log('[install] CLAUDE.md 헌법 병합 완료');

// ⑥ 배포본 검증 — 복사·병합이 실제로 반영됐는지 manifest 기준으로 확인
const problems = verifyDeployed(
  CLAUDE,
  REPO,
  JSON.parse(fs.readFileSync(path.join(REPO, MANIFEST_FILE), 'utf8')),
);
if (problems.length) {
  for (const p of problems) console.error(`[install] 검증 실패: ${p}`);
  process.exit(1);
}
console.log('[install] 배포본 검증 통과 — manifest와 일치');

console.log('\n[install] 완료. 새 세션부터 스킬/헌법이 적용됩니다. 훅은 즉시 또는 재시작 후 활성화됩니다 (/hooks로 확인).');
