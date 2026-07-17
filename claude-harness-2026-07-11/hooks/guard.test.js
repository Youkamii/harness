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
  // ── Phase 2 C1 적대 감사 (크로스벤더 red-review 재현본) ──
  // find 기반 삭제 (rm 없이 루트/홈 전멸)
  ['find / -delete', 'deny'],
  ['find ~ -delete', 'deny'],
  ['find / -exec rm {} +', 'deny'],
  ['find /home/gkfkd -delete', 'deny'],
  ['find . -name "*.tmp" -delete', 'warn'],
  ['find . -delete', 'warn'],
  ['find node_modules -type f -delete', 'warn'],
  // 중괄호 변수 우회
  ['rm -rf ${HOME}', 'deny'],
  ['rm -rf ${HOME}/', 'deny'],
  ['rm -rf ${env:USERPROFILE}', 'deny'],
  // 시스템 디렉터리 glob·심층 경로
  ['rm -rf /etc/*', 'deny'],
  ['rm -rf /home/*', 'deny'],
  ['rm -rf /usr/local', 'deny'],
  ['rm -rf /home/gkfkd', 'deny'],
  ['rm -rf /var/lib/xyz', 'deny'],
  ['rm -rf /tmp/xyz', 'warn'],
  // 상대경로 루트 등반 (4단계 이상)
  ['rm -rf ../../../../', 'deny'],
  ['rm -rf ../../../../etc', 'deny'],
  ['rm -rf ../build', 'warn'],
  ['rm -rf ../../node_modules', 'warn'],
  // PowerShell 삭제 별칭 + 플래그 약어
  ['del -Recurse -Force C:\\', 'deny'],
  ['ri -Recurse -Force C:\\', 'deny'],
  ['rd C:\\Users\\gkfkd -Recurse -Force', 'deny'],
  ['Remove-Item -Rec -Force C:\\', 'deny'],
  ['Remove-Item C:\\ -rec -force', 'deny'],
  ['del old.txt', 'none'],
  ['ri notes.md', 'none'],
  // .NET 직접 삭제
  ['[System.IO.Directory]::Delete("C:\\", $true)', 'deny'],
  // full-ref 강제 푸시
  ['git push --force origin HEAD:refs/heads/main', 'deny'],
  ['git push origin +refs/heads/main', 'deny'],
  ['git push --force origin dev:refs/heads/master', 'deny'],
  ['git push -f origin HEAD:refs/heads/feature', 'warn'],
  // 디바이스 직접 쓰기 (dd 없이)
  ['cat /dev/zero > /dev/sda', 'deny'],
  ['echo x > /dev/nvme0n1', 'deny'],
  ['echo done > /dev/null', 'none'],
  ['npm test 2> /dev/null', 'none'],
  // Windows 포맷
  ['Format-Volume -DriveLetter C', 'deny'],
  ['format C:', 'deny'],
  // 디스크 파괴 도구
  ['shred -uz /dev/sda', 'deny'],
  ['shred -u secret.txt', 'warn'],
  ['truncate -s 0 prod.db', 'warn'],
  // ── 새 터미널 창 금지 (2026-07-17 사용자 지시 — 이슈 #12) ──
  // 터미널 에뮬레이터를 새 창으로 여는 명령은 deny
  ['Start-Process cmd', 'deny'],
  ['Start-Process powershell -ArgumentList "-File a.ps1"', 'deny'],
  ['Start-Process pwsh -Verb RunAs', 'deny'],
  ['Start-Process wt', 'deny'],
  ['Start-Process -FilePath cmd.exe', 'deny'],
  ['start powershell', 'deny'],
  ['start cmd /k "npm run dev"', 'deny'],
  ['cmd /c start cmd', 'deny'],
  ['start /min powershell -File x.ps1', 'deny'],
  ['wt new-tab -d .', 'deny'],
  ['wt', 'deny'],
  ['saps pwsh', 'deny'],
  // 숨김 플래그가 있으면 창이 안 뜨므로 통과
  ['Start-Process node -NoNewWindow -Wait', 'none'],
  ['Start-Process myapp -WindowStyle Hidden', 'none'],
  // 그 외 Start-Process/start 별칭은 warn (콘솔 앱이면 창이 뜬다)
  ['Start-Process notepad', 'warn'],
  ['Start-Process node -ArgumentList "server.js"', 'warn'],
  ['start https://example.com', 'warn'],
  ['start .', 'warn'],
  // 오탐 금지: start가 다른 도구의 서브커맨드/단어 일부인 경우
  ['npm start', 'none'],
  ['docker start mycontainer', 'none'],
  ['systemctl start nginx', 'none'],
  ['pm2 start app.js', 'none'],
  ['git config --get alias.restart', 'none'],
  ['echo wt-report.txt', 'none'],
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
