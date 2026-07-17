// install-precommit + pre-commit 훅 end-to-end 테스트 — 임시 git 저장소에서 실제 커밋으로 검증.
// 래퍼 경유 커밋 차단이 목적이므로, 셸 도구가 아니라 git 자신이 훅을 실행하는 경로를 그대로 탄다.
// 실행: node test/precommit.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const INSTALLER = path.join(REPO, 'scripts', 'install-precommit.mjs');
const GUARD = path.join(REPO, 'hooks', 'secrets-guard.mjs'); // 레포 소스 guard로 고정 (배포본 비의존)

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  :: ' + (extra || '')}`);
  if (!cond) fail++;
};
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });
const dirs = [];

function mkRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-test-'));
  dirs.push(d);
  sh('git', ['init', '-q'], d);
  // 사용자 글로벌 core.hooksPath가 있어도 이 레포는 로컬 훅을 쓰도록 고정
  sh('git', ['config', 'core.hooksPath', '.git/hooks'], d);
  sh('git', ['config', 'user.email', 'test@test.local'], d);
  sh('git', ['config', 'user.name', 'pc-test'], d);
  return d;
}

// 1. 설치가 성공하고 훅 파일이 생긴다
{
  const d = mkRepo();
  const r = spawnSync(process.execPath, [INSTALLER, d, '--guard', GUARD], { encoding: 'utf8' });
  const hook = path.join(d, '.git', 'hooks', 'pre-commit');
  check('설치 성공 + 훅 파일 생성', r.status === 0 && fs.existsSync(hook), r.stderr);
  check('훅에 guard 경로가 박힘', fs.readFileSync(hook, 'utf8').includes('secrets-guard.mjs'));

  // 2. 비밀(.env) 커밋이 차단된다 — 셸 도구를 안 거치는 순수 git 경로.
  // 내용은 무해한 문자열: .env는 파일명 규칙(FORBIDDEN_FILES)만으로 차단된다.
  // (진짜 키 모양 fixture를 쓰면 이 테스트 파일 자체가 secrets-guard에 걸린다 — 실제로 걸렸음)
  fs.writeFileSync(path.join(d, '.env'), 'PLACEHOLDER=value\n');
  sh('git', ['add', '.env'], d);
  const c1 = sh('git', ['commit', '-m', 'try secret'], d);
  check('.env 커밋 차단 (exit != 0)', c1.status !== 0, `status=${c1.status}`);
  check('차단 사유 출력', (c1.stderr + c1.stdout).includes('커밋 차단'), c1.stderr);

  // 3. 정상 파일은 통과한다
  sh('git', ['reset'], d);
  fs.writeFileSync(path.join(d, 'ok.txt'), 'hello\n');
  sh('git', ['add', 'ok.txt'], d);
  const c2 = sh('git', ['commit', '-m', 'ok'], d);
  check('정상 파일 커밋 통과', c2.status === 0, c2.stderr);

  // 4. 재설치는 멱등이고, 다른 guard 경로로 재설치하면 훅 내용이 실제로 갱신된다 (red-review M2b)
  const guardCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-g2-')), 'secrets-guard.mjs');
  dirs.push(path.dirname(guardCopy));
  fs.copyFileSync(GUARD, guardCopy);
  const r2 = spawnSync(process.execPath, [INSTALLER, d, '--guard', guardCopy], { encoding: 'utf8' });
  check(
    '재설치 멱등 + 내용 갱신',
    r2.status === 0 && fs.readFileSync(hook, 'utf8').includes(guardCopy.replace(/\\/g, '/')),
    r2.stderr
  );
}

// 4.5 fail-open: 설치 후 guard 파일이 사라지면(다른 기기 클론 상황) 커밋은 통과하되 stderr로 알린다 (red-review M2a·S5)
{
  const d = mkRepo();
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-gone-'));
  dirs.push(gdir);
  const gone = path.join(gdir, 'secrets-guard.mjs');
  fs.copyFileSync(GUARD, gone);
  spawnSync(process.execPath, [INSTALLER, d, '--guard', gone], { encoding: 'utf8' });
  fs.rmSync(gone);
  fs.writeFileSync(path.join(d, 'ok.txt'), 'hi\n');
  sh('git', ['add', 'ok.txt'], d);
  const c = sh('git', ['commit', '-m', 'ok'], d);
  check('guard 부재 시 fail-open (커밋 통과)', c.status === 0, c.stderr);
  check('fail-open이 무음이 아님 (stderr 고지)', (c.stderr + c.stdout).includes('생략'), c.stderr);
}

// 4.7 경로에 $가 있어도 sh 확장으로 무력화되지 않는다 (red-review S3)
{
  const d = mkRepo();
  const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-$var-'));
  dirs.push(gdir);
  const dollarGuard = path.join(gdir, 'secrets-guard.mjs');
  fs.copyFileSync(GUARD, dollarGuard);
  const ri = spawnSync(process.execPath, [INSTALLER, d, '--guard', dollarGuard], { encoding: 'utf8' });
  check('$ 경로 설치 성공', ri.status === 0, ri.stderr);
  fs.writeFileSync(path.join(d, '.env'), 'PLACEHOLDER=value\n');
  sh('git', ['add', '-f', '.env'], d);
  const c = sh('git', ['commit', '-m', 'secret'], d);
  check('$ 경로 guard로도 .env 차단 (이스케이프 동작)', c.status !== 0, `status=${c.status} :: ${c.stderr}`);
}

// 5. 남의 pre-commit이 있으면 덮지 않고 중단한다
{
  const d = mkRepo();
  const hooksDir = path.join(d, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho custom-hook\n');
  const r = spawnSync(process.execPath, [INSTALLER, d, '--guard', GUARD], { encoding: 'utf8' });
  check(
    '기존 훅 보호 — 중단 + 원본 유지',
    r.status === 1 && fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8').includes('custom-hook'),
    `status=${r.status}`
  );
}

// 6. git 저장소가 아니면 중단
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-nogit-'));
  dirs.push(d);
  const r = spawnSync(process.execPath, [INSTALLER, d, '--guard', GUARD], { encoding: 'utf8' });
  check('비저장소 → exit 1', r.status === 1 && r.stderr.includes('git 저장소가 아님'), r.stderr);
}

for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
