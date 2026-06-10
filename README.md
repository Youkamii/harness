# Harness

월 구독에 포함된 Claude Code를 엔진으로 쓰는 **개인 하네스** — 행동 통제(훅/권한), 반복 프롬프트(CLAUDE.md/스킬), 장기 실행(오케스트레이터), 측정(evals). API 추가 과금 없음.

- 구조 설명: [docs/architecture.md](docs/architecture.md)
- 기반 리서치: [docs/harness-engineering-research.md](docs/harness-engineering-research.md)

## 빠른 사용법

```bash
# 1) 이 폴더에서 그냥 claude 실행 — 개조(훅·권한·스킬)가 자동 적용됨
claude

# 2) 다른 모든 프로젝트에도 적용하려면 전역 설치
./install.sh

# 3) 장기 실행 (구독 한도 도달 시 자동 대기 후 재개)
node orchestrator/run.mjs "만들 것에 대한 목표 설명" --cwd ~/Git/대상프로젝트

# 4) 하네스를 수정했으면 측정
node evals/run.mjs
```

## 세션 안에서 쓰는 명령

| 명령 | 역할 |
|---|---|
| `/checkpoint` | 진행 상황을 `.harness/` 파일로 저장 (다음 세션 이어받기용) |
| `/resume` | 저장된 진행 상황과 git log를 읽고 작업 이어받기 |
| `evaluator` 서브에이전트 | "evaluator로 검증해줘" — 결과물을 적대적으로 실행 검증 |

## 안전장치 요약

- **권한**: 기본 자동 진행, `rm -rf`/`sudo`/`git push`/`curl`만 승인 요청 (`.claude/settings.json`)
- **훅**: 승인을 건너뛰는 모드에서도 파괴적 명령(홈 삭제, 강제 푸시, 디스크 쓰기 등)은 코드로 차단 (`.claude/hooks/guard.js`)
- **비밀**: `.env`, `secrets/` 읽기 차단
