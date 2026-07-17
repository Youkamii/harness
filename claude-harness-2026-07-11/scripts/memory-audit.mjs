#!/usr/bin/env node
// memory-audit — 자동 메모리(~/.claude/projects/<slug>/memory) 정합성 결정론 감사.
// 에이전트 없음 — 순수 Node라 사용량(토큰)을 쓰지 않고, 약한 모델에서도 값이 유지된다.
// 결정론 검사(링크·인덱스·중복·frontmatter)는 실패/합격을 확정한다. 의미적 노후성은 "후보"로만 표시하고
// 절대 자동 수정하지 않는다 — 판단은 사람 몫 (마스터플랜 A4 확정 형태).
//
// 실행:
//   node scripts/memory-audit.mjs                     # ~/.claude/projects/*/memory 전부 순회 (#14)
//   node scripts/memory-audit.mjs <memory_dir>        # 단일 디렉터리만
//   node scripts/memory-audit.mjs --projects <root>   # 순회 루트 오버라이드 (테스트용)
// 종료코드: 결정론 오류가 있으면 1, 없으면 0 (후보 경고는 0을 바꾸지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STALE_DAYS = 120; // 이보다 오래 손 안 댄 project/reference 메모리는 노후 후보

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const fm = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const top = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      key = top[1];
      fm[key] = top[2] ? top[2].replace(/^["']|["']$/g, '') : {};
    } else {
      const sub = /^\s+(\w[\w-]*):\s*(.*)$/.exec(line);
      if (sub && key && typeof fm[key] === 'object') fm[key][sub[1]] = sub[2].replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

// 단일 memory 디렉터리 감사 — {count, errors, candidates} 반환 (출력·종료는 호출측)
function auditDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const errors = [];
  const candidates = [];

  // 1. frontmatter 파싱 + name 수집
  const byName = new Map(); // name -> file
  const records = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const text = fs.readFileSync(full, 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) {
      errors.push(`${file}: frontmatter(--- 블록) 없음`);
      continue;
    }
    if (!fm.name) errors.push(`${file}: frontmatter에 name 없음`);
    if (!fm.description) errors.push(`${file}: frontmatter에 description 없음`);
    const type = fm.metadata && fm.metadata.type;
    if (!type) errors.push(`${file}: metadata.type 없음`);
    else if (!['user', 'feedback', 'project', 'reference'].includes(type))
      errors.push(`${file}: metadata.type "${type}" 비표준 (user|feedback|project|reference)`);
    if (fm.name) {
      if (byName.has(fm.name)) errors.push(`name 중복 "${fm.name}": ${byName.get(fm.name)} ↔ ${file}`);
      else byName.set(fm.name, file);
    }
    records.push({ file, fm, text, type, mtime: fs.statSync(full).mtimeMs });
  }

  // 2. [[link]] 해소 — 존재하지 않는 name을 가리키면 오류.
  //    언더스코어 포함 — 실제 메모리 name들이 snake_case를 쓴다 (kebab만 보면 검사 사각지대, #14)
  for (const rec of records) {
    const links = [...rec.text.matchAll(/\[\[([a-z0-9_-]+)\]\]/g)].map((m) => m[1]);
    for (const link of links) {
      if (!byName.has(link)) errors.push(`${rec.file}: 죽은 링크 [[${link}]] — 그 name의 메모리가 없음`);
    }
  }

  // 3. MEMORY.md 인덱스 동기화 — 파일마다 인덱스 줄 1개, 인덱스에만 있는 고아 줄 금지
  const indexPath = path.join(dir, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) {
    errors.push('MEMORY.md 인덱스 파일 없음');
  } else {
    const index = fs.readFileSync(indexPath, 'utf8');
    const linked = new Set([...index.matchAll(/\]\(([\w.-]+\.md)\)/g)].map((m) => m[1]));
    for (const file of files) {
      if (!linked.has(file)) errors.push(`MEMORY.md: ${file} 인덱스 줄 없음 (추가 필요)`);
    }
    for (const ref of linked) {
      if (!files.includes(ref)) errors.push(`MEMORY.md: 고아 인덱스 줄 → ${ref} (파일 없음)`);
    }
  }

  // 4. 의미적 노후성 후보 (자동 수정 금지 — 표시만)
  const now = Math.max(...records.map((r) => r.mtime), 0);
  for (const rec of records) {
    if ((rec.type === 'project' || rec.type === 'reference')) {
      const ageDays = (now - rec.mtime) / 86400000;
      if (ageDays > STALE_DAYS) candidates.push(`${rec.file}: ${Math.round(ageDays)}일 미수정 (${rec.type}) — 최신인지 확인 권장`);
    }
    // 절대 경로가 본문에 박힌 project 메모리는 경로 변동에 취약 — 확인 후보
    if (/[A-Z]:\\Users\\\w+/.test(rec.text) && rec.type === 'project')
      candidates.push(`${rec.file}: 절대경로 하드코딩 — 경로 변동 시 노후 위험`);
  }

  return { count: files.length, errors, candidates };
}

function report({ errors, candidates }, indent = '') {
  if (errors.length) {
    console.log(`${indent}결정론 오류 ${errors.length}건 (수정 필요):`);
    for (const e of errors) console.log(`${indent}  ✗ ${e}`);
  } else {
    console.log(`${indent}결정론 검사: 오류 0 — 링크·인덱스·중복·frontmatter 모두 정합`);
  }
  if (candidates.length) {
    console.log(`${indent}노후성 후보 ${candidates.length}건 (판단은 사람 몫, 자동 수정 안 함):`);
    for (const c of candidates) console.log(`${indent}  ? ${c}`);
  }
}

function main() {
  const argv = process.argv.slice(2);

  // 단일 디렉터리 모드 (기존 계약 유지)
  const single = argv.find((a) => !a.startsWith('--'));
  const projIdx = argv.indexOf('--projects');
  if (single && projIdx < 0) {
    if (!fs.existsSync(single)) {
      console.error(`[memory-audit] 디렉터리 없음: ${single}`);
      process.exit(1);
    }
    const r = auditDir(single);
    console.log(`[memory-audit] 대상 ${r.count}개 메모리 @ ${single}\n`);
    report(r);
    process.exit(r.errors.length ? 1 : 0);
  }

  // 전 프로젝트 순회 모드 (#14): projects/*/memory 전부
  const root =
    projIdx >= 0 ? argv[projIdx + 1] : path.join(os.homedir(), '.claude', 'projects');
  if (!root || !fs.existsSync(root)) {
    console.error(`[memory-audit] projects 루트 없음: ${root}`);
    process.exit(1);
  }
  const targets = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ slug: e.name, dir: path.join(root, e.name, 'memory') }))
    .filter((t) => fs.existsSync(t.dir));

  console.log(`[memory-audit] 프로젝트 순회 @ ${root} — memory 있는 프로젝트 ${targets.length}개\n`);
  let totalErrors = 0;
  let totalCandidates = 0;
  for (const t of targets) {
    const r = auditDir(t.dir);
    console.log(`── ${t.slug} (${r.count}개)`);
    report(r, '  ');
    totalErrors += r.errors.length;
    totalCandidates += r.candidates.length;
  }
  console.log(
    `\n총괄: 프로젝트 ${targets.length}개 — 결정론 오류 ${totalErrors}건, 노후 후보 ${totalCandidates}건`
  );
  process.exit(totalErrors ? 1 : 0);
}

main();
