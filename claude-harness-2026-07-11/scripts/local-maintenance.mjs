#!/usr/bin/env node
// local-maintenance — 하네스·메모리 무토큰 로컬 점검 (B1+B2).
// 클라우드 루틴은 로컬 ~/.claude에 접근할 수 없으므로(capability 표 참조) 유지보수는 반드시 로컬에서 돈다.
// AI(토큰)를 전혀 쓰지 않는다 — 전부 결정론 검사다. Windows 예약 작업으로 주기 실행(install-maintenance-task.ps1).
//
// 하는 일:
//   ① 훅 회귀 테스트 (guard·secrets·format) — 배포된 안전장치가 여전히 작동하는지
//   ② install --verify — 소스↔배포본 드리프트·잔존 자산 검사
//   ③ memory-audit — 메모리 링크·인덱스·frontmatter 정합
// 이상이 있을 때만 비0 종료 + 요약 출력. 조용한 성공은 예약 작업 로그를 더럽히지 않는다.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const problems = [];

function step(label, argvRel) {
  const r = spawnSync(node, argvRel.map((a) => (a.startsWith('--') ? a : path.join(REPO, ...a.split('/')))), {
    encoding: 'utf8',
    cwd: REPO,
  });
  if (r.status !== 0) {
    problems.push(`${label} 실패 (exit ${r.status})`);
    const tail = (r.stdout || '').trim().split('\n').slice(-3).join('\n');
    if (tail) problems.push(`  ${tail.replace(/\n/g, '\n  ')}`);
  }
  return r.status === 0;
}

console.log(`[maintenance] ${new Date().toISOString?.() || ''} 로컬 점검 시작`);
step('훅: guard', ['hooks/guard.test.js']);
step('훅: secrets', ['hooks/secrets-guard.test.mjs']);
step('훅: format-changed', ['hooks/format-changed.test.mjs']);
step('드리프트: install --verify', ['install.mjs', '--verify']);
step('메모리 정합', ['scripts/memory-audit.mjs']);

if (problems.length) {
  console.error('[maintenance] 점검 실패 — 조치 필요:');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('[maintenance] 전 항목 정상 (훅·드리프트·메모리)');
process.exit(0);
