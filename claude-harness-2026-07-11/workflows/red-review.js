// red-review — 크로스벤더 적대 리뷰 워크플로우
// Claude 서브에이전트 3렌즈(정합성·보안·단순화)가 병렬로 결함을 찾고, 각 발견을 다른 회사 모델
// (OpenAI Codex CLI)이 독립 검증한다. "같은 모델 다수결은 독립 검증이 아니다" 원칙의 실행체.
// 반환값은 contracts/workflow-result.schema.json (workflow-result/v1) 계약을 따른다.
//
// 실행: Workflow 도구로 이 스크립트를 invoke. args로 대상 지정 가능:
//   { target: "src/auth.ts against main", model: "gpt-5.6-sol" }
// args 없으면 현재 git diff를 대상으로 한다.
export const meta = {
  name: 'red-review',
  description: '크로스벤더 적대 리뷰 — Claude 3렌즈가 찾고 Codex가 독립 검증, CONFIRMED만 통과',
  phases: [
    { title: 'Review', detail: 'Claude 3렌즈 병렬 리뷰' },
    { title: 'Cross-verify', detail: '발견별 Codex 교차 검증' },
    { title: 'Assemble', detail: 'workflow-result 계약 조립' },
  ],
};

const TARGET = (args && args.target) || '현재 브랜치의 git diff (base 브랜치 대비)';
const MODEL = (args && args.model) || 'gpt-5.6-sol';

