#!/usr/bin/env node
// 설치기: 이 레포(소스) → ~/.claude(배포본). 몇 번을 다시 돌려도 안전(멱등).
// 하는 일: ① 가드 회귀 테스트 → ② skills/agents/hooks 복사 → ③ settings.json 훅 병합 → ④ CLAUDE.md 헌법 병합(마커 블록).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(os.homedir(), '.claude');

// ① 깨진 가드를 배포하지 않는다 — 테스트 실패 시 설치 중단
const t = spawnSync(process.execPath, [path.join(REPO, 'hooks', 'guard.test.js')], { encoding: 'utf8' });
if (t.status !== 0) {
  console.error(t.stdout || '', t.stderr || '');
  console.error('[install] guard 회귀 테스트 실패 — 배포를 중단합니다.');
  process.exit(1);
}
console.log('[install] guard 테스트 통과');

// ② 파일 복사 (기존의 다른 스킬/에이전트는 건드리지 않고 병합)
for (const dir of ['skills', 'agents', 'hooks']) {
  fs.cpSync(path.join(REPO, dir), path.join(CLAUDE, dir), { recursive: true });
  console.log(`[install] ${dir}/ 복사 완료`);
}

// ③ settings.json 병합 — 파일명 기준으로 이미 등록된 훅은 중복 추가하지 않는다
const sp = path.join(CLAUDE, 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { /* 없으면 새로 만든다 */ }
if (!settings.language) settings.language = 'korean';
if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
const registered = JSON.stringify(settings.hooks.PreToolUse);
let entry = settings.hooks.PreToolUse.find((e) => e.matcher === 'Bash|PowerShell');
for (const f of ['guard.js', 'secrets-guard.mjs']) {
  if (registered.includes(f)) continue;
  if (!entry) {
    entry = { matcher: 'Bash|PowerShell', hooks: [] };
    settings.hooks.PreToolUse.push(entry);
  }
  entry.hooks.push({
    type: 'command',
    command: process.execPath, // 이 머신의 node 절대경로
    args: [path.join(CLAUDE, 'hooks', f)],
    timeout: 10,
  });
  console.log(`[install] settings.json에 ${f} 훅 등록`);
}
fs.writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
JSON.parse(fs.readFileSync(sp, 'utf8')); // 쓰고 나서 파싱 재확인 — settings.json이 깨지면 전체 설정이 조용히 죽는다

// ④ CLAUDE.md 헌법 병합 — 마커 블록만 교체하므로 사용자의 다른 내용은 보존
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

console.log('\n[install] 완료. 새 세션부터 스킬/헌법이 적용됩니다. 훅은 즉시 또는 재시작 후 활성화됩니다 (/hooks로 확인).');
