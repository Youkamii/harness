#!/usr/bin/env node
// 설치기: 이 레포(소스) → ~/.claude(배포본). 몇 번을 다시 돌려도 안전(멱등).
// 하는 일: ① 가드 회귀 테스트(guard+secrets) → ② skills/agents/hooks 복사 → ③ settings.json 훅 병합 → ④ CLAUDE.md 헌법 병합(마커 블록).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(os.homedir(), '.claude');

// ① 깨진 가드를 배포하지 않는다 — 테스트 실패 시 설치 중단
for (const test of ['guard.test.js', 'secrets-guard.test.mjs']) {
  const t = spawnSync(process.execPath, [path.join(REPO, 'hooks', test)], { encoding: 'utf8' });
  if (t.status !== 0) {
    console.error(t.stdout || '', t.stderr || '');
    console.error(`[install] ${test} 실패 — 배포를 중단합니다.`);
    process.exit(1);
  }
  console.log(`[install] ${test} 통과`);
}

// ② 파일 복사 (기존의 다른 스킬/에이전트는 건드리지 않고 병합)
for (const dir of ['skills', 'agents', 'hooks']) {
  fs.cpSync(path.join(REPO, dir), path.join(CLAUDE, dir), { recursive: true });
  console.log(`[install] ${dir}/ 복사 완료`);
}

// ③ settings.json 병합 — 표준 matcher(Bash|PowerShell) 항목 안에서만 파일명으로 판별한다.
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
