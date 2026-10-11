// Minimal line diff + unified diff formatting (no dependencies).

export function splitLines(text) {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Return ops [{ t: ' ' | '-' | '+', line }] transforming a → b. */
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', line: a[i] });
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000 || n === 0 || m === 0) {
    for (const line of midA) ops.push({ t: '-', line });
    for (const line of midB) ops.push({ t: '+', line });
  } else {
    // LCS table (lengths of suffixes)
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: ' ', line: midA[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        ops.push({ t: '-', line: midA[i++] });
      } else {
        ops.push({ t: '+', line: midB[j++] });
      }
    }
    while (i < n) ops.push({ t: '-', line: midA[i++] });
    while (j < m) ops.push({ t: '+', line: midB[j++] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: ' ', line: a[i] });
  return ops;
}

/**
 * Unified diff of two texts. Returns { text, additions, removals }.
 * `text` is '' when identical. `oldName`/`newName` default to a/file, b/file.
 */
export function unifiedDiff(oldText, newText, { oldName = 'a/file', newName = 'b/file', context = 3 } = {}) {
  const a = splitLines(oldText ?? '');
  const b = splitLines(newText ?? '');
  const ops = diffLines(a, b);
  let additions = 0;
  let removals = 0;
  for (const op of ops) {
    if (op.t === '+') additions++;
    else if (op.t === '-') removals++;
  }
  if (additions === 0 && removals === 0) return { text: '', additions, removals };

  // annotate positions
  let ai = 0;
  let bi = 0;
  const rows = ops.map((op) => {
    const row = { ...op, a: ai, b: bi };
    if (op.t !== '+') ai++;
    if (op.t !== '-') bi++;
    return row;
  });
  const changeIdx = [];
  rows.forEach((r, i) => {
    if (r.t !== ' ') changeIdx.push(i);
  });
  const hunks = [];
  let cur = null;
  for (const idx of changeIdx) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(rows.length - 1, idx + context);
    if (cur && lo <= cur.hi + 1) cur.hi = hi;
    else {
      cur = { lo, hi };
      hunks.push(cur);
    }
  }
  const out = [`--- ${oldName}`, `+++ ${newName}`];
  for (const h of hunks) {
    const slice = rows.slice(h.lo, h.hi + 1);
    const aCount = slice.filter((r) => r.t !== '+').length;
    const bCount = slice.filter((r) => r.t !== '-').length;
    const aStart = aCount ? slice.find((r) => r.t !== '+').a + 1 : slice[0].a;
    const bStart = bCount ? slice.find((r) => r.t !== '-').b + 1 : slice[0].b;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const r of slice) out.push(`${r.t}${r.line}`);
  }
  return { text: out.join('\n'), additions, removals };
}

/** Limit a diff to `maxLines` lines with a marker. */
export function capLines(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n[… ${lines.length - maxLines} more diff lines not shown …]`;
}
