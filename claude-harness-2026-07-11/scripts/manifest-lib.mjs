// 자산 manifest 공용 로직 — install.mjs / 테스트가 공유한다.
// manifest는 저장소에 커밋하지 않는다: 소스의 이력은 git이 정본이고,
// 설치 시점 스냅숏은 배포본(~/.claude/assets-manifest.json)에만 저장해
// "소스에서 삭제됐지만 배포본에 잔존하는 자산" 검출에 쓴다 (red-review 발견).
// 해시는 개행 정규화(CRLF→LF) 후 계산: git·OS 개행 차이를 드리프트로 오인하지 않기 위함.
// (.gitattributes의 `* -text`와 이중이지만 목적이 다르다 — 저쪽은 checkout 보호, 이쪽은 git 밖 배포본 비교 보호)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANIFEST_FILE = 'assets-manifest.json';
export const ASSET_DIRS = ['skills', 'agents', 'hooks', 'contracts'];
export const ASSET_FILES = ['CLAUDE.md'];

const BEGIN = '<!-- G-HARNESS BEGIN -->';
const END = '<!-- G-HARNESS END -->';

export function sha256Normalized(buf) {
  const text = buf.toString('utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// 일반 파일만 순회한다. 심볼릭 링크·정션은 isFile()=false라 자동 제외
// (이전 구현은 readFileSync EISDIR 크래시 — red-review 발견).
export function* walk(dir, ignore = new Set(['.git', 'node_modules'])) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignore.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, ignore);
    else if (e.isFile()) yield p;
  }
}

export function collectAssets(repo) {
  const map = {};
  for (const dir of ASSET_DIRS) {
    const base = path.join(repo, dir);
    if (!fs.existsSync(base)) continue;
    for (const f of walk(base)) {
      const rel = path.relative(repo, f).split(path.sep).join('/');
      map[rel] = sha256Normalized(fs.readFileSync(f));
    }
  }
  for (const f of ASSET_FILES) {
    map[f] = sha256Normalized(fs.readFileSync(path.join(repo, f)));
  }
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function buildManifest(repo) {
  return { contract: 'assets-manifest/v1', assets: collectAssets(repo) };
}

// 배포본(~/.claude)이 manifest와 일치하는지 검사한다. 문제 목록을 반환 (빈 배열 = 일치).
// CLAUDE.md는 통짜 복사가 아니라 마커 블록 병합이므로 블록 내용을 소스와 직접 비교한다.
export function verifyDeployed(claudeDir, repo, manifest) {
  const problems = [];
  for (const [rel, hash] of Object.entries(manifest.assets)) {
    if (rel === 'CLAUDE.md') {
      const cm = path.join(claudeDir, 'CLAUDE.md');
      if (!fs.existsSync(cm)) {
        problems.push('CLAUDE.md: 배포본이 없음');
        continue;
      }
      const doc = fs.readFileSync(cm, 'utf8').replace(/\r\n/g, '\n');
      const i = doc.indexOf(BEGIN);
      const j = doc.indexOf(END);
      if (i < 0 || j < 0) {
        problems.push('CLAUDE.md: G-HARNESS 마커 블록이 없음 (재설치 필요)');
        continue;
      }
      const block = doc.slice(i + BEGIN.length, j).trim();
      const src = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8').replace(/\r\n/g, '\n').trim();
      if (block !== src) problems.push('CLAUDE.md: 헌법 블록이 소스와 다름 (재설치 필요)');
      continue;
    }
    const dep = path.join(claudeDir, ...rel.split('/'));
    if (!fs.existsSync(dep)) {
      problems.push(`${rel}: 배포본에 없음`);
      continue;
    }
    if (sha256Normalized(fs.readFileSync(dep)) !== hash) {
      problems.push(`${rel}: 소스와 다름 (드리프트 — 로컬 수정은 다음 설치 때 사라진다)`);
    }
  }
  return problems;
}

// 잔존 자산 검출: 마지막 설치 스냅숏(배포본의 manifest)에는 있는데 현 소스에는 없는 파일.
// 소스에서 삭제한 훅·스킬이 배포본에서 계속 실행되는 단방향 구멍을 막는다 (red-review 발견).
export function findStaleDeployed(claudeDir, freshManifest) {
  const prevPath = path.join(claudeDir, MANIFEST_FILE);
  if (!fs.existsSync(prevPath)) return []; // 첫 설치 — 이전 스냅숏 없음
  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
  } catch {
    return [`${MANIFEST_FILE}: 배포본 스냅숏이 손상됨 (재설치로 갱신)`];
  }
  const stale = [];
  for (const rel of Object.keys(prev.assets ?? {})) {
    if (rel === 'CLAUDE.md') continue; // 병합 파일 — 삭제 대상 아님
    if (!(rel in freshManifest.assets) && fs.existsSync(path.join(claudeDir, ...rel.split('/')))) {
      stale.push(rel);
    }
  }
  return stale;
}
