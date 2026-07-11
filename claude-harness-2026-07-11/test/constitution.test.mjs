// 헌법(CLAUDE.md) 충돌 fixture 테스트 — "이 상황에서 헌법이 답을 갖고 있는가"를 검사한다.
// 헌법을 편집하다가 시나리오의 근거 문구가 사라지면 여기서 깨진다 (판단 공백 회귀 방지).
// 실행: node test/constitution.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('[1] 필수 섹션이 존재한다');
const SECTIONS = [
  '## 규칙 우선순위',
  '## 자율 원칙',
  '## 사실과 추측의 구분',
  '## 기능 개발 파이프라인',
  '## 안전장치',
  '## 세션 연속성',
];
for (const s of SECTIONS) {
  check(`섹션: ${s}`, doc.includes(s));
}

console.log('[2] 충돌 시나리오마다 판정 근거 문구가 존재한다');
// [시나리오, 앵커 정규식, 기대 판정 요약]
// 앵커는 핵심 키워드 2~3개 수준으로 느슨하게 — 축어 매칭은 의미 보존 수정까지 차단해
// "수정 때마다 테스트를 기계적으로 동기화"하게 만든다 (red-review 발견).
// 규칙을 삭제하면 깨지고, 표현만 다듬으면 살아남는 수준이 목표다.
const SCENARIOS = [
  ['비용 발생 작업을 만나면', /비용 발생.*확인|확인.*비용 발생/s, '멈추고 확인'],
  ['본인 소유 저장소 push·이슈 조작', /본인 소유 저장소.*일상 작업/s, '확인 없이 진행'],
  ['훅이 명령을 차단하면', /(훅의 차단|guard).*우회하지 않는다/s, '우회 금지'],
  ['스킬 지시가 헌법과 충돌하면', /충돌하면 헌법을 따른다/, '헌법 우선'],
  ['실행 안 해본 코드를 보고할 때', /실행해본 것만.*동작/s, '동작 단정 금지'],
  ['같은 모델을 여러 번 돌려 검증하려 할 때', /다수결은 독립 검증이 아니다/, '외부 증거 요구'],
  ['확인됨 승격 조건', /확인됨.*외부 증거/s, '외부 증거 필요'],
  ['내부 프롬프트 언어', /내부 프롬프트.*언어 자유/s, '내부는 언어 자유'],
  ['구현에 필수인 부수 변경', /부수 작업.*허용|부수 변경.*범위 안/s, '허용 + 결정사항 기록'],
  ['요청 밖 리팩토링 욕구', /요청하지 않은 작업.*제안/s, '실행 금지, 제안만'],
  ['비밀값 취급', /\.env로 분리/, '.env 분리'],
];
for (const [name, re, verdict] of SCENARIOS) {
  check(`${name} → ${verdict}`, re.test(doc));
}

console.log('[3] 우선순위 계층의 순서가 유지된다 (안전 예외 > 훅 > 헌법 > 스킬 > 자율)');
{
  const order = ['안전 예외 3가지', '훅의 차단', '헌법(이 문서)', '스킬 절차', '자율 판단'];
  const idx = order.map((k) => doc.indexOf(k));
  check('다섯 계층 모두 존재', idx.every((i) => i >= 0), `인덱스: ${idx.join(', ')}`);
  check(
    '위계 순서 보존',
    idx.every((v, i) => i === 0 || idx[i - 1] < v),
    `인덱스: ${idx.join(', ')}`,
  );
}

console.log('[4] 우선순위표 1번 항목이 예외 3가지를 그 줄 안에 전부 담고 있다');
{
  // 위치 무관 총 등장 횟수 검사는 표에서 삭제돼도 통과한다 (red-review 발견) — 표의 해당 줄을 직접 본다.
  const line1 = doc.split('\n').find((l) => /^1\.\s.*안전 예외/.test(l)) ?? '';
  check('우선순위표 1번 줄 존재', line1.length > 0);
  for (const t of ['비용 발생', '파괴', '외부 공개']) {
    check(`1번 줄에 "${t}" 포함`, line1.includes(t), line1);
  }
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
