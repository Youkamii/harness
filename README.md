# Harness

월 구독에 포함된 Claude Code를 엔진으로 쓰는 **개인 하네스** — 행동 통제(훅/권한), 반복 프롬프트(CLAUDE.md/스킬), 장기 실행(오케스트레이터), 측정(evals). API 추가 과금 없음.

- 구조 설명: [docs/architecture.md](docs/architecture.md)
- 기반 리서치: [docs/harness-engineering-research.md](docs/harness-engineering-research.md)

## 빠른 사용법

```bash
# 최초 1회 (PC마다): 전역 설치 — harness 명령이 생긴다
./install.sh

# 이후 평소 사용: 아무 폴더에서 claude 실행하면 하네스가 자동 적용됨
claude
```

`harness` 명령 (설치 후 어디서나):

```bash
harness run "목표" --cwd ~/Git/대상프로젝트   # 장기 실행 (한도 도달 시 자동 대기)
harness eval                                  # 하네스 성능 측정
harness update                                # 다른 PC에서 수정사항 받기 (git pull + 재설치)
harness edit                                  # 하네스 소스를 Claude Code로 열기
harness test                                  # guard 훅 회귀 테스트
```

새 PC에 설치: `git clone <저장소주소> ~/Git/Harness && ~/Git/Harness/install.sh`

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
