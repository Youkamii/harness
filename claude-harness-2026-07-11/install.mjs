#!/usr/bin/env node
// 설치기: 이 레포(소스) → ~/.claude(배포본). 몇 번을 다시 돌려도 안전(멱등).
// 순서: ① 테스트 게이트 → ② 잔존 자산 정리(이전 설치 스냅숏 기준) → ③ skills/agents/hooks/contracts 복사
//       → ④ 설치 스냅숏(manifest)을 배포본에 저장 → ⑤ settings.json 훅 병합 → ⑥ CLAUDE.md 헌법 병합 → ⑦ 배포본 검증.
// manifest는 저장소에 커밋하지 않는다 — 배포본 스냅숏만 둔다 (red-review: 커밋 스냅숏은 자기참조 군살).
// `node install.mjs --verify` : 아무것도 바꾸지 않고 드리프트·잔존 자산만 검사 (로컬 유지보수 작업이 재사용).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildManifest, verifyDeployed, findStaleDeployed, MANIFEST_FILE } from './scripts/manifest-lib.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(os.homedir(), '.claude');

// --verify: 소스(실시간 해시) vs 배포본 + 잔존 자산 검사만 하고 종료
if (process.argv.includes('--verify')) {
  const fresh = buildManifest(REPO);
  const problems = verifyDeployed(CLAUDE, REPO, fresh);
  for (const rel of findStaleDeployed(CLAUDE, fresh)) {
    problems.push(`${rel}: 소스에서 제거됐지만 배포본에 잔존 (재설치로 정리)`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`[verify] ${p}`);
    process.exit(1);
  }
  console.log('[verify] 드리프트 없음 — 소스와 배포본이 일치합니다.');
  process.exit(0);
}

// ① 깨진 자산을 배포하지 않는다 — 테스트 실패 시 설치 중단 (소스 트리 무변경 상태에서 판정)
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

// ② 잔존 자산 정리 — 소스에서 삭제된 자산이 배포본에서 계속 실행되는 것을 막는다.
//    이전 설치 스냅숏(배포본 manifest)에 있던 harness 관할 파일만 지우므로 다른 스킬은 건드리지 않는다.
const fresh = buildManifest(REPO);
for (const rel of findStaleDeployed(CLAUDE, fresh)) {
  if (rel.endsWith(MANIFEST_FILE)) continue;
  const target = path.join(CLAUDE, ...rel.split('/'));
  fs.rmSync(target, { force: true });
  console.log(`[install] 잔존 자산 삭제: ${rel} (소스에서 제거된 파일)`);
}

// ③ 파일 복사 (기존의 다른 스킬/에이전트는 건드리지 않고 병합)
for (const dir of ['skills', 'agents', 'hooks', 'contracts', 'workflows']) {
  fs.cpSync(path.join(REPO, dir), path.join(CLAUDE, dir), { recursive: true });
  console.log(`[install] ${dir}/ 복사 완료`);
}

// ④ 설치 스냅숏 저장 — 다음 설치의 잔존 자산 검출 기준
fs.writeFileSync(path.join(CLAUDE, MANIFEST_FILE), JSON.stringify(fresh, null, 2) + '\n');

// ⑤ settings.json 병합 — 표준 matcher(Bash|PowerShell) 항목 안에서만 파일명으로 판별한다.
// 파일이 존재하는데 파싱이 안 되면 절대 덮어쓰지 않는다 — 사용자 설정 전체가 날아간다 (red-review 발견).
const sp = path.join(CLAUDE, 'settings.json');
let settings = {};
if (fs.existsSync(sp)) {
  try {
    settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch (e) {
    console.error(`[install] ${sp} 파싱 실패: ${e.message}`);
    console.error('[install] 손상된 settings.json을 덮어쓰면 기존 설정이 전부 사라집니다. 파일을 고친 뒤 다시 실행하세요.');
    process.exit(1);
  }
}
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
// 소유 판별은 파일명 "정확 일치"만 — 접미사 매칭(endsWith)은 사용자 자작 훅(예: my-guard.js)을
// 하네스 것으로 오인해 조용히 덮어쓴다 (red-review 발견).
const baseName = (p) => String(p).split(/[\\/]/).pop();
for (const f of ['guard.js', 'secrets-guard.mjs']) {
  const want = path.join(CLAUDE, 'hooks', f);
  const existing = entry.hooks.find(
    (h) => h && Array.isArray(h.args) && h.args.some((a) => baseName(a) === f)
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

// ⑥ CLAUDE.md 헌법 병합 — 마커 블록만 교체하므로 사용자의 다른 내용은 보존.
// 마커가 0쌍이면 append, 정확히 1쌍(BEGIN<END)이면 교체, 그 외(다중·역순·홀수)는 사용자 내용을
// 파괴할 수 있으므로 중단한다 (red-review 발견: 본문에 인용된 마커가 있으면 첫 등장 splice가 내용을 삭제).
const cm = path.join(CLAUDE, 'CLAUDE.md');
const BEGIN = '<!-- G-HARNESS BEGIN -->';
const END = '<!-- G-HARNESS END -->';
const block = `${BEGIN}\n${fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8').trim()}\n${END}`;
let doc = '';
try { doc = fs.readFileSync(cm, 'utf8'); } catch { /* 없으면 새로 만든다 */ }
const beginCount = doc.split(BEGIN).length - 1;
const endCount = doc.split(END).length - 1;
if (beginCount === 0 && endCount === 0) {
  doc = (doc.trim() ? doc.trim() + '\n\n' : '') + block + '\n';
} else if (beginCount === 1 && endCount === 1 && doc.indexOf(BEGIN) < doc.indexOf(END)) {
  doc = doc.slice(0, doc.indexOf(BEGIN)) + block + doc.slice(doc.indexOf(END) + END.length);
} else {
  console.error(`[install] ${cm}의 G-HARNESS 마커가 비정상입니다 (BEGIN ${beginCount}개, END ${endCount}개).`);
  console.error('[install] 이 상태로 병합하면 사용자 내용이 손상될 수 있어 중단합니다. 마커를 수동 정리한 뒤 다시 실행하세요.');
  process.exit(1);
}
fs.writeFileSync(cm, doc);
console.log('[install] CLAUDE.md 헌법 병합 완료');

// ⑦ 배포본 검증 — 복사·병합이 실제로 반영됐는지 실시간 해시로 확인
const problems = verifyDeployed(CLAUDE, REPO, fresh);
if (problems.length) {
  for (const p of problems) console.error(`[install] 검증 실패: ${p}`);
  process.exit(1);
}
console.log('[install] 배포본 검증 통과');

console.log('\n[install] 완료. 새 세션부터 스킬/헌법이 적용됩니다. 훅은 즉시 또는 재시작 후 활성화됩니다 (/hooks로 확인).');
