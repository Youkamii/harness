#!/usr/bin/env node
// secrets-guard.js 회귀 테스트 — 실제 git 저장소를 임시로 만들어 검증한다.
// 실행: node .claude/hooks/secrets-guard.test.mjs
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), 'secrets-guard.js');

const runHook = (cwd, command) =>
  spawnSync('node', [guard], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
  });

const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-guard-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};

let fail = 0;
const expect = (name, res, code) => {
  if (res.status !== code) {
    console.error(`✗ ${name}: exit=${res.status} (기대 ${code})\n  ${res.stderr.trim().slice(0, 200)}`);
    fail++;
  }
};

// 1) 가짜 AWS 키가 든 파일을 add+commit → 차단
{
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'config.js'), 'const k = "AKIA' + 'IOSFODNN7EXAMPLE";\n');
  expect('AWS키 add+commit 차단', runHook(dir, 'git add -A && git commit -m x'), 2);
}
// 2) 이미 스테이징된 비밀 → commit 만으로도 차단
{
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'token = "ghp_' + 'a'.repeat(36) + '"\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  expect('스테이징된 GitHub토큰 commit 차단', runHook(dir, 'git commit -m x'), 2);
}
// 3) .env 파일은 내용과 무관하게 차단, .env.example 은 허용
{
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.env'), 'FOO=bar\n');
  expect('.env add 차단', runHook(dir, 'git add . && git commit -m x'), 2);
  const dir2 = makeRepo();
  fs.writeFileSync(path.join(dir2, '.env.example'), 'FOO=값을_여기에\n');
  expect('.env.example 허용', runHook(dir2, 'git add . && git commit -m x'), 0);
}
// 4) 평범한 코드 → 통과
{
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'app.js'), 'const apiKey = process.env.API_KEY;\nconsole.log("hello");\n');
  expect('정상 코드 통과', runHook(dir, 'git add -A && git commit -m x'), 0);
}
// 5) 하드코딩 password 추정 패턴 → 차단
{
  const dir = makeRepo();
  // 문자열을 쪼개 쓰는 이유: 이 테스트 파일 자체가 secrets-guard 검사에 걸리지 않게 (실제로 차단된 적 있음)
  fs.writeFileSync(path.join(dir, 'db.py'), 'pass' + 'word = "supersecret123"\n');
  expect('하드코딩 password 차단', runHook(dir, 'git add db.py && git commit -m x'), 2);
}
// 6) git 무관 명령 → 통과 / 깨진 입력 → 통과
expect('git 무관 명령 통과', runHook(os.tmpdir(), 'ls -la'), 0);
{
  const res = spawnSync('node', [guard], { input: 'not json', encoding: 'utf8' });
  expect('깨진 입력 통과', res, 0);
}

if (fail === 0) console.log('✓ secrets-guard.test 통과 (차단 4건, 허용 4건)');
process.exit(fail === 0 ? 0 : 1);
