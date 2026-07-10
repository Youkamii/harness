# 하네스 엔지니어링 (Harness Engineering) 리서치

> 2026-06-10 작성. 21개 소스에서 105개 주장 추출, 상위 25개를 3표 적대적 검증.
> **[검증됨]** = 3표 검증 통과 (인용문 확인). **[미검증]** = 출처는 확실하나 검증 단계 미완료.
> 목적: 이 저장소에 에이전트 하네스를 직접 구축하기 위한 기반 조사.

---

## 1. 하네스란 무엇인가

**하네스 = 모델을 호출하는 루프 + 모델의 도구 호출을 실제 인프라로 라우팅하는 계층.**
Anthropic은 managed-agents 글에서 하네스를 "Claude를 호출하고 그 도구 호출을 인프라로 연결하는 루프"로 정의한다. **[검증됨]**

핵심 통찰 두 가지:

1. **모델 vs 하네스의 역할 분리.** 모델은 추론·판단을 담당하고, 하네스는 루프 실행, 도구 실행, 컨텍스트 관리, 권한 집행, 세션 영속성을 담당한다. 프론티어 모델(Opus 4.5)조차 Agent SDK 위에서 루프만 돌리면 프로덕션 품질 웹앱을 만들지 못한다 — 하네스 구조가 모델 능력과 별개로 결과를 크게 좌우한다. **[검증됨]**

2. **하네스는 모델의 한계에 대한 가정을 인코딩한 잠정적 비계(scaffolding)다.** "하네스는 Claude가 스스로 못 하는 것에 대한 가정을 인코딩한다" — 모델이 발전하면 그 가정이 낡아지므로, 하네스의 복잡성은 잠정적인 것으로 취급하고 주기적으로 제거를 검토해야 한다. **[검증됨]** 실례: Sonnet 4.5의 'context anxiety'(컨텍스트 한계 근처에서 작업을 서둘러 마무리하는 현상) 대응 장치가 Opus 4.5에서는 불필요한 짐이 되었다. **[미검증]**

배경: Anthropic은 2025-09-29 Claude Code SDK를 **Claude Agent SDK**로 개명했다. Claude Code의 하네스 인프라가 코딩을 넘어 범용 에이전트 구축에 재사용 가능하다는 포지셔닝이다. **[검증됨]**

---

## 2. 핵심 구성요소

### 2.1 에이전트 루프 (Agentic Loop)

Claude Code의 정준(canonical) 루프: **컨텍스트 수집 → 행동 → 작업 검증 → 반복.** **[검증됨]**

최소 구현은 놀랄 만큼 작다 — Thorsten Ball의 "How to Build an Agent"(ampcode.com)는 루프 + 3개 도구(read/list/edit) + Claude API 약 300줄로 동작하는 에이전트를 보여준다. 하네스 엔지니어링의 본질은 이 최소 루프에 신뢰성 장치를 얹는 일이다.

### 2.2 도구(Tool) 설계

- **"에이전트에게 컴퓨터를 줘라"** — Agent SDK의 중심 설계 원칙. 좁은 사전 정의 API에 가두지 말고 터미널/파일시스템 접근을 줘서 사람처럼 일하게 한다. **[검증됨]**
- 도구 인터페이스는 최소로: managed-agents 아키텍처는 도구를 `execute(name, input) -> string` 단일 인터페이스로 노출한다. **[검증됨]**
- 범용 프리미티브(bash, read, edit, glob, grep)가 다수의 특화 도구보다 우선. 특화 도구는 반복되는 고빈도 패턴에만 추가.

### 2.3 컨텍스트 관리 — 하네스 엔지니어링의 중심 문제

| 기법 | 내용 | 검증 |
|---|---|---|
| 컴팩션(compaction) | 컨텍스트 한계 접근 시 이전 메시지를 자동 요약하고 새 컨텍스트로 재개. 아키텍처 결정·미해결 버그는 보존, 중복 도구 출력은 폐기 | 검증됨 / 세부는 미검증 |
| 컨텍스트 리셋 + 아티팩트 핸드오프 | 장기 작업에서는 컴팩션만으로 부족 — 구조화된 아티팩트(진행 로그, 기능 목록)를 남기고 컨텍스트를 완전히 리셋하는 쪽이 우수 | **검증됨** |
| 서브에이전트 | (1) 병렬화, (2) 컨텍스트 격리 — 메인 에이전트의 윈도우를 깨끗하게 유지. 서브에이전트는 수만 토큰을 탐색해도 1-2천 토큰 요약만 반환 | **검증됨** / 토큰 수치는 미검증 |
| 외부 아티팩트 메모리 | 세션 간 기억은 모델 컨텍스트가 아닌 외부 산출물로: 진행 로그 파일(`claude-progress.txt`), 서술적 커밋 메시지의 git 히스토리, 실패 상태로 초기화된 JSON 기능 목록. 매 세션 시작 시 이를 읽고 따라잡는다 | **검증됨** |
| 하이브리드 로딩 | CLAUDE.md류는 선로딩, 나머지는 glob/grep으로 just-in-time 검색 | 미검증 (출처: Anthropic context engineering 글) |
| 점진적 공개(progressive disclosure) | 스킬은 이름+설명만 시스템 프롬프트에 선로딩, 본문은 필요 시 파일 읽기로 로드. 전제조건: 하네스가 파일시스템 + 코드 실행 도구를 제공해야 함 | 미검증 (출처: Anthropic agent skills 글) |

