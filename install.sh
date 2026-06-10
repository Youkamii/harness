#!/usr/bin/env bash
# 이 키트(훅/스킬/에이전트/규칙)를 전역(~/.claude)에 설치해 모든 프로젝트에서 쓰게 한다.
# 이 저장소가 원본(source of truth)이며, 수정 후 다시 실행하면 갱신된다.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/.claude"
mkdir -p "$DST/hooks" "$DST/skills" "$DST/agents"

cp -v "$SRC/.claude/hooks/"*.js "$DST/hooks/"
cp -Rv "$SRC/.claude/skills/"* "$DST/skills/"
cp -v "$SRC/.claude/agents/"*.md "$DST/agents/"

# CLAUDE.md 는 사용자가 직접 쓰는 파일일 수 있으므로 덮어쓰지 않는다.
if [ -f "$DST/CLAUDE.md" ]; then
  echo ""
  echo "주의: ~/.claude/CLAUDE.md 가 이미 있어 덮어쓰지 않았습니다."
  echo "      필요하면 $SRC/CLAUDE.md 의 '작업 방식' 절을 수동으로 합치세요."
else
  cp -v "$SRC/CLAUDE.md" "$DST/CLAUDE.md"
fi

echo ""
echo "완료. 남은 수동 단계 1개:"
echo "  ~/.claude/settings.json 에 다음을 병합하세요 (전역 훅 등록):"
echo '  "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \"$HOME/.claude/hooks/guard.js\"" } ] } ] }'
echo "  권한(ask/deny) 규칙은 $SRC/.claude/settings.json 의 permissions 절 참고."
