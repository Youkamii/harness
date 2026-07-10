# claude-harness — 개인 자율형 하네스

Claude Code 위에 얹는 **개인 전용 하네스**. 핵심 철학: `Agent = Model + Harness` — 모델이 아닌 전부가 하네스고, 하네스는 실행 엔진이 아니라 **규칙과 지식의 선언적 저장소**로 만든다 (Claude Code 본체가 실행은 점점 잘하게 되므로).

세 가지를 강제한다:

1. **자율** — 사용자에게 묻지 않고 스스로 판단·기록한다 (비용·파괴·외부공개만 예외). 단, 요청 범위를 넘겨짚어 확장하지 않는다.
2. **검증** — 실행한 것만 완료다. 자기 평가를 믿지 않고 멀티에이전트 적대 리뷰로 검증한다.
3. **집행** — 반드시 지킬 규칙은 프롬프트(부탁)가 아니라 훅(코드)으로 막는다.

## 구성

| 경로 | 역할 |
|---|---|
| `CLAUDE.md` | 헌법 — 자율 원칙, 사실/추측 구분(확인됨·추정·미확인), 파이프라인 규칙. 설치 시 `~/.claude/CLAUDE.md`에 마커 블록으로 병합 |
| `skills/kickoff` | 기능 개발 파이프라인: 태스크 분해 → GitHub 이슈 → 기능별 커밋(#이슈) → 실행 검증 → 적대 리뷰 → 이슈 닫기 |
| `skills/red-review` | 멀티에이전트 적대 리뷰: red-reviewer를 정합성·보안·단순화 렌즈로 병렬 3개 소환 → 직접 재확인 → CONFIRMED만 수정 |
| `skills/wrapup` | 마무리 의식: 검증 상태 정리, 남은 일 이관, 교훈 저장 |
| `skills/harness` | 하네스 자기관리: 점검·패턴 추가·재배포 |
| `agents/red-reviewer.md` | 적대적 리뷰어 (렌즈 지정형, 반증 가능한 보고만) |
| `agents/verifier.md` | 독립 검증자 (실행해서 확인됨/실패/미검증 판정) |
| `hooks/guard.js` | 파괴 명령 가드: 루트/홈/시스템 디렉터리 삭제·main 강제 푸시 차단(deny), rm -rf·reset --hard는 모델에게만 경고 주입(warn) — 사용자를 절대 호출하지 않음. 회귀 테스트 35케이스 |
| `hooks/secrets-guard.mjs` | 비밀 커밋 차단: git add/commit(-a 포함, cd 복합 명령 추적) 직전 API 키·.env·개인키 검사. 회귀 테스트 6케이스 |
| `install.mjs` | 멱등 설치기: 테스트 → 복사 → settings.json/CLAUDE.md 병합 |

## 설치

```powershell
# Windows
.\install.ps1
```

```sh
# macOS / Linux
./install.sh
```

Node.js 필요. 몇 번을 다시 실행해도 안전하다(멱등). 기존 `~/.claude`의 다른 스킬·설정은 건드리지 않는다.

## 사용 흐름

```
새 기능 시작   → /kickoff   (태스크·이슈 → 검증 → 기능별 커밋 → 리뷰 → 푸시가 한 파이프라인)
푸시 전        → /red-review (적대 리뷰 1회 — 기능마다가 아니라 푸시 전 묶음으로)
작업 끝낼 때   → /wrapup    (검증 상태·남은 일·교훈 정리)
하네스 점검    → /harness   (훅 등록·회귀 테스트·실발화·동기화 확인)
```

알려진 한계: guard는 명령 문자열 전체를 검사하므로 echo나 커밋 메시지 속 위험 패턴도 차단될 수 있다(의도된 보수성 — 우회는 파일 경유). 자세한 근거는 각 훅 파일 상단 주석 참고.

## 유지보수 규칙

- **레포가 소스, `~/.claude`는 배포본.** 항상 레포를 고치고 `node install.mjs`로 배포한다.
- 가드 패턴 수정은 `hooks/guard.test.js`에 테스트 케이스 먼저 추가 → 수정 → `ALL PASS` → 배포.
- 훅을 추가할 때는 "모델의 어떤 한계 때문에 존재하는가"를 주석으로 남긴다 — 모델이 좋아지면 제거 후보 목록이 된다.

## 계보와 참고

- 전신: [codex-harness-2026-07-11](https://github.com/Youkamii/codex-harness-2026-07-11) — 사실/추측 구분 헌법과 secrets-guard를 이식했다.
- 설계 참고 (2026-07 조사): [Superpowers](https://github.com/obra/superpowers)의 단계 강제 워크플로, [everything-claude-code](https://github.com/affaan-m/everything-claude-code)의 스킬 체계, sd0x-dev-flow의 "훅 > 지시문" 집행 원칙, [Anthropic Dynamic Workflows](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)의 "선언적 자산에 투자" 방향.
