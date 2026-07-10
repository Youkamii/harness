#!/usr/bin/env node
// PreToolUse 훅: Bash 명령을 실행 직전에 검사해 파괴적 명령을 차단한다.
// 설정(permissions)의 ask/deny는 '승인 절차'이고, 이 훅은 승인 절차를 건너뛰는
// 모드(--dangerously-skip-permissions, 장기 실행)에서도 항상 작동하는 최후의 방어선이다.
//
// 설계 원칙 5: 각 규칙에 "왜 존재하는가"를 기록한다.
// 이 규칙들은 모델의 판단 실수를 가정한 것이므로, 모델이 좋아져도 비용이 0에 가까워 유지한다.

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // 입력 파싱 실패 시 차단하지 않음 (훅 오류로 작업 전체를 막지 않기 위해)
  }
  if (input.tool_name !== 'Bash') process.exit(0);
  const cmd = (input.tool_input && input.tool_input.command) || '';

  const RULES = [
    {
      re: /rm\s+(-\w*r\w*f|-\w*f\w*r|--recursive\s+--force)\s+["']?(\/(?!tmp\b)|~|\$HOME)/,
      why: '홈/루트 경로 재귀 강제 삭제는 복구 불가능',
    },
    { re: /\bsudo\s+rm\b/, why: '루트 권한 삭제는 시스템 파일을 지울 수 있음' },
    {
      re: /\bgit\s+push\b[^|;&]*\s(--force(?!-with-lease)|-f)(\s|$)/,
      why: '강제 푸시는 원격 히스토리를 파괴 (--force-with-lease는 허용)',
    },
    { re: /\bdd\s+[^|;&]*\bof=\/dev\//, why: '디스크 장치에 직접 쓰기' },
    { re: /\bmkfs\b/, why: '파일시스템 포맷' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, why: '포크밤 (시스템 멈춤)' },
    { re: /\bchmod\s+(-R\s+)?777\s+\//, why: '루트 경로 권한 전체 개방' },
    { re: />\s*\/dev\/sd[a-z]/, why: '디스크 장치 덮어쓰기' },
  ];

  for (const r of RULES) {
    if (r.re.test(cmd)) {
      // exit 2 = 차단. stderr 메시지는 모델에게 전달되어 이유를 알 수 있다.
      console.error(`[guard] 차단됨 — ${r.why}. 명령: ${cmd}`);
      process.exit(2);
    }
  }
  process.exit(0);
});
