// guard.js 회귀 테스트 — 패턴을 고치면 반드시 여기에 케이스를 먼저 추가하고 돌린다.
// 판정: deny(차단) / warn(모델에게만 경고 주입, 실행 허용) / none(무개입)
// 실행: node hooks/guard.test.js
const { spawnSync } = require('child_process');
const path = require('path');
const GUARD = path.join(__dirname, 'guard.js');
const cases = [
  ['ls -la', 'none'],
  ['git status', 'none'],
  ['git push origin feature', 'none'],
  ['git push --force origin main', 'deny'],
  ['git push -f origin master', 'deny'],
  ['git push --force-with-lease origin feat', 'none'],
  ['git push -f origin feat', 'warn'],
  ['git push origin +main', 'deny'],
  ['rm -rf /', 'deny'],
  ['rm -rf ~', 'deny'],
  ['rm -rf $HOME', 'deny'],
  ['rm -rf C:\\', 'deny'],
  ['rm -r -f node_modules', 'warn'],
  ['rm -rf ./build', 'warn'],
  ['rm build.log', 'none'],
  ['git reset --hard HEAD~1', 'warn'],
  ['git reset --soft HEAD~1', 'none'],
  ['git clean -fd', 'warn'],
  ['npm run format', 'none'],
  ['git log --format=%H', 'none'],
  ['Remove-Item -Recurse -Force C:\\', 'deny'],
  ['Remove-Item -Recurse -Force C:\\Users\\gkfkd', 'deny'],
  ['Remove-Item -Recurse .\\build', 'warn'],
  ['Remove-Item old.txt', 'none'],
  ['grep -rf pattern file.txt', 'none'],
  ['mkfs.ext4 /dev/sda1', 'deny'],
  ['echo hello > out.txt', 'none'],
  // 리뷰 발견 #1: 대문자 플래그 우회
  ['rm -Rf /', 'deny'],
  ['rm -rF ~', 'deny'],
  ['rm -R -f build', 'warn'],
  // 리뷰 발견 #2: 루트 글롭·시스템 디렉터리
  ['rm -rf /*', 'deny'],
  ['rm -rf /etc', 'deny'],
  ['rm -rf /tmp/xyz', 'warn'],
  // 리뷰 발견 #6: 브랜치명 오탐/목적지 판별
  ['git push --force origin main-backup', 'warn'],
  ['git push -f origin dev:main', 'deny'],
];
let fail = 0;
for (const [cmd, expect] of cases) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }),
    encoding: 'utf8',
  });
  let got = 'none';
  if (r.stdout && r.stdout.trim()) {
    try {
      const out = JSON.parse(r.stdout);
      const h = out.hookSpecificOutput || {};
      got = h.permissionDecision || (h.additionalContext ? 'warn' : 'PARSE_ERR:' + r.stdout);
    } catch (e) { got = 'PARSE_ERR:' + r.stdout; }
  }
  const ok = got === expect;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  expect=${expect} got=${got}  :: ${cmd}`);
}
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
