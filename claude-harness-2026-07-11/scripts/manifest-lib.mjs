// 자산 manifest 공용 로직 — install.mjs / build-manifest.mjs / smoke 테스트가 공유한다.
// 해시는 개행 정규화(CRLF→LF) 후 계산: git·OS 개행 차이를 드리프트로 오인하지 않기 위함.
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

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
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
