// G-HARNESS guard — PreToolUse 훅 (Bash|PowerShell)
// 재앙급 명령은 차단(deny)하고, 중위험 명령은 모델에게만 경고를 주입(warn)한다.
// 사용자를 절대 호출하지 않는다(ask 금지) — 오토 퍼미션을 준 사용자를 훅이 도로 불러세우면 안 된다 (2026-07-11 사용자 지시).
// 판단 대상이 아니면 아무 출력 없이 종료 → 일반 권한 흐름으로 넘어간다.
// 파싱 실패 시 개입하지 않는다(fail-open): 가드 버그가 모든 셸 명령을 마비시키면 안 된다.
// 알려진 한계(의도된 보수성): 명령 문자열 전체를 검사하므로 echo/커밋 메시지 등 문자열
// 리터럴 안의 위험 패턴도 걸린다. 따옴표를 벗기면 bash -c "..." 우회가 뚫리므로 벗기지 않는다.
// 그런 오탐을 만나면 위험 문자열을 파일에 써서(Write 도구) 파이프하는 식으로 우회하라.

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
  // 경고는 누적했다가 마지막에 한 번에 출력한다 — warn이 즉시 종료하면 같은 명령 뒤쪽의
  // 재앙급 deny(`rm -rf build && git push --force origin main`)를 가린다 (red-review C1, 회귀였음).
  const warns = [];
  const warn = (reason) => {
    if (!warns.includes(reason)) warns.push(reason);
  };
  const finish = () => {
    if (warns.length) {
      process.stdout.write(
        JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: warns.join(' ') + ' 대상 경로/브랜치가 의도한 것이 맞는지 확인하고 진행하라.',
          },
        })
      );
    }
    process.exit(0);
  };

  // ── 재앙급: 즉시 차단 ─────────────────────────────────────────────
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(cmd)) deny('[guard] 포크밤 패턴 차단');
  if (/\bmkfs(\.\w+)?\b/.test(cmd)) deny('[guard] 파일시스템 포맷(mkfs) 차단');
  if (/\bdd\b[^;|&]*\bof=\/dev\//.test(cmd)) deny('[guard] 디바이스 직접 쓰기(dd of=/dev/*) 차단');
  // 디바이스 직접 쓰기 (dd 없이 리다이렉트로 — 크로스벤더 감사 #10). /dev/null,/dev/stdin 등은 제외
  if (/>\s*\/dev\/(sd|nvme|hd|vd|mmcblk|disk|loop)/i.test(cmd)) deny('[guard] 디스크 디바이스 직접 쓰기 차단');
  // 디스크 포맷 cmdlet/명령 (크로스벤더 감사 #11)
  if (/\bFormat-Volume\b/i.test(cmd) || /\bformat\s+[a-zA-Z]:/i.test(cmd)) deny('[guard] 디스크 포맷 차단');
  // .NET 직접 재귀 삭제 (크로스벤더 감사 #8)
  if (/\[System\.IO\.Directory\]::Delete\s*\([^)]*,\s*\$true/i.test(cmd)) deny('[guard] .NET 재귀 디렉터리 삭제 차단');

  // 루트/홈/드라이브/시스템 디렉터리를 가리키는 토큰.
  // 시스템 디렉터리는 하위 경로·글롭까지 포함(/etc/*, /home/gkfkd 등 — 크로스벤더 감사 #4·#5).
  // 중괄호 변수 ${HOME}, ${env:USERPROFILE} 포함 (감사 #3).
  const ROOT =
    /(^|\s)["']?(\/\*?|~([\/\\]\*?)?|\$\{?(HOME|env:(USERPROFILE|HOME))\}?([\/\\]\S*)?|\$HOME([\/\\]\*?)?|%USERPROFILE%([\/\\]\*?)?|[A-Za-z]:[\/\\]{0,2}\*?|[Cc]:[\/\\]+Users[\/\\]+gkfkd([\/\\]\S*)?|\/(etc|usr|bin|sbin|lib|lib64|home|var|boot|opt|root|dev|sys)([\/\\]\S*)?)["']?(\s|$)/;

  // 상대경로로 루트를 향해 4단계 이상 등반 (감사 #2). 1~3단계는 warn 유지(정상 작업 흔함)
  const CLIMB = /(\.\.[\/\\]){4,}/;
  const reachesRoot = (s) => ROOT.test(s) || CLIMB.test(s);

  // find 기반 삭제: rm이 없어 기존 rm 분기를 우회 (감사 #1)
  if (/\bfind\b/.test(cmd) && /(-delete\b|-exec\s+rm\b)/.test(cmd)) {
    if (reachesRoot(cmd)) deny('[guard] find 기반 루트/홈/시스템 삭제 차단');
    warn('[guard] find 기반 대량 삭제(-delete/-exec rm).');
  }

  // rm: recursive + force 조합 (대문자 -R/-F 우회 방지 — 리뷰 발견 #1)
  const rFlag = /(^|\s)(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\s|$)/.test(cmd);
  const fFlag = /(^|\s)(-[a-zA-Z]*[fF][a-zA-Z]*|--force)(\s|$)/.test(cmd);
  if (/\brm\b/.test(cmd) && rFlag && fFlag) {
    if (reachesRoot(cmd)) deny('[guard] 루트/홈/드라이브 전체 삭제 차단');
    warn('[guard] 재귀 강제 삭제(rm -rf).');
  }

  // PowerShell 재귀 삭제 — 별칭(ri/rd/rmdir/del/erase)과 플래그 약어(-Rec) 포함 (감사 #6·#7)
  const psDelete = /\b(Remove-Item|ri|rd|rmdir|del|erase)\b/i.test(cmd);
  const psRecurse = /-rec/i.test(cmd) || /\s\/s\b/i.test(cmd); // -Recurse 약어 또는 cmd rd /s
  if (psDelete && psRecurse) {
    if (reachesRoot(cmd)) deny('[guard] 루트/홈/드라이브 전체 삭제 차단');
    warn('[guard] 재귀 삭제(Remove-Item/별칭).');
  }

  // 디스크 파괴 도구
  if (/\bshred\b/.test(cmd)) {
    if (/\/dev\//.test(cmd)) deny('[guard] 디스크 디바이스 파괴(shred) 차단');
    warn('[guard] shred — 파일을 복구 불가하게 덮어쓴다.');
  }
  if (/\btruncate\b/.test(cmd) && /-s\s*0\b/.test(cmd)) warn('[guard] truncate -s 0 — 파일 내용이 비워진다.');

  // ── 새 터미널/콘솔 창 금지 (2026-07-17 사용자 지시, #12 — red-review로 세그먼트 단위 재설계) ──
  // 모델의 한계: 작업 중 Start-Process·start로 새 콘솔 창을 띄워 사용자 화면을 어지럽힌다.
  // 세그먼트(;&|·개행 분할) 단위로 판정한다: 숨김 플래그가 다른 하위 명령에 있다고 전체가
  // 면제되면 안 되고(리뷰 C2), 인수·URL 속 단어(cmd.txt, …/powershell/…)로 오탐해도 안 된다(C4).
  // 남는 한계(수용): 따옴표 경로("C:\...\cmd.exe") 실행, -ArgumentList 문자열 안의 숨김 플래그
  // 오인 — 문자열 검사의 한계로, 헌법의 '새 터미널 창 금지' 규칙이 막는 영역.
  const TERM = "(?:cmd|powershell|pwsh|wt|conhost)(?:\\.exe)?";
  const CMDPOS = "(?:^|\\/[ck]\\s+)"; // 세그먼트 시작 또는 cmd /c·/k 뒤 = 명령 위치
  const HIDDEN_WINDOW = /-NoNewWindow\b|-WindowStyle\s+Hidden\b|(^|\s)\/b(\s|$)/i; // /b = cmd start의 무창 실행
  const PS_SPAWN = /\b(Start-Process|saps)\b/i;
  const START_AT_CMDPOS = new RegExp(CMDPOS + "start(?:\\.exe)?(\\s|$)", "i");
  // Start-Process 인수의 터미널 이름: 앞이 공백/따옴표/=, 뒤가 공백/따옴표/끝 — 경로·URL 조각 오탐 방지
  const TERM_AFTER_PS = new RegExp("\\b(?:Start-Process|saps)\\b.*?[\\s\"'=]" + TERM + "(?=[\\s\"']|$)", "i");
  // start 뒤 터미널: 첫 따옴표 인수는 창 제목(`start "" cmd` 관용구)이므로 건너뛴다 (리뷰 C3①)
  const TERM_AFTER_START = new RegExp(CMDPOS + "start(?:\\.exe)?\\s+(?:\"[^\"]*\"\\s+)?(?:\\/\\w+\\s+)*[\"']?" + TERM + "\\b", "i");
  const WT_AT_CMDPOS = new RegExp(CMDPOS + "wt(?:\\.exe)?(\\s|$)", "i"); // cmd /c wt·개행 뒤 wt 포함 (C3③/S4)
  const BARE_START = new RegExp(CMDPOS + "start(?:\\.exe)?\\s*$", "i"); // 맨몸 start = 새 cmd 창 (C3②)
  for (const rawSeg of cmd.split(/[;&|\n]+/)) {
    const seg = rawSeg.trim();
    if (!seg || HIDDEN_WINDOW.test(seg)) continue; // 이 세그먼트는 창을 만들지 않는다
    if (TERM_AFTER_PS.test(seg) || TERM_AFTER_START.test(seg) || WT_AT_CMDPOS.test(seg) || BARE_START.test(seg))
      deny('[guard] 새 터미널 창 실행 차단 — 창을 띄우지 말고 현재 세션에서 직접 실행하라 (백그라운드는 run_in_background)');
    if (PS_SPAWN.test(seg) || START_AT_CMDPOS.test(seg))
      warn('[guard] Start-Process/start는 콘솔 앱이면 새 창을 띄운다 — 직접 실행하거나 -NoNewWindow·-WindowStyle Hidden을 쓰고, 화면에 창을 띄우지 마라.');
  }

  // git push 강제 (해당 명령 구간만 검사해 오탐 축소)
  const pushIdx = cmd.search(/\bgit\s+push\b/);
  if (pushIdx >= 0) {
    const seg = cmd.slice(pushIdx).split(/[;&|]/)[0];
    const force =
      /(^|\s)(--force(?!-with-lease)|-f)(\s|$)/.test(seg) || /\s\+\S+/.test(seg);
    if (force) {
      // main/master가 목적지일 때 차단. full-ref(refs/heads/main)까지 포함, main-backup 오탐은 제외 (감사 #9, 리뷰 발견 #6)
      if (/(^|\s|:|\+|\/)(main|master)(\s|$)/.test(seg))
        deny('[guard] main/master 강제 푸시 차단 — 필요하면 --force-with-lease를 별도 브랜치에');
      warn('[guard] 강제 푸시.');
    }
  }

  // 작업 내역 파괴 계열: 경고 주입 후 진행
  if (/\bgit\s+reset\s+--hard\b/.test(cmd))
    warn('[guard] git reset --hard — 커밋 안 된 변경이 사라진다.');
  if (/\bgit\s+clean\b/.test(cmd) && /(^|\s)-[a-zA-Z]*f[a-zA-Z]*(\s|$)/.test(cmd))
    warn('[guard] git clean -f — 추적 안 된 파일이 삭제된다.');

  finish(); // 누적된 경고가 있으면 출력하고 종료 (없으면 무개입)
});
