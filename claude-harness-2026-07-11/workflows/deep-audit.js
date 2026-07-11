// deep-audit — 저장소 전수 감사 워크플로우 (마스터플랜 A2).
// 기본은 diff·고위험 경로만 감사한다. 전수 스캔은 args.mode="full"일 때만 (비용 폭증·컨텍스트 손실 방지).
// 파일 발견은 에이전트가 Bash로 수행하고(워크플로우는 fs 접근 불가), 영역별 병렬 감사 후
// 고위험 발견만 크로스벤더(Codex) 검증한다. 반환은 workflow-result/v1 계약.
//
// 실행: Workflow 도구. args 예:
//   { target: "src/**", mode: "diff", model: "gpt-5.6-sol" }   // 기본
//   { target: "전체 저장소", mode: "full" }                     // 명시적 전수
export const meta = {
  name: 'deep-audit',
  description: '저장소 감사 — 기본 diff·고위험 경로, full 모드는 명시적. 고위험 발견만 Codex 교차 검증',
  phases: [
    { title: 'Discover', detail: '감사 대상 영역 수집' },
    { title: 'Audit', detail: '영역별 병렬 감사' },
    { title: 'Cross-verify', detail: '고위험 발견 Codex 검증' },
    { title: 'Assemble', detail: 'workflow-result 조립' },
  ],
};

const TARGET = (args && args.target) || '현재 저장소';
const MODE = (args && args.mode) === 'full' ? 'full' : 'diff';
const MODEL = (args && args.model) || 'gpt-5.6-sol';
const MAX_AREAS = MODE === 'full' ? 24 : 8; // full도 상한을 둬 폭주 방지

const AREAS_SCHEMA = {
  type: 'object',
  required: ['areas'],
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'why'],
        properties: {
          path: { type: 'string', description: '감사할 파일 또는 디렉터리' },
          why: { type: 'string', description: '왜 고위험인가 (인증·결제·외부입력·상태변이 등)' },
        },
      },
    },
  },
};

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
          claim: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verification', 'reasoning'],
  properties: {
    verification: { enum: ['CONFIRMED', 'DISPUTED', 'UNVERIFIED'] },
    evidence: { type: 'string' },
    reasoning: { type: 'string' },
  },
};

// ① 발견: 에이전트가 대상에서 고위험 영역을 추린다
phase('Discover');
const discoverPrompt =
  MODE === 'diff'
    ? `당신은 Bash를 쓸 수 있는 정찰병이다. 대상: ${TARGET}. \`git diff --name-only\`(+ 고위험 경로: 인증·결제·외부입력·파일시스템·네트워크)로 감사할 영역을 최대 ${MAX_AREAS}개 추려라. 변경분과 고위험 경로 우선. 각 영역에 왜 고위험인지 한 줄. 영역만 구조화 반환.`
    : `당신은 Bash를 쓸 수 있는 정찰병이다. 대상: ${TARGET} 전수(full). \`git ls-files\`로 훑되, 감사 가치가 높은 영역을 최대 ${MAX_AREAS}개로 묶어라(파일 하나하나가 아니라 응집된 모듈 단위). 각 영역에 감사 이유 한 줄. 영역만 구조화 반환.`;
const disc = await agent(discoverPrompt, { label: 'discover', phase: 'Discover', schema: AREAS_SCHEMA });
const areas = ((disc && disc.areas) || []).slice(0, MAX_AREAS);
log(`감사 영역 ${areas.length}개 (mode=${MODE})`);

if (areas.length === 0) {
  return {
    contract: 'workflow-result/v1',
    workflow: 'deep-audit',
    target: { scope: MODE },
    status: 'ok',
    findings: [],
    notes: [`감사 대상 영역 없음 (mode=${MODE})`],
    usage: { agents: 1, crossModelCalls: 0 },
  };
}

