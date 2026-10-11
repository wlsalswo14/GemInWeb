#!/usr/bin/env node
// Writes gem/GEM_INSTRUCTIONS.md: the static GemInWeb primer for a Gemini Gem or AI Studio system instructions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticPrimer } from '../core/primer.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'gem', 'GEM_INSTRUCTIONS.md');
const primer = staticPrimer();
const fence = '`'.repeat(Math.max(4, ...[...primer.matchAll(/`+/g)].map((m) => m[0].length + 1)));

const text = `# GemInWeb 지침 (Gem / AI Studio 시스템 지침용)

이 파일은 \`npm run gen:gem\`(scripts/gen-gem.mjs)이 자동으로 만듭니다. 직접 고치지 마세요.

## 사용 방법

- **Gemini 웹**: gemini.google.com → 왼쪽 메뉴 **Gem 관리자** → **Gem 만들기** → **지침** 칸에 아래 블록 안의 내용을 전부 붙여넣고 저장합니다. 이후 그 Gem으로 새 채팅을 열면 됩니다.
- **Google AI Studio**: aistudio.google.com → 새 채팅 → **System instructions** 칸에 아래 블록 안의 내용을 전부 붙여넣습니다. (확장 패널의 "시스템 지침에 넣기" 버튼으로도 넣을 수 있습니다.)
- 지침에 프로토콜을 넣어 두면, 확장 프로그램은 채팅 시작 때 짧은 \`[DevSpace context]\` 블록(시간, OS, 작업 폴더)만 보냅니다 (설정의 primerMode = \`context\`).
- 첫 줄 \`[GemInWeb protocol v1]\` 부터 마지막 줄까지 빠짐없이 복사하세요. 블록을 감싼 백틱 펜스 줄(맨 위·맨 아래)은 복사하지 않습니다.

## 붙여넣을 내용 (${primer.length}자)

${fence}text
${primer}
${fence}
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text, 'utf8');
console.log(`Wrote ${out} (${primer.length} chars of primer)`);
