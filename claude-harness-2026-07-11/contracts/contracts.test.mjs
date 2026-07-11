// contracts 회귀 테스트 — 계약을 고치면 반드시 여기에 케이스를 먼저 추가하고 돌린다.
// 실행: node contracts/contracts.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(path.join(here, p), 'utf8'));

const resultSchema = load('workflow-result.schema.json');
const summarySchema = load('run-summary.schema.json');
const validResult = load('samples/valid-result.json');
const validSummary = load('samples/valid-summary.json');

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

console.log('[1] 유효 샘플은 오류 없이 통과한다');
{
  const errs = validate(resultSchema, validResult);
  check('valid-result.json', errs.length === 0, errs.join(' | '));
}
{
  const errs = validate(summarySchema, validSummary);
  check('valid-summary.json', errs.length === 0, errs.join(' | '));
}

console.log('[2] 무효 결과는 기대한 이유로 거부된다');
const resultCases = [
  ['status 미정의 값', (d) => { d.status = 'okay'; }, 'enum'],
  ['contract 버전 불일치', (d) => { d.contract = 'workflow-result/v2'; }, 'const'],
  ['finding.verification 누락', (d) => { delete d.findings[0].verification; }, '필수 키 "verification"'],
  ['CONFIRMED인데 evidence 없음 (외부 증거 강제)', (d) => { delete d.findings[0].evidence; }, '필수 키 "evidence"'],
  ['CONFIRMED인데 verifiedBy 없음', (d) => { delete d.findings[0].verifiedBy; }, '필수 키 "verifiedBy"'],
  ['usage.agents 음수', (d) => { d.usage.agents = -1; }, 'minimum'],
  ['severity 미정의 값', (d) => { d.findings[0].severity = 'blocker'; }, 'enum'],
  ['findings가 배열이 아님', (d) => { d.findings = {}; }, 'type'],
  ['verifiedBy에 미정의 검증자', (d) => { d.findings[0].verifiedBy = ['gut-feeling']; }, 'enum'],
];
for (const [name, mutate, keyword] of resultCases) {
  const d = structuredClone(validResult);
  mutate(d);
  const errs = validate(resultSchema, d);
  check(
    `무효: ${name}`,
    errs.length > 0 && errs.some((e) => e.includes(keyword)),
    `기대 키워드 "${keyword}" / 실제: ${errs.join(' | ') || '(오류 없음 — 통과해버림)'}`,
  );
}

console.log('[3] DISPUTED/UNVERIFIED는 evidence 없이도 유효하다 (3분류 보존)');
{
  const d = structuredClone(validResult);
  delete d.findings[1].evidence; // DISPUTED — 원래 없음
  delete d.findings[2].evidence; // UNVERIFIED — 원래 없음
  const errs = validate(resultSchema, d);
  check('DISPUTED/UNVERIFIED evidence 비강제', errs.length === 0, errs.join(' | '));
}

console.log('[4] 무효 summary는 거부된다');
const summaryCases = [
  ['startedAt이 ISO 형식 아님', (d) => { d.startedAt = '7월 11일'; }, 'pattern'],
  ['counts.confirmed 누락', (d) => { delete d.counts.confirmed; }, '필수 키 "confirmed"'],
  ['status 미정의 값', (d) => { d.status = 'running'; }, 'enum'],
  ['budget.target 문자열', (d) => { d.budget.target = '무제한'; }, 'type'],
];
for (const [name, mutate, keyword] of summaryCases) {
  const d = structuredClone(validSummary);
  mutate(d);
  const errs = validate(summarySchema, d);
  check(
    `무효: ${name}`,
    errs.length > 0 && errs.some((e) => e.includes(keyword)),
    `기대 키워드 "${keyword}" / 실제: ${errs.join(' | ') || '(오류 없음 — 통과해버림)'}`,
  );
}

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