### 2.4 세션과 상태 — "하네스는 cattle, 세션은 진실"

managed-agents 아키텍처는 세 컴포넌트를 분리한다: **brain**(모델+하네스), **hands**(샌드박스·도구), **session**(append-only 이벤트 로그). 각각 독립적으로 실패·교체 가능. **[검증됨]**

세션 로그를 하네스 외부에 저장하면 하네스는 무상태·일회용이 된다: 하네스가 죽어도 `wake(sessionId)`로 새로 띄우고 `getSession(id)`으로 이벤트 로그를 복구해 마지막 이벤트부터 재개. **[검증됨]**

### 2.5 권한·샌드박싱

- 자격증명(credential)은 샌드박스에 아예 넣지 않는다 — 예: git push/pull이 에이전트가 토큰을 만지지 않고도 동작하게 프록시. **[미검증]**
- OpenAI Codex CLI는 OS 수준 샌드박스(macOS Seatbelt, Linux Landlock) + 승인 모드 계층을 사용 (출처: openai.com "Unlocking the Codex harness").
- Claude Code 계열은 권한 모드(승인 프롬프트, allowlist, 훅에 의한 인터셉트)로 계층화.

---

## 3. 대표 구현체 비교

| 하네스 | 특징 |
|---|---|
| **Claude Code / Claude Agent SDK** | 정준 루프 + 범용 도구 + 컴팩션 + 서브에이전트 + 스킬(점진적 공개) + 훅/권한. SDK는 동일 하네스를 라이브러리로 노출 |
| **OpenAI Codex CLI** | Rust 기반, OS 수준 샌드박싱 강조, Responses API 중심 |
| **Gemini CLI** | 오픈소스(Apache 2), ReAct 계열 루프, MCP 지원 |
| **pi (Mario Zechner)** | 극단적 미니멀리즘 — 작은 루프 + 적은 도구가 거대한 프레임워크보다 디버깅·제어가 쉽다는 입장. "최소 하네스" 진영의 대표 |
| **ampcode "How to Build an Agent"** | 교육용 최소 구현 (~300줄). 루프+도구만으로 에이전트가 됨을 증명 |
| **OpenDev (구 OpenHands)** | Extended ReAct 루프 — 반복마다 사전점검/컴팩션, 사고, 자기비판, 행동, 도구 실행, 후처리 단계 **[미검증]** |

스펙트럼은 "최소 루프"(pi, ampcode) ↔ "풀 하네스"(Claude Code)이며, 공통 수렴점은: 단순한 루프, 범용 도구, 파일시스템 기반 컨텍스트, 외부화된 세션.

---

## 4. 평가(evals)와 하네스 개선 루프

- 벤치마크는 **모델+하네스 조합**을 측정한다: SWE-bench (Verified/Pro), terminal-bench 등. 같은 모델도 하네스에 따라 점수가 크게 달라진다 — 하네스 엔지니어링이 독립 변수.
- Anthropic "Demystifying evals for AI agents": 에이전트 평가는 (1) 결과 기반 채점(테스트 통과 등 검증 가능한 결과), (2) 능력별 분해, (3) 실패 사례에서 역으로 eval을 만드는 루프를 권장.
- **자기 평가 금지 원칙**: 에이전트는 자기 산출물을 신뢰성 있게 평가하지 못한다(자화자찬 편향). 해법은 GAN식 **생성자/평가자 분리** — 별도 평가자 에이전트가 Playwright MCP로 실행 중인 앱을 사용자처럼 테스트. **[검증됨]**
- 개선 루프: 실제 실패 사례 수집 → eval로 변환 → 하네스 수정 → 재측정. `evals/` 디렉토리를 하네스 저장소의 1급 시민으로.

---

## 5. 모범 사례와 안티패턴

### 검증된 안티패턴 (하네스 없는 장기 실행 에이전트의 실패 양상) **[검증됨]**