const LENSES = [
  {
    key: 'correctness',
    ko: '정합성',
    focus: '코드가 주장대로 동작하는가. 논리 오류, 경계 조건, null/예외 경로, 상태 불변식 위반, 회귀.',
  },
  {
    key: 'security',
    ko: '보안',
    focus: '신뢰 경계, 주입, 인증/인가 우회, 비밀 노출, 파괴적 부작용, 자원 고갈.',
  },
  {
    key: 'simplicity',
    ko: '단순화',
    focus: '중복, 죽은 코드, 과잉 설계, 불필요한 의존성, 더 단순한 동등 구현 존재 여부.',
  },
];

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'claim'],
        properties: {
          title: { type: 'string' },
          severity: { enum: ['critical', 'major', 'minor', 'info'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          claim: { type: 'string', description: '무엇이 왜 문제인가, 재현 조건 포함' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verification', 'reasoning'],
  properties: {
    verification: {
      enum: ['CONFIRMED', 'DISPUTED', 'UNVERIFIED'],
      description: 'Codex가 재현/동의하면 CONFIRMED, 반박하면 DISPUTED, 실행 불가·불확실하면 UNVERIFIED',
    },
    evidence: { type: 'string', description: 'Codex가 제시한 재현 명령·근거 (CONFIRMED면 필수)' },
    reasoning: { type: 'string' },
  },
};

function lensPrompt(lens) {
  return `당신은 적대적 코드 리뷰어다. 렌즈: ${lens.ko} (${lens.key}).
대상: ${TARGET}.
git diff를 직접 확인하고(예: \`git diff\` 또는 \`git diff <base>...HEAD\`), 이 렌즈의 관점에서만 결함을 찾아라.
집중: ${lens.focus}
각 결함은 파일:줄과 "재현/실패 시나리오"를 갖춰 반증 가능해야 한다. 확신 없으면 minor로 낮춰라.
칭찬·요약 금지. 결함이 없으면 빈 배열을 반환하라. 결함만 구조화해 반환한다.`;
}

function codexVerifyPrompt(f) {
  // 에이전트가 Bash로 Codex CLI를 호출해 독립 검증하게 한다. Codex는 다른 회사 모델이라 상관오류가 낮다.
  const claim = `[${f.severity}] ${f.title} (${f.file || '?'}:${f.line || '?'}) — ${f.claim}`;
  const codexInner =
    `다음 코드리뷰 발견이 진짜인지 적대적으로 검증하라. 반박을 시도하고, 재현 가능하면 재현 명령을 제시하라. ` +
    `진짜면 'CONFIRMED: <근거>', 틀렸으면 'DISPUTED: <이유>'로 시작하는 한 줄로 답하라. 발견: ${claim}`;
  return `당신은 Bash를 쓸 수 있는 검증 조율자다. 아래 명령을 그대로 실행해 다른 회사 모델(Codex)의 독립 판정을 받아라:

codex exec ${JSON.stringify(codexInner)} -m ${MODEL} -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached < /dev/null

규칙:
- Codex 출력이 'CONFIRMED'로 시작하면 verification=CONFIRMED, evidence에 Codex가 준 근거를 담아라.
- 'DISPUTED'로 시작하면 verification=DISPUTED.
- codex 명령이 실패하거나(비인증·타임아웃) 판정이 불명확하면 verification=UNVERIFIED (절대 CONFIRMED로 올리지 마라).
- 네 자신의 의견으로 CONFIRMED를 만들지 마라 — 오직 Codex의 판정만 반영한다. 이게 이 워크플로우의 핵심이다.`;
}

// ── 실행 ──
phase('Review');
const reviews = await parallel(
  LENSES.map((l) => () =>
    agent(lensPrompt(l), { label: `lens:${l.key}`, phase: 'Review', schema: FINDINGS_SCHEMA })
  )
);

// 발견 취합 + 파일:줄:제목 기준 중복 제거 (여러 렌즈가 같은 결함을 잡을 수 있음)
const seen = new Set();
const findings = [];
let idx = 0;
for (const r of reviews.filter(Boolean)) {
  for (const f of r.findings || []) {
    const key = `${f.file || ''}:${f.line || ''}:${(f.title || '').slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...f, id: `RR-${String(++idx).padStart(3, '0')}` });
  }
}
log(`3렌즈 리뷰 완료 — 중복 제거 후 발견 ${findings.length}건`);

if (findings.length === 0) {
  return {
    contract: 'workflow-result/v1',
    workflow: 'red-review',
    status: 'ok',
    findings: [],
    notes: ['3렌즈 리뷰에서 결함 없음'],
    usage: { agents: LENSES.length, crossModelCalls: 0 },
  };
}

// Codex 교차 검증 — 발견별 독립 병렬
phase('Cross-verify');
const verified = await pipeline(findings, (f) =>
  agent(codexVerifyPrompt(f), {
    label: `codex:${f.id}`,
    phase: 'Cross-verify',
    schema: VERDICT_SCHEMA,
  }).then((v) => ({ ...f, verdict: v }))
);

phase('Assemble');
const clean = verified.filter(Boolean);
// 계약 강제: CONFIRMED인데 evidence가 비면 검증이 성립하지 않으므로 UNVERIFIED로 낮춘다.
// (workflow-result 스키마가 CONFIRMED에 evidence+verifiedBy를 요구 — 출력이 항상 계약을 통과하도록)
for (const f of clean) {
  const v = f.verdict || {};
  if (v.verification === 'CONFIRMED' && !(v.evidence && String(v.evidence).trim())) {
    v.verification = 'UNVERIFIED';
    v.reasoning = `(evidence 없어 UNVERIFIED로 강등) ${v.reasoning || ''}`;
  }
}
const confirmed = clean.filter((f) => f.verdict && f.verdict.verification === 'CONFIRMED');
log(
  `교차 검증 완료 — CONFIRMED ${confirmed.length} / DISPUTED ${
    clean.filter((f) => f.verdict && f.verdict.verification === 'DISPUTED').length
  } / UNVERIFIED ${clean.filter((f) => !f.verdict || f.verdict.verification === 'UNVERIFIED').length}`
);

return {
  contract: 'workflow-result/v1',
  workflow: 'red-review',
  target: { scope: 'diff' },
  status: 'ok',
  findings: clean.map((f) => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    file: f.file,
    line: f.line,
    claim: f.claim,
    evidence: f.verdict && f.verdict.evidence,
    verification: (f.verdict && f.verdict.verification) || 'UNVERIFIED',
    verifiedBy: f.verdict && f.verdict.verification === 'CONFIRMED' ? ['claude-lens', 'codex'] : ['claude-lens'],
    action: f.verdict && f.verdict.verification === 'CONFIRMED' ? 'fix' : 'defer',
  })),
  notes: [
    'CONFIRMED만 수정 대상 — DISPUTED/UNVERIFIED는 기록만.',
    '검증은 다른 회사 모델(Codex)이 수행 (동일 모델 다수결 회피).',
  ],
  usage: { agents: LENSES.length + findings.length, crossModelCalls: findings.length },
};
