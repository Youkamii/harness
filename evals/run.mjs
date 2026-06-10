#!/usr/bin/env node
// evals 러너: 하네스 수정이 개선인지 측정한다.
// 각 태스크(evals/tasks/<이름>/)를 빈 임시 폴더에서 claude -p 로 실행하고,
// check.sh(결정적 채점)로 PASS/FAIL을 판정한다. "느낌상 좋아짐"이 아니라 측정.
//
// 사용법:
//   node evals/run.mjs           # 모든 태스크 실행
//   node evals/run.mjs fizzbuzz  # 특정 태스크만

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evalsDir = path.dirname(fileURLToPath(import.meta.url));
const tasksDir = path.join(evalsDir, 'tasks');
const resultsDir = path.join(evalsDir, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const filter = process.argv[2];
const tasks = fs
  .readdirSync(tasksDir)
  .filter((t) => fs.existsSync(path.join(tasksDir, t, 'task.md')))
  .filter((t) => !filter || t === filter);

if (tasks.length === 0) {
  console.error('실행할 태스크가 없습니다. evals/tasks/<이름>/task.md 형태로 추가하세요.');
  process.exit(1);
}

const results = [];
for (const task of tasks) {
  const taskDir = path.join(tasksDir, task);
  const prompt = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `harness-eval-${task}-`));
  process.stdout.write(`▸ ${task} ... `);

  const started = Date.now();
  const run = spawnSync('claude', ['-p', prompt, '--dangerously-skip-permissions'], {
    cwd: tmp,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationS = Math.round((Date.now() - started) / 1000);

  // 채점: check.sh 가 exit 0 이면 PASS. 에이전트 출력이 아니라 결과물을 본다.
  const check = spawnSync('bash', [path.join(taskDir, 'check.sh')], { cwd: tmp, encoding: 'utf8' });
  const pass = check.status === 0;
  console.log(`${pass ? 'PASS' : 'FAIL'} (${durationS}s)  작업폴더: ${tmp}`);
  if (!pass) console.log(`  채점 출력: ${(check.stdout + check.stderr).trim().slice(0, 500)}`);

  results.push({ task, pass, durationS, tmp, agentExit: run.status });
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n결과: ${passed}/${results.length} PASS`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(resultsDir, `${stamp}.json`), JSON.stringify(results, null, 2));
process.exit(passed === results.length ? 0 : 1);
