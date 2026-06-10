#!/usr/bin/env node
// SessionStart 훅: 세션이 시작될 때 옵시디언 볼트의 AI 메모리 인덱스를 컨텍스트로 주입한다.
//
// 존재 이유: 스킬은 모델이 "호출해야" 작동하지만, 사용자 프로필(설명 눈높이, 검증 요구,
// 비용 민감)은 첫 응답부터 적용돼야 한다. 그래서 세션 시작 시 무조건 주입한다.
// second-brain 스킬이 쓰기를, 이 훅이 자동 읽기를 담당한다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const vault = process.env.BRAIN_VAULT || path.join(os.homedir(), 'Documents', 'Lia');
const indexFile = path.join(vault, 'AI', '메모리', '메모리.md');

try {
  let text = fs.readFileSync(indexFile, 'utf8');
  const MAX = 4000; // 프로필이 비대해져도 컨텍스트를 과점하지 않게 상한
  if (text.length > MAX) text = text.slice(0, MAX) + '\n…(잘림 — 전체는 메모리.md 참조)';
  console.log('<사용자-장기기억 출처="옵시디언 볼트 AI/메모리/메모리.md — second-brain 스킬로 갱신">');
  console.log(text);
  console.log('</사용자-장기기억>');
} catch {
  // 메모리 파일이 없으면 조용히 통과 (다른 PC, 볼트 없는 환경)
}
process.exit(0);