1. **원샷 시도** — 앱 전체를 한 번에 만들려 함 → 한 번에 한 기능씩 강제.
2. **조기 완료 선언** — 작업이 끝나지 않았는데 끝났다고 함.
3. **미검증 완료 표시** — 테스트 없이 기능을 완료로 마킹 → 브라우저 자동화로 사람처럼 end-to-end 테스트 강제.

### 검증된 모범 사례

- **이니셜라이저/코더 분리**: 첫 실행에서 환경을 세팅하는 initializer 에이전트 + 점진적으로 진행하는 coding 에이전트. 시스템 프롬프트·도구·하네스는 동일, 초기 사용자 프롬프트만 다름. **[검증됨]**
- **장기 작업은 컴팩션보다 리셋+아티팩트**: 진행 로그·기능 목록(JSON, 전부 failing으로 초기화)·git 히스토리를 남기고 컨텍스트를 리셋. **[검증됨]**
- **생성자/평가자 분리** (위 4절). **[검증됨]**
- **하네스 단순성 유지**: 하네스 복잡성은 모델 한계에 대한 가정 — 모델 업그레이드 시마다 제거 가능한 부분을 점검. **[검증됨]**

---

## 6. 우리 하네스를 위한 설계 원칙 (권장)

1. **루프는 최소로, 신뢰성 장치는 루프 밖에.** gather → act → verify → repeat 단일 루프. 복잡성은 도구·아티팩트·평가자로 밀어낸다.
2. **세션 = append-only 이벤트 로그, 하네스 외부 저장.** 하네스는 무상태·일회용(cattle). 크래시 후 `wake(sessionId)`식 재개 가능 구조.
3. **도구는 `execute(name, input) -> string` 단일 인터페이스.** 범용 프리미티브(bash/read/edit/glob/grep) 먼저, 특화 도구는 패턴이 입증된 후.
4. **에이전트에게 컴퓨터를 준다.** 파일시스템 + 코드 실행이 점진적 공개(스킬), JIT 컨텍스트 로딩의 전제조건.
5. **컨텍스트 전략은 3단**: (a) 한 세션 내 컴팩션, (b) 탐색은 서브에이전트로 격리, (c) 세션 간엔 리셋+외부 아티팩트(진행 로그, 기능 목록 JSON, git).
6. **작업자와 평가자를 분리.** 자기 평가를 신뢰하지 않는다. verify 단계는 별도 에이전트 또는 결정적 검증(테스트/브라우저 자동화).
7. **권한은 하네스가 집행, 자격증명은 샌드박스 밖에.**
8. **evals를 처음부터.** 실패 사례 → eval 변환 루프. 하네스 변경은 벤치마크로 측정 (기존 `evals/` 디렉토리 활용).
9. **모든 하네스 장치에 "어떤 모델 한계를 가정하는가"를 문서화.** 모델 업그레이드 시 제거 후보 목록이 된다.

### 권장 초기 아키텍처 스케치

```
harness/
  loop.ts          # 단일 에이전트 루프 (gather→act→verify→repeat)
  session/         # append-only 이벤트 로그 (JSONL), 하네스 외부 영속화
  tools/           # execute(name, input)->string; bash, read, edit, glob, grep
  context/         # 컴팩션, 서브에이전트 스폰, 아티팩트 핸드오프
  permissions/     # 권한 모드, allowlist, 훅
evals/             # 실패사례→eval 루프, 벤치마크 러너
docs/
```

---

## 출처

**Anthropic engineering (1차 소스)**
- https://www.anthropic.com/engineering/managed-agents — 하네스 정의, brain/hands/session 분리, stateless 하네스
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — 장기 실행 하네스, 외부 아티팩트 메모리, 안티패턴
- https://www.anthropic.com/engineering/harness-design-long-running-apps — 컨텍스트 리셋, 생성자/평가자 분리
- https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk — 정준 루프, "give agents a computer", 서브에이전트
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — 컴팩션, JIT 검색, 멀티에이전트 토큰 경제
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills — 점진적 공개
- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents — 에이전트 평가

**기타**
- https://openai.com/index/unlocking-the-codex-harness/ — Codex 하네스
- https://ampcode.com/notes/how-to-build-an-agent — 최소 에이전트 (~300줄)
- https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ — 미니멀 하네스 철학
- https://addyosmani.com/blog/agent-harness-engineering/ — 하네스 엔지니어링 개관
- https://magazine.sebastianraschka.com/p/components-of-a-coding-agent — 코딩 에이전트 구성요소
- https://www.decodingai.com/p/agentic-harness-system-design — 하네스 시스템 설계
- https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents — 실무 하네스 엔지니어링
- https://arxiv.org/html/2603.05344v1 — scaffolding vs harness 형식화, OpenDev 루프 분석
- https://github.com/Yuyz0112/claude-code-reverse, https://github.com/ComeOnOliver/claude-code-analysis — Claude Code 역분석
