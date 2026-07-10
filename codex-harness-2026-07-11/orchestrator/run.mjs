#!/usr/bin/env node
// 장기 실행 오케스트레이터.
// Claude Code(구독 결제)를 헤드리스(claude -p)로 세션 단위 반복 호출한다.
//
// 리서치 근거 (docs/harness-engineering-research.md):
// - 컨텍스트 압축보다 "세션 리셋 + 파일 아티팩트"가 장기 작업에 우수 → 세션마다 새로 시작
// - 첫 세션은 initializer(환경·기능목록 준비), 이후는 coder(한 기능씩) — 프롬프트만 다름
// - 안티패턴 방지: 한 번에 한 기능, 실행 검증 없는 완료 금지 (프롬프트에 명시)
// - 위험 명령은 .claude/hooks/guard.js가 권한 생략 모드에서도 차단
//
// 사용법:
//   node orchestrator/run.mjs "<목표>" [--cwd 대상폴더] [--max-sessions 20] [--model 모델ID]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isLimitMessage, msUntilReset, sleep, DEFAULT_WAIT_MS } from './limits.mjs';

// ---- 인자 파싱 ----
const argv = process.argv.slice(2);
const goal = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
if (!goal) {
  console.error('사용법: node orchestrator/run.mjs "<목표>" [--cwd DIR] [--max-sessions N] [--model ID]');
  process.exit(1);
}
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const workDir = path.resolve(opt('cwd', process.cwd()));
const maxSessions = parseInt(opt('max-sessions', '20'), 10);
const model = opt('model', null);

const harnessDir = path.join(workDir, '.harness');
const featuresPath = path.join(harnessDir, 'features.json');
const progressPath = path.join(harnessDir, 'progress.md');
const sessionsDir = path.join(harnessDir, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

// ---- 프롬프트 ----
const initPrompt = `너는 장기 작업의 첫 세션(initializer)이다. 목표:

${goal}

이 세션에서는 기능 구현을 하지 말고 다음만 수행하라:
1. 목표를 작은 기능 단위로 분해해 .harness/features.json 을 작성하라.
   형식: [{"id": "f1", "description": "...", "status": "failing"}] — 전부 "failing"으로 시작한다.
2. 필요한 개발 환경을 초기화하라 (git init 포함, 이미 있으면 생략).
3. .harness/progress.md 를 만들고 첫 항목(무엇을 준비했고 다음 세션이 뭘 해야 하는지)을 기록하라.
4. 서술적인 메시지로 커밋하라.`;

const codePrompt = `너는 장기 작업의 진행 세션(coder)이다. 전체 목표:

${goal}

순서대로 수행하라:
1. .harness/progress.md 와 .harness/features.json, git log 를 먼저 읽고 현재 상태를 파악하라.
2. "failing" 기능 중 딱 하나만 골라 구현하라. 여러 개를 건드리지 마라.
3. 실제로 실행해서 end-to-end로 검증하라. 검증을 통과한 경우에만 features.json 에서 그 항목을 "passing"으로 바꿔라.
4. .harness/progress.md 에 이번 세션 기록(완료한 것/다음 할 일/주의사항)을 추가하라.
5. 서술적인 메시지로 커밋하라.

모든 기능이 "passing"이면 아무 작업도 하지 말고 정확히 ALL_FEATURES_COMPLETE 라고만 출력하라.`;

// ---- 세션 루프 ----
const allPassing = () => {
  try {
    const f = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
    return Array.isArray(f) && f.length > 0 && f.every((x) => x.status === 'passing');
  } catch {
    return false;
  }
};

let session = 0;
while (session < maxSessions) {
  const isInit = !fs.existsSync(featuresPath);
  const prompt = isInit ? initPrompt : codePrompt;
  const label = isInit ? 'initializer' : 'coder';
  session += 1;
  console.log(`\n=== 세션 ${session}/${maxSessions} (${label}) — ${new Date().toLocaleString()} ===`);

  const args = ['-p', prompt, '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);
  const res = spawnSync('claude', args, {
    cwd: workDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  fs.writeFileSync(path.join(sessionsDir, `${String(session).padStart(3, '0')}-${label}.log`), output);

  if (isLimitMessage(output)) {
    const wait = msUntilReset(output) ?? DEFAULT_WAIT_MS;
    session -= 1; // 한도 대기는 세션 횟수에서 제외
    console.log(`구독 사용량 한도 도달 — ${Math.round(wait / 60000)}분 대기 후 재개합니다. (추가 요금 없음)`);
    await sleep(wait);
    continue;
  }
  if (res.error) {
    console.error(`claude 실행 실패: ${res.error.message} — claude CLI가 설치/로그인되어 있는지 확인하세요.`);
    process.exit(1);
  }

  console.log(output.trim().slice(-2000)); // 세션 출력 끝부분만 표시 (전체는 .harness/sessions/)

  if (/ALL_FEATURES_COMPLETE/.test(output) || allPassing()) {
    console.log('\n✓ 모든 기능 passing — 작업 완료.');
    process.exit(0);
  }
}
console.log(`\n최대 세션 수(${maxSessions}) 도달. 진행 상황은 ${progressPath} 참고. 같은 명령으로 재개할 수 있습니다.`);
