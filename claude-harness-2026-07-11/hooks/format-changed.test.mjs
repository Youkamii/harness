// format-changed.mjs 회귀 테스트 — 임시 디렉터리로 opt-in·변경파일전용·비차단을 검증한다.
// 실행: node hooks/format-changed.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'format-changed.mjs');
let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  :: ' + (extra || '')}`);
  if (!cond) fail++;
};
const run = (payload) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
const dirs = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-test-')); dirs.push(d); return d; };

// 1. config 없으면 무개입 (exit 0, 출력 없음)
{
  const d = mk();
  const f = path.join(d, 'a.ts');
  fs.writeFileSync(f, 'const x=1\n');
  const r = run({ tool_name: 'Edit', tool_input: { file_path: f } });
  check('config 없음 → 무개입', r.status === 0 && !r.stdout.trim(), `out=${r.stdout}`);
}

// 2. 잘못된 입력 → 안전하게 exit 0
{
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  check('깨진 입력 → exit 0', r.status === 0);
}

// 3. config 있고 확장자 매칭 → 지정 명령이 그 파일에 실행된다 (node로 마킹 명령 사용)
{
  const d = mk();
  const f = path.join(d, 'x.ts');
  fs.writeFileSync(f, 'original\n');
  const marker = path.join(d, 'ran.txt');
  // 포매터 대역: 대상 파일 경로를 marker에 적는 node 원라이너
  const fakeFmt = path.join(d, 'fmt.mjs');
  fs.writeFileSync(fakeFmt, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)}, process.argv[2]||'');`);
  fs.writeFileSync(
    path.join(d, 'format-hook.config.json'),
    JSON.stringify({ extensions: { '.ts': [process.execPath, fakeFmt] } })
  );
  const r = run({ tool_name: 'Write', tool_input: { file_path: f } });
  const ran = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8');
  check('config 매칭 → 포매터가 그 파일에 실행', r.status === 0 && ran === f, `status=${r.status} ran=${ran}`);
}

// 4. config 있으나 확장자 미매칭 → 무개입
{
  const d = mk();
  const f = path.join(d, 'y.md');
  fs.writeFileSync(f, '# md\n');
  fs.writeFileSync(path.join(d, 'format-hook.config.json'), JSON.stringify({ extensions: { '.ts': ['echo'] } }));
  const r = run({ tool_name: 'Edit', tool_input: { file_path: f } });
  check('확장자 미매칭 → 무개입', r.status === 0 && !r.stdout.trim());
}

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
