#!/usr/bin/env bash
# 하네스 설치 — PC당 1번만 실행하면 된다. 이후 평소 사용은 아무 폴더에서 `claude`.
# 하네스를 수정한 뒤에는 `harness update` 로 재설치한다.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/.claude"
BIN="$HOME/.local/bin"

# 1) 훅/스킬/에이전트를 전역으로 복사
mkdir -p "$DST/hooks" "$DST/skills" "$DST/agents" "$BIN"
cp "$SRC/.claude/hooks/"*.js "$DST/hooks/"
cp -R "$SRC/.claude/skills/"* "$DST/skills/"
cp "$SRC/.claude/agents/"*.md "$DST/agents/"
echo "✓ 훅/스킬/에이전트 → $DST"

# 2) 전역 설정에 훅 등록 + 승인/차단 규칙 병합 (기존 설정 보존)
node "$SRC/scripts/merge-global-settings.mjs"

# 3) 표준 규칙(CLAUDE.md) — 이미 있으면 덮어쓰지 않음
if [ -f "$DST/CLAUDE.md" ]; then
  if ! grep -q "하네스 표준 규칙" "$DST/CLAUDE.md"; then
    echo "주의: ~/.claude/CLAUDE.md 가 이미 있어 보존했습니다. 필요하면 $SRC/CLAUDE.md 와 수동 병합하세요."
  fi
else
  cp "$SRC/CLAUDE.md" "$DST/CLAUDE.md"
  echo "✓ 표준 규칙 → $DST/CLAUDE.md"
fi

# 4) 전역 harness 명령 설치 (저장소 경로를 박아 넣음)
sed "s|__HARNESS_DIR__|$SRC|" "$SRC/bin/harness" > "$BIN/harness"
chmod +x "$BIN/harness"
echo "✓ 명령어 → $BIN/harness"

# 5) PATH 에 ~/.local/bin 이 없으면 zshrc 에 추가
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    echo '' >> "$HOME/.zshrc"
    echo '# harness 명령 (Harness install.sh 가 추가)' >> "$HOME/.zshrc"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
    echo "✓ ~/.zshrc 에 PATH 추가 — 새 터미널부터 적용됩니다."
    ;;
esac

echo ""
echo "설치 완료. 사용법:"
echo "  - 평소: 아무 폴더에서 claude 실행 (하네스 자동 적용)"
echo "  - 그 외: harness help"
