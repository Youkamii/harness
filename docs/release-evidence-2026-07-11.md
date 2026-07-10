# 릴리스 검증 증거 — 2026-07-11

이 문서는 `codex-harness-2026-07-11` 릴리스 후보를 로컬에서 검증한 결과를 고정합니다. 에이전트의 “완료” 문장이 아니라, 실제 명령의 종료 코드와 테스트 수를 기준으로 기록했습니다.

## 자동 검증

| 검증 | 결과 |
| --- | --- |
| `npm run check` | 통과 — TypeScript 오류 0건 |
| `npm test` | 통과 — 48/48, 실패 0, 건너뜀 0 |
| `npm run eval` | 통과 — 6/6 정책 사례 |
| `npm run validate` | 통과 — 저장소·manifest·marketplace·skill 구조 |
| `npm run doctor` | 통과 — 5/5; Node 22.17.0, Git, GitHub 인증, Codex 0.144.1, 검증 sandbox |
| 공식 plugin validator | 통과 |
| 공식 skill validator | `$forge`, `$forge-review` 모두 통과 |
| `git diff --check` | 통과 |

## 실제 Codex 호출

`npm run smoke:agent`는 임시 Git 저장소를 만들고 설치된 Codex CLI 0.144.1의 planner를 실제로 호출했습니다. planner는 파일을 수정하지 않은 채 요구된 구조화 계획을 반환했고 다음 결과로 종료했습니다.

```json
{
  "passed": true,
  "task": "docs"
}
```

## 독립 적대 검토

서로 결론을 공유하지 않은 역할별 에이전트가 수락 조건, 보안 경계, 운영 가능성을 공격적으로 검토했습니다. 검토 중 발견된 주요 문제는 다음 회귀 방어로 바뀌었습니다.

- journal보다 snapshot을 신뢰하는 상태 위조 방지
- 동일 목표 동시 생성과 controller/run lock 경합 방지
- 작업트리 symlink/junction 탈출 및 상대 실행 파일 탈출 방지
- Git hook, 외부 clean/smudge/process filter, fsmonitor 실행 방지
- timeout·출력 한도 도달 시 자식 프로세스 트리 종료
- dirty/untracked submodule 내용 누락 방지
- submodule realpath 탈출·재귀 cycle·과도한 깊이 방지
- 부분 적용 중 중단된 통합 remediation의 내구성 있는 재생
- 현재 통합 SHA와 task별 검증·수락·커밋·서로 다른 두 reviewer 증거 강제

최종 재검토에서는 수락 조건과 보안 범위 모두 critical/high 차단 사항이 없다는 판정을 받았습니다.

## 재현

```bash
npm ci
npm run check
npm test
npm run eval
npm run validate
npm run doctor
npm run smoke:agent
```

실제 모델 스모크는 Codex 인증을 사용하므로 로컬 릴리스 검증에서 실행합니다. GitHub Actions는 Ubuntu와 Windows에서 결정론적 검증 묶음을 실행하고, 테스트가 건너뛰어진 경우도 실패로 취급합니다.
