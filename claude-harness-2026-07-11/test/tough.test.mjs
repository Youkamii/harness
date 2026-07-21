// Tough mode 계약 테스트 — 트리거·범위·보호 경계가 스킬과 헌법에서 함께 유지되는지 검사한다.
// 실행: node test/tough.test.mjs (install.mjs가 배포 전 자동 발견한다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../scripts/manifest-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = path.join(REPO, 'skills', 'tough', 'SKILL.md');
const skill = fs.readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
const constitution = fs.readFileSync(path.join(REPO, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n');

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

console.log('[1] 스킬 형식과 명시 트리거');
const closing = skill.indexOf('\n---\n', 4);
check('YAML frontmatter 닫힘', skill.startsWith('---\n') && closing > 4);
const frontmatter = closing > 4 ? skill.slice(4, closing) : '';
const keys = frontmatter
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split(':', 1)[0]);
check('frontmatter는 name/description만', JSON.stringify(keys) === JSON.stringify(['name', 'description']), keys.join(', '));
check('name은 tough', /^name:\s*tough$/m.test(frontmatter));
for (const trigger of ['/tough 요청', '터프 모드로 구현해', 'use tough mode']) {
  check(`description 트리거: ${trigger}`, frontmatter.includes(trigger));
}
check('description은 명시 활성화에만 반응', /활성화를 명시적으로 지시할 때 사용/.test(frontmatter));
for (const excluded of ['단순 질문', '부정', '인용', '예시']) {
  check(`description 비활성 문맥: ${excluded}`, frontmatter.includes(excluded));
}
check('스킬은 간결하다', skill.split('\n').length <= 30, `${skill.split('\n').length}줄`);

console.log('[2] Tough 범위 계약');
const contracts = [
  ['요청·계약 밖 제품 보호를 발명·구현하지 않음', /요청하지 않았고 기존 제품 계약에도 없는 보안·안전·보호 기능.*발명·구현하지 않는다/s],
  ['상위 경계 밖에서는 우려로만 보고하고 질문으로 막지 않음', /상위 경계에 해당하지 않는 한.*질문으로 작업을 막지 말고.*우려.*로만/s],
  ['상위 경계와 실제 충돌은 조용히 우회하지 않음', /상위 경계.*기존 계약.*실제로 충돌하면.*조용히 우회하지 말고.*충돌을 보고/s],
  ['요청·기존 계약의 보호 기능은 유지·구현', /요청했거나 기존 제품 계약에 (?:있으면|포함된).*유지·구현한다/s],
  ['기존 보호를 삭제·완화·우회하지 않음', /이미 있는 보호 기능.*삭제·완화·우회하지 않는다/s],
  ['플랫폼·샌드박스·비밀·저장소 경계 유지', /플랫폼 정책.*샌드박스.*비밀 보호.*저장소 규칙/s],
  ['kickoff 검증 파이프라인 재사용', /\/kickoff.*그대로 따른다/s],
  ['예시 단어 자체를 금지하지 않음', /이 단어 자체가 금지된 것은 아니/],
];
for (const [name, pattern] of contracts) {
  check(`스킬: ${name}`, pattern.test(skill));
  check(`헌법: ${name}`, pattern.test(constitution));
}
for (const example of ['8주 거래 제한', '승인 단계', '킬스위치', 'allowlist', '지연', '시뮬레이션 전용']) {
  check(`범위 밖 발명 예시 문맥: ${example}`, skill.includes(example) && constitution.includes(example));
}

console.log('[3] 활성화·비활성화 예시 계약');
for (const active of ['/tough <요청>', '터프 모드로 구현해', 'use tough mode']) {
  check(`명시 활성화 예시: ${active}`, skill.includes(active) && constitution.includes(active));
}
for (const inactive of ['터프 모드가 뭐야?', '터프 모드 쓰지 마', '인용·코드·예시']) {
  check(`비활성 예시: ${inactive}`, skill.includes(inactive) && constitution.includes(inactive));
}

console.log('[4] 설치 자동수집 계약');
const manifest = buildManifest(REPO);
check(
  'assets-manifest/v1에 tough 스킬 포함',
  manifest.contract === 'assets-manifest/v1' && typeof manifest.assets['skills/tough/SKILL.md'] === 'string',
);

console.log(`\n결과: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
