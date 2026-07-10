---
name: harness
description: 하네스 자기관리 — 구성 점검(훅 등록/테스트/파일 존재), 새 스킬·에이전트·가드 패턴 추가, 레포와 로컬 동기화. "/harness", "하네스 점검", "하네스에 추가해줘", "가드 패턴 고쳐줘" 요청 시 사용.
---

# harness — 하네스 자기관리

이 하네스의 소스는 `~/Git/claude-harness-*` 레포다(최신 날짜가 현행). 로컬 `~/.claude/`는 배포본이다.
**항상 레포를 고치고 설치로 배포한다** — 로컬만 고치면 다음 설치 때 사라진다.

## 점검 (기본 동작)

1. 훅 등록 확인: `~/.claude/settings.json`의 hooks.PreToolUse에 guard.js·secrets-guard.mjs 항목이 있고, command의 node 경로가 실존하는지.
2. 회귀 테스트: `node <레포>/hooks/guard.test.js`와 `node <레포>/hooks/secrets-guard.test.mjs` — 둘 다 ALL PASS.
3. **실발화 확인** (등록만 보고 넘어가지 않는다): 셸 툴로 `git push --force origin main`을 비레포 디렉터리에서 시도 — guard가 실행 전에 deny하면 배선 정상. 훅이 죽어 있으면 git 오류("not a repository")가 나온다.
4. 파일 존재: `~/.claude/skills/{kickoff,red-review,wrapup,harness}`, `~/.claude/agents/{red-reviewer,verifier}.md`.
5. 레포-로컬 diff: 레포와 배포본이 다르면 보고하고 재설치를 제안.

## 구성 요소 추가/수정

- **새 스킬**: `<레포>/skills/<이름>/SKILL.md` 생성 — frontmatter의 description에 언제 쓰는지+트리거 문구를 반드시 포함 (모델은 description만 보고 스킬을 고른다). 이름은 기존 스킬(gstack 포함)과 충돌 금지.
- **가드 패턴 수정**: 테스트 케이스를 `hooks/guard.test.js`에 먼저 추가 → guard.js 수정 → ALL PASS 확인 → 배포. 테스트 없는 패턴 수정 금지.
- **훅 추가 원칙**: "모델의 어떤 한계 때문에 존재하는가"를 파일 상단 주석으로 남긴다. 모델이 좋아지면 제거 후보 목록이 된다.
- 수정 후 배포: `node <레포>/install.mjs` 실행 → 레포에 커밋/푸시.

## 설계 원칙 (수정할 때 지킬 것)

1. 훅 > 지시문: 반드시 지켜야 하는 규칙은 CLAUDE.md(부탁)가 아니라 훅(집행)으로.
2. 가드는 fail-open: 가드 자체 버그가 모든 명령을 마비시키면 안 된다. 차단은 명확한 패턴만.
3. 스킬은 선언적 자산: 실행 엔진(오케스트레이터)보다 규칙·지식(스킬/헌법)에 투자한다 — Claude Code 본체가 실행을 점점 잘하게 되기 때문.
