// memory-audit.mjs 회귀 테스트 — 임시 fixture 디렉터리로 결정론 검사를 검증한다.
// 실행: node test/memory-audit.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, '..', 'scripts', 'memory-audit.mjs');

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  :: ' + (extra || '')}`);
  if (!cond) fail++;
};
const run = (dir) => spawnSync(process.execPath, [AUDIT, dir], { encoding: 'utf8' });
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-'));
const write = (dir, file, body) => fs.writeFileSync(path.join(dir, file), body);
const dirs = [];

// 1. 완전 정합한 메모리 세트 → exit 0
{
  const d = mk(); dirs.push(d);
  write(d, 'user-me.md', `---\nname: user-me\ndescription: d\nmetadata:\n  type: user\n---\n[[proj-x]] 참조\n`);
  write(d, 'proj-x.md', `---\nname: proj-x\ndescription: d\nmetadata:\n  type: project\n---\n본문\n`);
  write(d, 'MEMORY.md', `- [Me](user-me.md) — hook\n- [X](proj-x.md) — hook\n`);
  const r = run(d);
  check('정합 세트 → exit 0', r.status === 0, `status=${r.status} out=${r.stdout}`);
}

// 2. 죽은 링크 → exit 1
{
  const d = mk(); dirs.push(d);
  write(d, 'a.md', `---\nname: a\ndescription: d\nmetadata:\n  type: project\n---\n[[nonexistent]] 링크\n`);
  write(d, 'MEMORY.md', `- [A](a.md) — hook\n`);
  const r = run(d);
  check('죽은 링크 → exit 1', r.status === 1 && r.stdout.includes('죽은 링크'), r.stdout);
}

// 3. 빈/누락 name → exit 1
{
  const d = mk(); dirs.push(d);
  write(d, 'b.md', `---\nname: ""\ndescription: d\nmetadata:\n  type: feedback\n---\n본문\n`);
  write(d, 'MEMORY.md', `- [B](b.md) — hook\n`);
  const r = run(d);
  check('빈 name → exit 1', r.status === 1 && r.stdout.includes('name 없음'), r.stdout);
}

// 4. MEMORY.md 인덱스 누락 → exit 1
{
  const d = mk(); dirs.push(d);
  write(d, 'c.md', `---\nname: c\ndescription: d\nmetadata:\n  type: project\n---\n본문\n`);
  write(d, 'MEMORY.md', `\n`); // c.md 인덱스 줄 없음
  const r = run(d);
  check('인덱스 누락 → exit 1', r.status === 1 && r.stdout.includes('인덱스 줄 없음'), r.stdout);
}

// 5. 고아 인덱스 줄(파일 없음) → exit 1
{
  const d = mk(); dirs.push(d);
  write(d, 'd.md', `---\nname: d\ndescription: x\nmetadata:\n  type: project\n---\n본문\n`);
  write(d, 'MEMORY.md', `- [D](d.md) — h\n- [Ghost](ghost.md) — h\n`);
  const r = run(d);
  check('고아 인덱스 → exit 1', r.status === 1 && r.stdout.includes('고아 인덱스'), r.stdout);
}

// 6. name 중복 → exit 1
{
  const d = mk(); dirs.push(d);
  write(d, 'e1.md', `---\nname: dup\ndescription: x\nmetadata:\n  type: project\n---\n\n`);
  write(d, 'e2.md', `---\nname: dup\ndescription: y\nmetadata:\n  type: project\n---\n\n`);
  write(d, 'MEMORY.md', `- [1](e1.md) — h\n- [2](e2.md) — h\n`);
  const r = run(d);
  check('name 중복 → exit 1', r.status === 1 && r.stdout.includes('중복'), r.stdout);
}

// 7. 노후 후보는 exit 0을 바꾸지 않는다 (경고일 뿐)
{
  const d = mk(); dirs.push(d);
  write(d, 'old.md', `---\nname: old\ndescription: x\nmetadata:\n  type: project\n---\nC:\\Users\\someone\\path 하드코딩\n`);
  write(d, 'MEMORY.md', `- [Old](old.md) — h\n`);
  const r = run(d);
  check('노후 후보만 있으면 exit 0', r.status === 0 && r.stdout.includes('후보'), `status=${r.status}`);
}

// 8. 언더스코어 name 링크도 검사 대상 (kebab만 보면 사각지대 — #14)
{
  const d = mk(); dirs.push(d);
  write(d, 'u1.md', `---\nname: snake_name\ndescription: d\nmetadata:\n  type: project\n---\n본문\n`);
  write(d, 'u2.md', `---\nname: linker\ndescription: d\nmetadata:\n  type: feedback\n---\n산 링크 [[snake_name]], 죽은 링크 [[dead_snake]]\n`);
  write(d, 'MEMORY.md', `- [1](u1.md) — h\n- [2](u2.md) — h\n`);
  const r = run(d);
  check(
    '언더스코어 링크: 산 것 통과·죽은 것 검출 → exit 1',
    r.status === 1 && r.stdout.includes('[[dead_snake]]') && !r.stdout.includes('[[snake_name]]'),
    r.stdout
  );
}

// 9. 전 프로젝트 순회 (--projects): 정합 p1 + 오류 p2 → exit 1, 둘 다 보고에 등장
{
  const root = mk(); dirs.push(root);
  const p1 = path.join(root, 'proj-ok', 'memory');
  const p2 = path.join(root, 'proj-bad', 'memory');
  fs.mkdirSync(p1, { recursive: true });
  fs.mkdirSync(p2, { recursive: true });
  fs.mkdirSync(path.join(root, 'proj-no-memory')); // memory 없는 프로젝트는 조용히 스킵
  write(p1, 'ok.md', `---\nname: ok\ndescription: d\nmetadata:\n  type: user\n---\n본문\n`);
  write(p1, 'MEMORY.md', `- [OK](ok.md) — h\n`);
  write(p2, 'bad.md', `---\nname: bad\ndescription: d\nmetadata:\n  type: project\n---\n[[nope]]\n`);
  write(p2, 'MEMORY.md', `- [Bad](bad.md) — h\n`);
  const r = spawnSync(process.execPath, [AUDIT, '--projects', root], { encoding: 'utf8' });
  check(
    '순회: 오류 있는 프로젝트가 하나면 exit 1 + 슬러그별 보고',
    r.status === 1 && r.stdout.includes('proj-ok') && r.stdout.includes('proj-bad') && r.stdout.includes('죽은 링크'),
    `status=${r.status} out=${r.stdout.slice(0, 300)}`
  );
  check('순회: memory 있는 프로젝트만 센다 (2개)', r.stdout.includes('프로젝트 2개'), r.stdout.split('\n')[0]);
}

// 10. 전부 정합한 순회 → exit 0
{
  const root = mk(); dirs.push(root);
  const p1 = path.join(root, 'p1', 'memory');
  fs.mkdirSync(p1, { recursive: true });
  write(p1, 'a.md', `---\nname: a\ndescription: d\nmetadata:\n  type: user\n---\n본문\n`);
  write(p1, 'MEMORY.md', `- [A](a.md) — h\n`);
  const r = spawnSync(process.execPath, [AUDIT, '--projects', root], { encoding: 'utf8' });
  check('순회 전부 정합 → exit 0', r.status === 0, `status=${r.status}`);
}

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
