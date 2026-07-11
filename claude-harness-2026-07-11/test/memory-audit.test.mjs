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

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