// ② 감사: 영역별 병렬 (정합성+보안 통합 렌즈). pipeline이 아니라 parallel — 이후 dedup에 전량 필요
phase('Audit');
const audits = await parallel(
  areas.map((a) => () =>
    agent(
      `당신은 적대적 코드 리뷰어다. 영역: ${a.path} (고위험 사유: ${a.why}).\n` +
        `이 영역만 읽고(cat/git show) 정합성·보안 결함을 찾아라. 각 결함은 파일:줄 + 재현/실패 시나리오. 확신 없으면 minor. 결함만 반환.`,
      { label: `audit:${a.path}`, phase: 'Audit', schema: FINDINGS_SCHEMA }
    )
  )
);

// dedup
const seen = new Set();
const findings = [];
let idx = 0;
for (const r of audits.filter(Boolean)) {
  for (const f of r.findings || []) {
    const key = `${f.file || ''}:${f.line || ''}:${(f.title || '').slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ ...f, id: `DA-${String(++idx).padStart(3, '0')}` });
  }
}
log(`감사 완료 — 중복 제거 후 ${findings.length}건`);

// ③ 크로스벤더 검증 — 고위험(critical/major)만 (비용 절약). minor/info는 검증 없이 UNVERIFIED 기록.
phase('Cross-verify');
const highRisk = findings.filter((f) => f.severity === 'critical' || f.severity === 'major');
const verifiedHigh = await pipeline(highRisk, (f) =>
  agent(
    `당신은 Bash를 쓸 수 있는 검증 조율자다. 아래 명령으로 다른 회사 모델(Codex)의 독립 판정을 받아라:\n\n` +
      `codex exec ${JSON.stringify(
        `이 감사 발견이 진짜인지 적대적으로 검증하고 재현을 시도하라. 진짜면 'CONFIRMED: <근거>', 아니면 'DISPUTED: <이유>'로 시작하는 한 줄로: [${f.severity}] ${f.title} (${f.file || '?'}:${f.line || '?'}) — ${f.claim}`
      )} -m ${MODEL} -s read-only -c 'model_reasoning_effort="high"' --enable web_search_cached < /dev/null\n\n` +
      `Codex가 CONFIRMED로 시작하면 verification=CONFIRMED(evidence에 근거), DISPUTED면 DISPUTED, 실패·불명확이면 UNVERIFIED. 네 의견으로 CONFIRMED 만들지 마라 — Codex 판정만 반영.`,
    { label: `codex:${f.id}`, phase: 'Cross-verify', schema: VERDICT_SCHEMA }
  ).then((v) => ({ ...f, verdict: v }))
);
const verdictById = new Map(verifiedHigh.filter(Boolean).map((f) => [f.id, f.verdict]));

phase('Assemble');
function assemble(f) {
  const v = verdictById.get(f.id);
  const confirmed = v && v.verification === 'CONFIRMED' && v.evidence && String(v.evidence).trim();
  return {
    id: f.id,
    title: f.title,
    severity: f.severity,
    file: f.file,
    line: f.line,
    claim: f.claim,
    evidence: confirmed ? v.evidence : undefined,
    verification: confirmed ? 'CONFIRMED' : v ? (v.verification === 'DISPUTED' ? 'DISPUTED' : 'UNVERIFIED') : 'UNVERIFIED',
    verifiedBy: confirmed ? ['claude-lens', 'codex'] : ['claude-lens'],
    action: confirmed ? 'fix' : 'defer',
  };
}
const out = findings.map(assemble);
log(`CONFIRMED ${out.filter((f) => f.verification === 'CONFIRMED').length} / 전체 ${out.length}`);

return {
  contract: 'workflow-result/v1',
  workflow: 'deep-audit',
  target: { scope: MODE },
  status: 'ok',
  findings: out,
  notes: [
    `mode=${MODE}, 감사 영역 ${areas.length}개, 상한 ${MAX_AREAS}`,
    '고위험(critical/major)만 Codex 교차 검증 — minor/info는 UNVERIFIED로 기록만.',
    MODE === 'diff' ? 'diff·고위험 경로만 감사함 (전수는 mode=full)' : '전수(full) 모드 — 영역 상한 적용',
  ],
  usage: { agents: 1 + areas.length + highRisk.length, crossModelCalls: highRisk.length },
};
