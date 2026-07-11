#!/usr/bin/env node
// format-changed — PostToolUse 훅 (Edit|Write). 방금 편집된 파일 하나만 프로젝트 포매터로 정리한다.
//
// 설계 (크로스모델 토론 확정 형태 — C4):
//  - opt-in: 프로젝트 루트에 `format-hook.config.json`이 있을 때만 동작한다. 없으면 아무것도 안 한다.
//    (전역 자동 포매팅은 지연·재귀·예상 밖 대량 변경을 만든다. 정본은 각 저장소 CI/pre-commit이고 이건 편의 계층.)
//  - 변경 파일 전용: 저장소 전체를 포맷하지 않는다. 방금 편집된 그 파일 하나만.
//  - 안전: 항상 exit 0 (비차단). 포매터가 없거나 실패해도 편집 흐름을 막지 않는다. 타임아웃 있음.
//  - config가 명시한 명령만 실행한다 (미등록 명령·셸 인젝션 없음).
//
// config 예 (format-hook.config.json):
//   { "extensions": { ".ts": ["npx","prettier","--write"], ".py": ["black","-q"] } }
//   각 값은 argv 배열 — 마지막에 대상 파일 경로가 append 되어 실행된다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.path || '';
  if (!file) process.exit(0);

  // 프로젝트 루트 추정: 편집 파일에서 위로 올라가며 config를 찾는다
  let dir = path.dirname(path.resolve(file));
  let cfgPath = null;
  for (let i = 0; i < 40; i++) {
    const c = path.join(dir, 'format-hook.config.json');
    if (fs.existsSync(c)) { cfgPath = c; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!cfgPath) process.exit(0); // opt-in 안 됨 → 무개입

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { process.exit(0); }
  const ext = path.extname(file);
  const argv = cfg.extensions && cfg.extensions[ext];
  if (!Array.isArray(argv) || argv.length === 0) process.exit(0); // 이 확장자는 대상 아님

  const [cmd, ...args] = argv;
  const r = spawnSync(cmd, [...args, file], { timeout: 15000, encoding: 'utf8' });
  if (r.status === 0) {
    // 조용히 성공 (편집 흐름 방해 안 함)
    process.stdout.write(JSON.stringify({ suppressOutput: true }));
  }
  // 실패해도 비차단 — 포매터 부재·오류가 편집을 막으면 안 된다
  process.exit(0);
});
