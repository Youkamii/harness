// secrets-guard.mjs 회귀 테스트 — 임시 git 레포를 만들어 실제 훅 프로세스를 돌린다.
// 실행: node hooks/secrets-guard.test.mjs
// 주의: 테스트용 가짜 키는 자기 자신이 커밋될 때 오탐되지 않도록 문자열을 쪼개서 조립한다.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, 'secrets-guard.mjs');
const FAKE_AWS = 'AKIA' + 'IOSFODNN7EXAMPLE'; // 조립: 소스 자체가 패턴에 안 걸리게
const FAKE_GH = 'ghp' + '_' + 'A'.repeat(34);

const run = (command, cwd) =>
  spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const mkrepo = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
  git(d, 'init', '-q');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  return d;
};

let fail = 0;
const dirs = [];
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  :: ' + (extra || '')}`);
  if (!cond) fail++;
};

// 1. 스테이징된 비밀 차단 — 파일에 공백이 있어도 스캔되어야 함 (바이너리 판별 회귀)
const r1 = mkrepo(); dirs.push(r1);
fs.writeFileSync(path.join(r1, 'config.py'), `aws key = "${FAKE_AWS}"\n`);
git(r1, 'add', '.');
let r = run('git commit -m x', r1);
check('스테이징된 AWS 키 차단', r.status === 2, `status=${r.status}`);

// 2. git commit -am 이 새로 넣은 비밀 차단 (리뷰 발견 #4)
const r2 = mkrepo(); dirs.push(r2);
fs.writeFileSync(path.join(r2, 'a.txt'), 'clean\n');
git(r2, 'add', '.');
git(r2, 'commit', '-qm', 'init');
fs.writeFileSync(path.join(r2, 'a.txt'), `token = "${FAKE_GH}"\n`);
r = run('git commit -am update', r2);
check('commit -am 신규 비밀 차단', r.status === 2, `status=${r.status}`);

// 3. cd 복합 명령 — 실제 대상 레포를 검사해야 함 (리뷰 발견 #5)
const outer = mkrepo(); dirs.push(outer);
const inner = mkrepo(); dirs.push(inner);
fs.writeFileSync(path.join(inner, 's.txt'), `x = "${FAKE_AWS}"\n`);
git(inner, 'add', '.');
r = run(`cd "${inner}" && git commit -m x`, outer);
check('cd <다른레포> && commit 차단', r.status === 2, `status=${r.status}`);

// 4. 산문 속 ask-... 오탐 금지 (리뷰 발견 #7)
const r4 = mkrepo(); dirs.push(r4);
fs.writeFileSync(path.join(r4, 'notes.md'), 'please ask-questions-about-the-architecture-here thanks\n');
git(r4, 'add', '.');
r = run('git commit -m x', r4);
check('산문 ask-... 통과', r.status === 0, `status=${r.status} stderr=${r.stderr}`);

// 5. .env 파일명 자체 차단 / .env.example 허용
const r5 = mkrepo(); dirs.push(r5);
fs.writeFileSync(path.join(r5, '.env'), 'X=1\n');
fs.writeFileSync(path.join(r5, '.env.example'), 'X=\n');
git(r5, 'add', '-f', '.');
r = run('git commit -m x', r5);
check('.env 파일 차단', r.status === 2 && r.stderr.includes('.env') && !r.stderr.includes('.env.example'),
  `status=${r.status}`);

// 6. git 무관 명령은 무개입
r = run('ls -la', r4);
check('무관 명령 통과', r.status === 0 && !r.stderr, `status=${r.status}`);

// ── Phase 2 C2 강화 (크로스벤더 red-review 재현본) ──
// 7. 널바이트 삽입으로 스캔 무력화 시도 차단 (감사 #1)
const r7 = mkrepo(); dirs.push(r7);
fs.writeFileSync(path.join(r7, 'note.txt'), `x=${FAKE_AWS}\0trailing\n`);
git(r7, 'add', '.');
r = run('git commit -m x', r7);
check('널바이트 삽입해도 AWS 키 탐지', r.status === 2, `status=${r.status}`);

