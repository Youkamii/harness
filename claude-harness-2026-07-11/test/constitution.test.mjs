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
const SCENARIOS = [
  ['비용 발생 작업을 만나면', /비용 발생.*멈추고 확인|멈추고 확인.*비용/s, '멈추고 확인'],
  ['본인 소유 저장소 push·이슈 조작', /본인 소유 저장소에 대한 push·이슈 생성\/닫기는 일상 작업/, '확인 없이 진행'],
  ['훅이 명령을 차단하면', /훅의 차단.*우회하지 않는다|guard.*막으면 우회하지 않는다/s, '우회 금지'],
  ['스킬 지시가 헌법과 충돌하면', /스킬·에이전트 지시가 헌법과 충돌하면 헌법을 따른다/, '헌법 우선'],
  ['실행 안 해본 코드를 보고할 때', /실행해본 것만 "동작한다"고 말한다/, '동작 단정 금지'],
  ['같은 모델을 여러 번 돌려 검증하려 할 때', /다수결은 독립 검증이 아니다/, '외부 증거 요구'],
  ['확인됨 승격 조건', /외부 증거\(테스트·실행·정적 분석·교차 모델\)/, '외부 증거 필요'],
  ['내부 프롬프트 언어', /내부 프롬프트는 정확성이 우선이므로 언어 자유/, '내부는 언어 자유'],
  ['구현에 필수인 부수 변경', /범위 안의 부수 작업은 허용/, '허용 + 결정사항 기록'],
  ['요청 밖 리팩토링 욕구', /요청하지 않은 작업.*제안으로만 남긴다/s, '실행 금지, 제안만'],
  ['비밀값 취급', /\.env로 분리하고 \.gitignore/, '.env 분리'],
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

console.log('[4] 우선순위 1번(안전 예외)이 자율 원칙의 예외 3가지와 같은 대상을 가리킨다');
{
  const triad = ['비용 발생', '되돌리기 어려운 파괴', '외부 공개'];
  for (const t of triad) {
    const count = doc.split(t).length - 1;
    check(`"${t}" 우선순위표·자율 원칙 양쪽에 존재`, count >= 2, `등장 ${count}회`);
  }
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
