#!/usr/bin/env node
// assets-manifest.json 재생성 — 소스 자산(skills/agents/hooks/contracts/CLAUDE.md)의 해시 스냅숏.
// 자산을 고치면 이 스크립트를 돌리고 함께 커밋한다 (smoke 테스트가 정합을 강제한다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, MANIFEST_FILE } from './manifest-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = buildManifest(REPO);
fs.writeFileSync(path.join(REPO, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[manifest] ${MANIFEST_FILE} 재생성 — 자산 ${Object.keys(manifest.assets).length}개`);
