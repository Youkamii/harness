# harness — 개인용 AI 코딩 하네스 모노레포

이 저장소는 Claude Code와 Codex용 개인 하네스를 한곳에서 관리합니다. 둘 다 **현행 버전**이며 함께 설치해도 서로 충돌하지 않습니다.

## 하네스가 무엇인가

AI 모델이 두뇌라면 하네스는 그 두뇌가 실제 저장소에서 일하는 방식입니다. 행동 규칙, 작업 순서, 권한 경계, Git·GitHub 처리, 테스트, 재시도, 독립 리뷰와 완료 판정을 묶습니다.

```text
사용자 요청
   ↓
하네스: 범위 고정 → 계획 → 격리 구현 → 기계 검증 → 독립 리뷰 → 증거 게이트
   ↓
검증된 코드와 추적 가능한 작업 기록
```

목표는 단순히 모델이 더 많은 코드를 쓰게 하는 것이 아닙니다.

- 사소한 선택은 저장소 근거를 보고 스스로 판단합니다.
- 사용자가 요청하지 않은 기능이나 배포까지 넘겨짚지 않습니다.
- 질문과 작업이 한 메시지에 있으면 질문에 먼저 답하고 작업은 병렬로 계속합니다.
- “완료했습니다”라는 문장 대신 실제 테스트·커밋·리뷰 증거를 요구합니다.
- 구현자와 검증자를 분리해 자기 코드에 관대해지는 문제를 줄입니다.

## 들어 있는 하네스

| 디렉터리 | 대상 | 형태 | 가장 잘하는 일 | 상태 |
| --- | --- | --- | --- | --- |
| [`claude-harness-2026-07-11/`](claude-harness-2026-07-11/) | Claude Code | 헌법·훅·스킬·서브에이전트 설정 묶음 | 모든 Claude 세션에 가벼운 기본 규칙과 명령 직전 안전장치 적용 | **현행** |
| [`codex-harness-2026-07-11/`](codex-harness-2026-07-11/) | OpenAI Codex | 플러그인·스킬·TypeScript 실행 컨트롤러 | 긴 기능 작업을 이슈·작업 DAG·worktree·증거 원장으로 끝까지 운영 | **현행** |

### 어떤 것을 쓰면 되나

- Claude Code로 작업하면 Claude 하네스를 설치합니다.
- Codex로 작업하면 Codex 하네스를 설치합니다.
- 둘 다 사용하면 둘 다 설치합니다. Claude 설정은 `~/.claude`에, Codex 플러그인은 Codex marketplace에 설치되므로 배포 위치가 다릅니다.

### 두 하네스의 관계 — 형제 정렬

둘은 **같은 철학의 쌍둥이**입니다. `CLAUDE.md`와 `AGENTS.md`를 나란히 놓으면 거의 같은 문서입니다: 질문 먼저, 자율+범위 절제, 기능별 이슈·커밋, **증거 없이는 완료 없음**. 엔진(Claude Code / Codex)만 다릅니다.

- **동시 사용은 충돌하지 않습니다.** 지시 파일(`CLAUDE.md` vs `AGENTS.md`)도 배포 위치(`~/.claude` vs plugins)도 달라 서로 밟지 않습니다. Claude Code를 켜면 `AGENTS.md`는 무시되고, Codex를 켜면 `CLAUDE.md`가 무시됩니다.
- **증거 계약은 같은 언어를 씁니다.** Codex 하네스의 `plugins/codex-harness/schemas/review-output.json`(verdict·commands·exitCode)과 Claude 하네스의 `contracts/workflow-result.schema.json`(verification·evidence·verifiedBy)은 "판정은 외부 증거에 결합돼야 한다"는 같은 규칙의 두 표현입니다. 한쪽을 바꾸면 다른 쪽 어휘도 맞춥니다.
- **크로스벤더 다리**: Claude 하네스의 `workflows/red-review.js`는 Claude가 찾은 결함을 **Codex가 독립 검증**합니다. Codex 하네스가 자기 README에서 약점으로 인정한 "작업·리뷰 에이전트가 같은 모델이라 실수를 강화한다"를 정확히 메우는 지점 — 두 엔진을 한 검증 루프로 잇습니다.

## Claude 하네스는 어떻게 작동하나

Claude 하네스는 Claude Code가 기본 제공하는 설정 확장 지점에 얹는 **가벼운 상시 보호막**입니다.

```text
세션 시작       CLAUDE.md 헌법 자동 주입
명령 실행 직전  guard·secrets hook이 위험 명령과 비밀 커밋 검사
기능 요청       /kickoff가 계획 → 이슈 → 구현 → 기능별 커밋 순서 강제
푸시 전         /red-review가 서로 다른 렌즈의 리뷰어를 병렬 호출
작업 종료       /wrapup이 검증 상태·남은 일·교훈 정리
```

핵심 구성은 다음과 같습니다.

- `CLAUDE.md`: 묻지 않고 진행하되 범위를 넘겨짚지 않는 행동 원칙입니다.
- `hooks/`: 루트 삭제·기본 브랜치 강제 푸시 같은 재앙급 명령을 실행 직전에 차단하고, 커밋 대상의 API 키·개인키·`.env`를 검사합니다.
- `skills/`: `/kickoff`, `/red-review`, `/wrapup`, `/harness` 작업 절차입니다.
- `agents/`: 구현 맥락에서 분리된 적대 리뷰어와 실제 실행 검증자입니다.
- `install.mjs`: 기존 사용자 설정을 보존하면서 필요한 블록과 파일만 멱등 배포합니다.