// 8. Stripe 라이브 키 (감사 #5)
const FAKE_STRIPE = 'sk' + '_live_' + 'a'.repeat(24);
const r8 = mkrepo(); dirs.push(r8);
fs.writeFileSync(path.join(r8, 'pay.js'), `const k = "${FAKE_STRIPE}"\n`);
git(r8, 'add', '.');
r = run('git commit -m x', r8);
check('Stripe 라이브 키 차단', r.status === 2, `status=${r.status}`);

// 9. GitLab PAT (감사 #6)
const FAKE_GLPAT = 'glpat' + '-' + 'A'.repeat(20);
const r9 = mkrepo(); dirs.push(r9);
fs.writeFileSync(path.join(r9, 'ci.yml'), `token: ${FAKE_GLPAT}\n`);
git(r9, 'add', '.');
r = run('git commit -m x', r9);
check('GitLab PAT 차단', r.status === 2, `status=${r.status}`);

// 10. 무따옴표 하드코딩 비밀 (감사 #7). 소스 자기오탐 방지로 값은 조립 + 파일에만 실제 기록
const SECRET_VAL = 'super' + 'secret' + 'value' + '123';
const r10 = mkrepo(); dirs.push(r10);
fs.writeFileSync(path.join(r10, 'app.yaml'), `password: ${SECRET_VAL}\n`);
git(r10, 'add', '.');
r = run('git commit -m x', r10);
check('무따옴표 password 차단', r.status === 2, `status=${r.status}`);

// 11. 플레이스홀더는 오탐 안 함 (env 참조·changeme·your- 류)
const r11 = mkrepo(); dirs.push(r11);
fs.writeFileSync(path.join(r11, 'sample.yaml'), `password: \${DB_PASSWORD}\nsecret: changeme\napi_key: your-key-here\n`);
git(r11, 'add', '.');
r = run('git commit -m x', r11);
check('플레이스홀더 통과', r.status === 0, `status=${r.status} stderr=${r.stderr}`);

// 12. 대용량 파일(1MB 초과) 앞부분 비밀 (감사 #4)
const r12 = mkrepo(); dirs.push(r12);
fs.writeFileSync(path.join(r12, 'big.log'), `key=${FAKE_AWS}\n` + 'x'.repeat(1024 * 1024 + 10));
git(r12, 'add', '.');
r = run('git commit -m x', r12);
check('대용량 파일 앞부분 비밀 탐지', r.status === 2, `status=${r.status}`);

// 13. DB 커넥션 스트링 내 암호 (감사 #6). 소스 자기오탐 방지로 스킴 분리 조립
const DB_URL = 'postgres' + '://admin:' + 'pwlongsecret99' + '@db.host:5432/app';
const r13 = mkrepo(); dirs.push(r13);
fs.writeFileSync(path.join(r13, 'db.txt'), DB_URL + '\n');
git(r13, 'add', '.');
r = run('git commit -m x', r13);
check('DB 커넥션 암호 차단', r.status === 2, `status=${r.status}`);

// 14. 이미 커밋된 .env를 제거하는 정리 커밋은 차단하지 않는다 (red-review C6 — 유출 복구 교착 방지)
const r14 = mkrepo(); dirs.push(r14);
fs.writeFileSync(path.join(r14, '.env'), 'X=1\n');
git(r14, 'add', '-f', '.env');
git(r14, 'commit', '-qm', 'oops'); // 임시 레포엔 훅 미설치 — 실수 커밋 재현
git(r14, 'rm', '-q', '.env');
r = run('git commit -m "remove leaked env"', r14);
check('.env 삭제(정리) 커밋 통과', r.status === 0, `status=${r.status} stderr=${r.stderr}`);

// 15. 삭제와 신규 비밀이 섞이면 신규 쪽은 여전히 차단 (commit -am 경로)
const r15 = mkrepo(); dirs.push(r15);
fs.writeFileSync(path.join(r15, '.env'), 'X=1\n');
fs.writeFileSync(path.join(r15, 'ok.txt'), 'clean\n');
git(r15, 'add', '-f', '.');
git(r15, 'commit', '-qm', 'init');
git(r15, 'rm', '-q', '.env');
fs.writeFileSync(path.join(r15, 'ok.txt'), `k = "${FAKE_AWS}"\n`);
r = run('git commit -am cleanup', r15);
check('삭제+신규비밀 혼합 시 신규는 차단', r.status === 2 && !r.stderr.includes('.env —'), `status=${r.status} stderr=${r.stderr}`);

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
