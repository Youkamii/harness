#!/usr/bin/env node
// ~/.claude/settings.json 에 하네스의 훅/승인 규칙을 '병합'한다 (덮어쓰지 않음).
// install.sh 가 호출한다. 기존 키와 항목은 보존하고, 없는 것만 추가한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.homedir(), '.claude', 'settings.json');
let s = {};
try {
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {}

s.permissions ||= {};
const addUnique = (key, items) => {
  s.permissions[key] = [...new Set([...(s.permissions[key] || []), ...items])];
};
// 위험 행동은 전역에서도 승인/차단. (allow/defaultMode 는 프로젝트별 취향이므로 건드리지 않음)
addUnique('ask', ['Bash(rm -rf *)', 'Bash(sudo *)', 'Bash(git push *)', 'Bash(curl *)']);
addUnique('deny', ['Read(./.env)', 'Read(./.env.*)', 'Read(./secrets/**)', 'Bash(git push --force *)']);

// guard 훅 등록 (이미 있으면 생략)
s.hooks ||= {};
s.hooks.PreToolUse ||= [];
const hasGuard = JSON.stringify(s.hooks.PreToolUse).includes('guard.js');
if (!hasGuard) {
  s.hooks.PreToolUse.push({
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/guard.js"' }],
  });
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
console.log(`병합 완료: ${file} (guard 훅 ${hasGuard ? '이미 있음' : '추가됨'})`);