상세한 훅 판정표, 스킬별 순서와 알려진 한계는 [Claude 하네스 README](claude-harness-2026-07-11/README.md)에 있습니다.

## Codex 하네스는 어떻게 작동하나

Codex 하네스는 단순 지시문보다 강한 **내구성 있는 기능 실행 시스템**입니다. 모델은 계획·구현·리뷰를 담당하고, TypeScript 컨트롤러만 Git·GitHub·상태·재시도·완료 판정을 바꿀 수 있습니다.

```text
$forge 요청
   ↓
범위와 비목표 고정
   ↓
의존성 있는 작업 DAG + 기능별 GitHub 이슈
   ↓
기능별 branch/worktree에서 최소 권한 Codex 구현
   ↓
샌드박스 기계 검증 → 기능별 커밋
   ↓
수락 감사자 + 적대 리뷰어 동시 검토
   ↓
통합 브랜치에서 전체 재검증
   ↓
현재 SHA에 묶인 증거가 모두 있을 때만 complete
```

주요 차이는 다음과 같습니다.

- 작업마다 GitHub 이슈, 소유 경로, 수락 기준과 검사 명령이 필요합니다.
- 작업마다 별도 worktree를 사용하고, 의존 작업의 실제 커밋을 자식 작업에 전달합니다.
- 구현자는 쓰기 가능, planner와 reviewer는 읽기 전용으로 실행합니다. 중첩 플러그인·앱·브라우저·멀티에이전트 권한은 leaf worker에서 끕니다.
- 모든 상태 변경은 Git common directory의 hash-chain journal에 남습니다. 프로세스가 중단돼도 정확한 단계와 Codex thread를 복구합니다.
- 검사 명령 전에는 같은 sandbox가 외부 네트워크에 연결할 수 없는지 probe합니다. 격리를 증명하지 못하면 실제 검사를 실행하지 않고 차단하며, 실행된 검사가 종료 코드 0이어도 파일을 몰래 바꾸면 실패합니다.
- 서로 다른 두 reviewer가 task별로 승인해야 합니다. agent의 `PASS`나 `DONE` 텍스트는 증거가 아닙니다.
- 통합 뒤 실패하면 관련 작업과 그 하위 작업을 다시 열고, 내구성 있는 remediation intent를 재생합니다.
- 자동 권한은 요청한 결과를 수행할 권한일 뿐, 배포·다른 저장소 변경·추가 기능으로 범위를 넓힐 권한이 아닙니다.

11단계 전체 흐름, 보안 경계, 상태 복구와 최근 30일 조사 근거는 [Codex 하네스 README](codex-harness-2026-07-11/README.md)에 있습니다.

## 설치

먼저 이 저장소를 받습니다.

```powershell
git clone https://github.com/Youkamii/harness.git
Set-Location harness
```

### Claude Code에 설치

```powershell
.\claude-harness-2026-07-11\install.ps1
```

macOS/Linux:

```bash
./claude-harness-2026-07-11/install.sh
```

설치기는 회귀 테스트를 먼저 실행하고, 통과한 헌법·훅·스킬·에이전트만 `~/.claude`에 병합합니다. 같은 명령을 다시 실행해도 중복 등록하지 않습니다.

### Codex에 설치

요구 사항은 Git, Node.js 20.11 이상, 인증된 GitHub CLI, Codex CLI 0.144.1 이상입니다.

```powershell
Set-Location codex-harness-2026-07-11
npm ci
npm run doctor
npm run install:plugin
```

설치 후 Codex 새 세션에서 다음처럼 사용합니다.

```text
$forge 로그인 재시도 기능을 구현해. 공개 API는 유지하고 배포는 하지 마.
```

컨트롤러를 직접 확인할 때:

```powershell
node plugins\codex-harness\skills\forge\scripts\forge.mjs status
node plugins\codex-harness\skills\forge\scripts\forge.mjs resume
```

## 검증

Claude 하네스:

```powershell
node claude-harness-2026-07-11\hooks\guard.test.js
node claude-harness-2026-07-11\hooks\secrets-guard.test.mjs
```

Codex 하네스:

```powershell
Set-Location codex-harness-2026-07-11
npm run check
npm test
npm run eval
npm run validate
npm run doctor
```

Codex 테스트는 DAG, 이슈·worktree·커밋, lock 경합, hash journal 복구, symlink/junction 탈출, Git hook/filter 차단, 프로세스 트리 종료, task별 증거 게이트와 remediation 재생을 포함합니다. GitHub Actions는 Ubuntu와 Windows에서 이 묶음을 실행합니다.

## 저장소 운영 규칙

- 이 모노레포가 두 하네스의 사용자용 기준 저장소입니다.
- Claude의 `~/.claude`와 Codex의 설치된 플러그인은 배포본입니다. 배포본만 직접 고치지 말고 해당 하네스 디렉터리를 수정한 뒤 설치기를 다시 실행합니다.
- `codex-harness-2026-07-11/`은 독립 개발 저장소의 Git subtree입니다. upstream 변경은 히스토리를 보존하는 `git subtree pull`로 반영합니다.
- Claude 훅 변경은 회귀 테스트를 먼저 추가합니다. Codex 기능 변경은 GitHub 이슈, 기능별 커밋, 전체 검증과 적대 리뷰 증거를 남깁니다.
- 새 날짜 버전이 생기면 새 디렉터리를 추가하고 이 README의 현행 표시를 갱신합니다.
