// ファイル読み取りの歯止め（2026-11-20 のセキュリティ監査 F3 / F4 対応）。
// 記録ファイルや参照先ファイルは、他者が書いたもの・細工されたものが
// 混ざりうる。全文読みの前に「通常ファイルであること」と「サイズ上限」を
// 確認し、巨大ファイルや特殊ファイル（FIFO・デバイス等）で拡張ホストが
// 止まったりメモリを枯渇させたりしないようにする。
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

/** 記録ファイル（セッション記録・注釈ファイル）の読み込み上限（バイト）。
 *  正規の記録でも数 MB〜数十 MB になりうるため余裕を持たせた値 */
export const MAX_RECORD_BYTES = 256 * 1024 * 1024;

/** グラフ構築で読む参照ファイルの上限（バイト）。スキルの文書としては十分な大きさ */
export const MAX_GRAPH_FILE_BYTES = 16 * 1024 * 1024;

/** 見出し取得で読む先頭の量（バイト）。先頭見出しはファイルの先頭付近にある前提 */
export const HEADING_PREFIX_BYTES = 64 * 1024;

/** 通常ファイルであり、サイズが上限以下であることの確認。確認できない場合は false */
export function isFileWithinLimit(path: string, maxBytes: number): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size <= maxBytes;
  } catch { return false; }
}

/**
 * 上限を確認してからテキストを読む。読めない・通常ファイルでない・
 * 上限超過の場合は null。確認後にファイルが差し替わった場合に備え、
 * 読み取った実サイズでも再確認する。
 */
export function readTextFileWithinLimit(path: string, maxBytes: number): string | null {
  if (!isFileWithinLimit(path, maxBytes)) return null;
  try {
    const buf = readFileSync(path);
    if (buf.length > maxBytes) return null;
    return buf.toString("utf8");
  } catch { return null; }
}

/** ファイルの先頭だけを読む（見出し取得用）。読めない・通常ファイルでない場合は null */
export function readFilePrefix(path: string, maxBytes: number): string | null {
  let fd: number;
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    size = st.size;
    fd = openSync(path, "r");
  } catch { return null; }
  try {
    const len = Math.min(size, maxBytes);
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
