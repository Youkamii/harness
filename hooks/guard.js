// G-HARNESS guard — PreToolUse 훅 (Bash|PowerShell)
// 재앙급 명령은 차단(deny)하고, 중위험 명령은 모델에게만 경고를 주입(warn)한다.
// 사용자를 절대 호출하지 않는다(ask 금지) — 오토 퍼미션을 준 사용자를 훅이 도로 불러세우면 안 된다 (2026-07-11 사용자 지시).
// 판단 대상이 아니면 아무 출력 없이 종료 → 일반 권한 흐름으로 넘어간다.
// 파싱 실패 시 개입하지 않는다(fail-open): 가드 버그가 모든 셸 명령을 마비시키면 안 된다.

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = ((JSON.parse(raw) || {}).tool_input || {}).command || '';
  } catch (e) {
    process.exit(0);
  }
  if (!cmd) process.exit(0);

  const deny = (reason) => {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })
    );
    process.exit(0);
  };

  // 중위험: 실행을 막지 않고 모델에게만 경고를 주입한다. 사용자에게 묻지 않는다.
  const warn = (reason) => {
    process.stdout.write(
      JSON.stringify({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: reason + ' 대상 경로/브랜치가 의도한 것이 맞는지 확인하고 진행하라.',
        },
      })
    );
    process.exit(0);
  };

  // ── 재앙급: 즉시 차단 ─────────────────────────────────────────────
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(cmd)) deny('[guard] 포크밤 패턴 차단');
  if (/\bmkfs(\.\w+)?\b/.test(cmd)) deny('[guard] 파일시스템 포맷(mkfs) 차단');
  if (/\bdd\b[^;|&]*\bof=\/dev\//.test(cmd)) deny('[guard] 디바이스 직접 쓰기(dd of=/dev/*) 차단');

  // 루트/홈/드라이브 전체를 가리키는 토큰
  const ROOT =
    /(^|\s)["']?(\/|~[\/\\]?|\$HOME[\/\\]?|\$env:USERPROFILE[\/\\]?|%USERPROFILE%[\/\\]?|[A-Za-z]:[\/\\]{0,2}|[Cc]:[\/\\]+Users[\/\\]+gkfkd[\/\\]?)["']?(\s|$)/;

  // rm: recursive + force 조합
  const rFlag = /(^|\s)(-[a-zA-Z]*r[a-zA-Z]*|--recursive)(\s|$)/.test(cmd);
  const fFlag = /(^|\s)(-[a-zA-Z]*f[a-zA-Z]*|--force)(\s|$)/.test(cmd);
  if (/\brm\b/.test(cmd) && rFlag && fFlag) {
    if (ROOT.test(cmd)) deny('[guard] 루트/홈/드라이브 전체 삭제 차단');
    warn('[guard] 재귀 강제 삭제(rm -rf).');
  }

  // Remove-Item -Recurse
  if (/\bRemove-Item\b/i.test(cmd) && /-Recurse\b/i.test(cmd)) {
    if (ROOT.test(cmd)) deny('[guard] 루트/홈/드라이브 전체 삭제 차단');
    warn('[guard] 재귀 삭제(Remove-Item -Recurse).');
  }

  // git push 강제 (해당 명령 구간만 검사해 오탐 축소)
  const pushIdx = cmd.search(/\bgit\s+push\b/);
  if (pushIdx >= 0) {
    const seg = cmd.slice(pushIdx).split(/[;&|]/)[0];
    const force =
      /(^|\s)(--force(?!-with-lease)|-f)(\s|$)/.test(seg) || /\s\+\S+/.test(seg);
    if (force) {
      if (/\b(main|master)\b/.test(seg))
        deny('[guard] main/master 강제 푸시 차단 — 필요하면 --force-with-lease를 별도 브랜치에');
      warn('[guard] 강제 푸시.');
    }
  }

  // 작업 내역 파괴 계열: 경고 주입 후 진행
  if (/\bgit\s+reset\s+--hard\b/.test(cmd))
    warn('[guard] git reset --hard — 커밋 안 된 변경이 사라진다.');
  if (/\bgit\s+clean\b/.test(cmd) && /(^|\s)-[a-zA-Z]*f[a-zA-Z]*(\s|$)/.test(cmd))
    warn('[guard] git clean -f — 추적 안 된 파일이 삭제된다.');

  process.exit(0); // 판단 없음
});
