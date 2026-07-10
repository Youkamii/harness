# harness — 개인 하네스 모노레포

모든 하네스를 한 저장소로 관리한다. **현행은 claude-harness이고, 소스를 고치면 install로 배포한다.**

| 디렉터리 | 상태 | 내용 |
|---|---|---|
| [`claude-harness-2026-07-11/`](claude-harness-2026-07-11/) | **현행** | Claude Code 자율형 하네스 — 자율·검증·집행, 멀티에이전트 적대 리뷰 파이프라인. 설치: `node claude-harness-2026-07-11/install.mjs` |
| [`codex-harness-2026-07-11/`](codex-harness-2026-07-11/) | 은퇴(보존) | 전신 codex 하네스 — 오케스트레이터·evals 등 재이식 후보 자산 보관용 |

## 규칙

- 이 레포가 소스, `~/.claude/`는 배포본. 로컬만 고치면 다음 설치 때 사라진다.
- 가드 패턴 수정은 테스트 케이스 먼저 (`claude-harness-*/hooks/*.test.*`).
- 새 하네스 버전을 만들면 디렉터리를 추가하고 이 표의 "현행"을 옮긴다.
