# contracts — 워크플로우 공통 계약

harness의 모든 저장 워크플로우(red-review, deep-audit, memory-audit …)가 지키는 입출력 계약.
자동화가 "추측"이 아니라 "고정된 계약" 위에 서게 하는 Phase 1 기반 자산이다.
(출처: fable5-asset-masterplan.md — 크로스모델 적대 토론으로 확정)

**형제 정렬**: 이 계약은 Codex 하네스의 `plugins/codex-harness/schemas/review-output.json`
(verdict·commands·exitCode)과 같은 규칙의 두 표현이다 — "판정은 외부 증거에 결합돼야 한다".
필드명은 다르지만(verification↔verdict, evidence+verifiedBy↔commands+exitCode) 의미는 정렬돼 있다.
한쪽 어휘를 바꾸면 다른 쪽도 맞춘다 (레포 최상위 README의 "형제 정렬" 참조).

## 파일

| 파일 | 역할 |
|---|---|
| `workflow-result.schema.json` | 워크플로우 최종 반환값(envelope) 계약 v1 |
| `run-summary.schema.json` | 실행 기록(summary) 계약 v1 |
| `validate.mjs` | 의존성 제로 JSON Schema 부분집합 검증기 |
| `contracts.test.mjs` | 회귀 테스트 — `node contracts/contracts.test.mjs` |
| `samples/` | 유효 샘플 (문서 겸 fixture) |

## 핵심 규칙 (토론으로 확정된 것을 스키마가 강제한다)

1. **발견(finding)의 verification은 3분류를 모두 보존한다**: `CONFIRMED` / `DISPUTED` / `UNVERIFIED`.
   차단 조건으로 쓰는 것은 CONFIRMED뿐이다.
2. **CONFIRMED는 외부 증거 없이 불가** — 스키마가 `evidence`(재현 명령·테스트·정적 분석)와
   `verifiedBy`를 필수로 강제한다. 동일 모델 다수결은 검증이 아니다.
3. **조용한 축소 금지** — 검사 범위를 줄였으면 `notes`에 남긴다. 안 남기면 "전부 검사함"으로 읽힌다.

## summary 기록 규약 (F4)

- **위치**: 워크플로우를 실행한 저장소의 `.claude/workflow-runs/<run_id>/summary.json` (gitignore 대상)
- **시점**: 워크플로우 종료 직후 메인 루프(Claude)가 기록한다.
  워크플로우 스크립트 안에서는 시계(Date.now)를 쓸 수 없으므로 스크립트가 직접 기록하지 않는다.
- **상한**: 자체 상한 엔진을 만들지 않는다. Claude Code Workflow 도구의 내장
  budget(토큰 목표)·동시성 캡·에이전트 총량 상한을 사용하고, summary에는 소비량만 기록한다.

## 소비 방법

Workflow 스크립트는 파일시스템에 접근할 수 없다. 워크플로우를 작성/수정하는 시점에
이 스키마를 읽어 `agent(..., {schema})` 인자와 `return` 구조에 반영한다.
**이 디렉토리가 정본이고, 스크립트 안에 박힌 사본은 파생본이다** — 계약을 바꾸면 스크립트를 재생성한다.

## 버전 정책

계약을 바꿀 때 이 파일들을 제자리에서 고치지 않는다. `workflow-result/v2` 스키마 파일을 새로 추가한다.
`contract` 필드가 스키마 선택자다. 소비자(워크플로우)가 전부 v2로 넘어간 뒤에만 v1을 제거한다.
