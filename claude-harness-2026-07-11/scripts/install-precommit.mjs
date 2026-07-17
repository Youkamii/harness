#!/usr/bin/env node
// install-precommit — 대상 저장소에 secrets pre-commit 훅을 설치한다 (옵트인, #15).
// 사용:
//   node scripts/install-precommit.mjs [저장소경로=.]           # ~/.claude 배포본 guard 사용
//   node scripts/install-precommit.mjs <저장소> --guard <경로>  # guard 경로 오버라이드 (테스트용)
//
// 동작: <저장소>/.git/hooks/pre-commit 에 templates/pre-commit 을 설치한다.
//  - 이미 우리 훅(마커 "g-harness pre-commit")이면 갱신.
//  - 남의 pre-commit이 있으면 절대 덮지 않고 중단 — 수동 통합을 안내한다.
//  - worktree/서브모듈도 git rev-parse --git-path hooks 로 올바른 위치를 찾는다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const guardIdx = argv.indexOf('--guard');
const guardPath = path.resolve(
  guardIdx >= 0 ? argv[guardIdx + 1] : path.join(os.homedir(), '.claude', 'hooks', 'secrets-guard.mjs')
);
const target = path.resolve(argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--guard') || '.');

if (!fs.existsSync(guardPath)) {
  console.error(`[precommit] secrets-guard 없음: ${guardPath}`);
  console.error('[precommit] 먼저 하네스를 설치하거나(--verify로 확인) --guard 로 경로를 지정하라.');
  process.exit(1);
}

let hooksDir;
try {
  hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: target,
    encoding: 'utf8',
  }).trim();
  hooksDir = path.resolve(target, hooksDir);
} catch {
  console.error(`[precommit] git 저장소가 아님: ${target}`);
  process.exit(1);
}

const MARKER = 'g-harness pre-commit';
const dest = path.join(hooksDir, 'pre-commit');
if (fs.existsSync(dest) && !fs.readFileSync(dest, 'utf8').includes(MARKER)) {
  console.error(`[precommit] 기존 pre-commit 훅이 있습니다 (하네스 것 아님): ${dest}`);
  console.error('[precommit] 덮어쓰지 않습니다. 기존 훅 끝에 다음을 수동 통합하세요:');
  console.error(`  echo '{"tool_name":"Bash","tool_input":{"command":"git commit"}}' | node "${guardPath}"`);
  process.exit(1);
}

const template = fs.readFileSync(path.join(REPO, 'templates', 'pre-commit'), 'utf8');
// sh 이중따옴표 문자열 안에 들어간다: 백슬래시는 슬래시로(Git Bash sh가 그대로 이해),
// $·백틱·따옴표는 이스케이프 — 경로에 $가 있으면 sh 변수 확장으로 GUARD가 빈 경로가 되어
// 비밀 검사가 조용히 무력화된다 (red-review S3).
const shSafe = guardPath.replace(/\\/g, '/').replace(/([$`"])/g, '\\$1');
const body = template.replace('{{GUARD_PATH}}', shSafe);
fs.mkdirSync(hooksDir, { recursive: true });
fs.writeFileSync(dest, body, { mode: 0o755 });
console.log(`[precommit] 설치 완료: ${dest}`);
console.log(`[precommit] guard: ${guardPath}`);
console.log('[precommit] 이제 이 저장소의 모든 커밋(래퍼 경유 포함)에서 비밀 검사가 돕니다.');
