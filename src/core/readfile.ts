// ファイル読み取りの歯止め（2026-11-20 のセキュリティ監査 F3 / F4 対応）。
// 記録ファイルや参照先ファイルは、他者が書いたもの・細工されたものが
// 混ざりうる。全文読みの前に「通常ファイルであること」と「サイズ上限」を
// 確認し、巨大ファイルや特殊ファイル（FIFO・デバイス等）で拡張ホストが
// 止まったりメモリを枯渇させたりしないようにする。
//
// 確認と読み取りは、パスではなく開いたファイル記述子（fd）に対して行う。
// パスで確認した後に別プロセスが同じパスを差し替えても、サイズ上限と
// 通常ファイルの確認を迂回できないようにするため（監査フォローアップ）。
// また、開くときに O_NONBLOCK を付ける（対応 OS のみ）。FIFO へ差し替え
// られても、読み取り open が書き手を待ち続けて拡張ホストを止めないため
// （通常ファイルの読み取りには影響しない）。
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";

/** 記録ファイル（セッション記録・注釈ファイル）の読み込み上限（バイト）。
 *  正規の記録でも数 MB〜数十 MB になりうるため余裕を持たせた値 */
export const MAX_RECORD_BYTES = 256 * 1024 * 1024;

/** グラフ構築で読む参照ファイルの上限（バイト）。スキルの文書としては十分な大きさ */
export const MAX_GRAPH_FILE_BYTES = 16 * 1024 * 1024;

/** 見出し取得で読む先頭の量（バイト）。先頭見出しはファイルの先頭付近にある前提 */
export const HEADING_PREFIX_BYTES = 64 * 1024;

const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** 通常ファイルであり、サイズが上限以下であることの確認。確認できない場合は false */
export function isFileWithinLimit(path: string, maxBytes: number): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size <= maxBytes;
  } catch { return false; }
}

/**
 * 上限を確認してからテキストを読む。読めない・通常ファイルでない・
 * 上限超過の場合は null。確認と読み取りは同じ fd に対して行い、
 * 読み取る量自体も上限以下に制限する（確認後にファイルが差し替わったり
 * 増大したりしても、全文をメモリに確保しない）。
 */
export function readTextFileWithinLimit(path: string, maxBytes: number): string | null {
  let fd: number;
  try { fd = openSync(path, READ_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(1024 * 1024, maxBytes + 1 - total);
      const buf = Buffer.alloc(want);
      const n = readSync(fd, buf, 0, want, null);
      if (n <= 0) break;
      total += n;
      if (total > maxBytes) return null;
      chunks.push(buf.subarray(0, n));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch { return null; } finally { closeSync(fd); }
}

/** ファイルの先頭だけを読む（見出し取得用）。読めない・通常ファイルでない場合は null */
export function readFilePrefix(path: string, maxBytes: number): string | null {
  let fd: number;
  try { fd = openSync(path, READ_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, maxBytes);
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.toString("utf8", 0, off);
  } catch { return null; } finally { closeSync(fd); }
}
