#!/usr/bin/env node
// cross-review 실행기: codex 최고 모델과 claude 최고 모델을 병렬로 띄워
// 같은 컨텍스트를 독립적으로 검증/리뷰시키고, 보고서 2개를 .harness/reviews/ 에 저장한다.
//
// 독립된 두 모델을 쓰는 이유: 한 모델의 맹점(자기 스타일에 대한 관대함, 학습 편향)을
// 다른 모델이 잡는다 — 리서치의 '작업자/평가자 분리' 원칙의 모델 차원 확장.
//
// 사용법:
//   node run-reviewers.mjs --mode verify|review --context <컨텍스트파일> [--cwd 대상폴더]
//     [--codex-model gpt-5.5] [--claude-model claude-opus-4-8] [--timeout-min 20]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const mode = opt('mode', null);
const contextPath = opt('context', null);
const cwd = path.resolve(opt('cwd', process.cwd()));
const codexModel = opt('codex-model', 'gpt-5.5'); // 사용자 codex 기본값이 이미 최고 설정(xhigh)
const claudeModel = opt('claude-model', 'claude-opus-4-8'); // Claude 최상위 모델
const timeoutMs = parseInt(opt('timeout-min', '20'), 10) * 60_000;

const PROMPTS = {
  verify: `너는 적대적 검증자다. 이 프로젝트의 문서·요구사항·태스크 설계를 비판적으로 검증하라. 칭찬은 금지다. "발견 없음"으로 쉽게 결론 내리지 말고 끝까지 의심하라.

검증 항목:
1. 요구사항 정합성 — 문서와 개발 방향이 요구사항을 누락·왜곡 없이 반영하는가. 요구사항끼리 모순되는 곳은 없는가.
2. 태스크 설계 논리 — 작업 순서와 의존성이 타당한가. 빠진 단계, 근거 없는 가정, 과잉 설계는 없는가.
3. 잠재 문제 — 이미 작성되어 있으나 나중에 문제가 될 수 있는 부분: 숨은 가정, 처리 안 된 엣지케이스, 보안 위험, 확장성·유지보수 함정, 문서 간 불일치.

각 발견은 다음 형식으로: [심각도: critical/major/minor] 위치(파일:라인 또는 문서 섹션) / 무엇이 문제인가 / 근거 / 권장 조치.
직접 확인하지 못한 것은 '추정'이라고 표시하라. 마지막에 심각도순 요약 표를 붙여라.`,

  review: `너는 시니어 코드 리뷰어다. 문서와 태스크를 기준 삼아 커밋 히스토리·이슈·코드를 직접 읽고 개발이 잘 되고 있는지 검사하라. git log, git diff, 이슈 목록을 실제로 확인하라.

리뷰 항목:
1. 진행 정합성 — 커밋들이 계획된 태스크·문서와 맞는 방향인가. 계획에 없는 이탈이나 미완성인 채 완료 처리된 것은 없는가.
2. 코드 품질 — 구조, 중복, 가독성, 에러 처리, 테스트 유무와 실효성.
3. 보안 — 비밀값 노출, 입력 검증 누락, 권한 처리, 위험한 의존성.
4. 버그 가능성 — 경계 조건, 동시성, 자원 누수, 잘못된 가정.

각 발견은 다음 형식으로: [심각도: critical/major/minor] 파일:라인 / 무엇이 문제인가 / 근거 / 권장 조치.
직접 확인하지 못한 것은 '추정'이라고 표시하라. 마지막에 심각도순 요약 표를 붙여라.`,
};

if (!PROMPTS[mode] || !contextPath || !fs.existsSync(contextPath)) {
  console.error('사용법: node run-reviewers.mjs --mode verify|review --context <파일> [--cwd DIR]');
  process.exit(1);
}

const COMMON = '\n\n공통 규칙: 어떤 파일도 수정하지 마라(읽기 전용). 출력은 한국어 마크다운 보고서로만 작성하라.';
const prompt = PROMPTS[mode] + COMMON + '\n\n---\n# 프로젝트 컨텍스트\n\n' + fs.readFileSync(contextPath, 'utf8');

const outDir = path.join(cwd, '.harness', 'reviews');
fs.mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

const runners = [
  {
    name: 'codex',
    cmd: 'codex',
    args: ['exec', '-s', 'read-only', '-m', codexModel, '-c', 'model_reasoning_effort="xhigh"', prompt],
  },
  {
    name: 'claude',
    cmd: 'claude',
    args: ['-p', prompt, '--model', claudeModel],
  },
];

const runOne = ({ name, cmd, args }) =>
  new Promise((resolve) => {
    const started = Date.now();
    const outFile = path.join(outDir, `${ts}-${mode}-${name}.md`);
    console.log(`▸ ${name} 시작 (모델: ${name === 'codex' ? codexModel + '/xhigh' : claudeModel})`);
    // stdin은 ignore 필수: codex exec 는 stdin 파이프가 열려 있으면 입력을 기다리며 영원히 멈춘다 (스모크 테스트에서 실제 발생)
    const p = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const killer = setTimeout(() => { p.kill('SIGTERM'); }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(killer);
      const sec = Math.round((Date.now() - started) / 1000);
      const timedOut = sec >= timeoutMs / 1000 - 2;
      fs.writeFileSync(outFile, out || `(출력 없음)\n\nstderr:\n${err}`);
      console.log(`✓ ${name} 완료 (${sec}s, exit=${code}${timedOut ? ', 시간초과로 중단됨' : ''}) → ${outFile}`);
      resolve({ name, outFile, code, sec, timedOut, bytes: out.length });
    });
    p.on('error', (e) => {
      clearTimeout(killer);
      fs.writeFileSync(outFile, `(실행 실패: ${e.message})`);
      console.log(`✗ ${name} 실행 실패: ${e.message} — CLI 설치/로그인 확인 필요`);
      resolve({ name, outFile, code: -1, error: e.message });
    });
  });

const results = await Promise.all(runners.map(runOne));
console.log('\nSYNTHESIS_READY ' + JSON.stringify(results.map(({ name, outFile, code }) => ({ name, outFile, code }))));
