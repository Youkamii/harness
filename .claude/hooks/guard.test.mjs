#!/usr/bin/env node
// guard.js 회귀 테스트. 규칙을 수정하면 반드시 실행: node .claude/hooks/guard.test.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guard.js');

const MUST_BLOCK = [
  'rm -rf ~/Documents',
  'rm -rf /usr/local',
  'rm -fr $HOME/stuff',
  'sudo rm /etc/hosts',
  'git push origin main --force',
  'git push -f origin main',
  'dd if=/dev/zero of=/dev/disk0',
  'mkfs.ext4 /dev/sda1',
  'chmod -R 777 /',
];

const MUST_ALLOW = [
  'ls -la',
  'rm -rf ./node_modules',
  'rm -rf /tmp/test',
  'git push origin main',
  'git push --force-with-lease origin feature',
  'echo "rm -rf 라는 문자열을 출력만 함"', // 따옴표 안 문자열도 명령은 echo — 과차단 허용(안전 우선)
  'npm install',
];

const run = (command) =>
  spawnSync('node', [guard], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  }).status;

let fail = 0;
for (const c of MUST_BLOCK) {
  const code = run(c);
  if (code !== 2) { console.error(`✗ 차단 실패 (exit=${code}): ${c}`); fail++; }
}
for (const c of MUST_ALLOW.filter((c) => !/rm -rf 라는/.test(c))) {
  const code = run(c);
  if (code !== 0) { console.error(`✗ 과차단 (exit=${code}): ${c}`); fail++; }
}
// 깨진 입력은 차단하지 않아야 함 (훅 오류로 전체 작업을 막지 않기)
const badInput = spawnSync('node', [guard], { input: 'not json', encoding: 'utf8' }).status;
if (badInput !== 0) { console.error(`✗ 깨진 입력에서 exit=${badInput}`); fail++; }

if (fail === 0) console.log(`✓ guard.test 통과 (차단 ${MUST_BLOCK.length}건, 허용 ${MUST_ALLOW.length - 1}건, 깨진입력 1건)`);
process.exit(fail === 0 ? 0 : 1);
