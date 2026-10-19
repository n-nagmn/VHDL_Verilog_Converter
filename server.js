const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const fs = require('fs');
const path = require('path');

const app = express();
// M9: CORSは同オリジンのみ許可（任意オリジンのリフレクトをやめる）
app.use(cors({ origin: false }));
// H2: JSONボディ上限を100mbから20mbに引き下げ
app.use(express.json({ limit: '20mb' }));

// H1: ファイル名/エンティティ名のサニタイズ（パス TRAVERSAL・シェルインジェクション対策）
const safeName = (n) => path.basename(String(n || '').replace(/[\\\/]/g, '_')).replace(/[^\w.\-]/g, '_');

// M4: 全execFile呼び出し共通のタイムアウト・バッファ設定
const EXEC_OPTS = { timeout: 30000, maxBuffer: 50 * 1024 * 1024 };

// H2: 全体リクエスト期限（120秒）
const REQUEST_DEADLINE_MS = 120000;

// H2: 同時に処理中のリクエスト数上限
const MAX_IN_FLIGHT = 5;
let inFlightCount = 0;

// M6: ファイルごとの最大サイズ（1MB）
const MAX_FILE_SIZE = 1024 * 1024;

// M7: Windowsの予約ファイル名（con, prn, aux, nul, com1-9, lpt1-9）
const WINDOWS_RESERVED_NAMES = /^([A-Z0-9])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

// M2: data.error は文字列であることを保証する
const safeError = (e) => {
    const data = (e && e.data) || {};
    const raw = typeof data.error === 'string' ? data.error : (e && typeof e.message === 'string' ? e.message : 'Unknown error');
    return raw;
};

// M1: `--`コメントを除去した上で、文の先頭にアンカーしてエンティティを抽出
// （`entity foo is new bar` 等の偽検出を防止）
const extractEntities = (content) => {
    const noComments = String(content || '').split('\n')
        .map(l => {
            const i = l.indexOf('--');
            return i === -1 ? l : l.slice(0, i);
        })
        .join('\n');
    return [...noComments.matchAll(/^\s*entity\s+([A-Za-z_]\w*)\s+is\b/gim)].map(m => m[1]);
};

/**
 * 出力ファイル名の重複回避 (M2)
 */
function uniqueName(baseName, usedNames) {
    let name = baseName;
    let counter = 1;
    while (usedNames.has(name)) {
        name = baseName.replace(/(\.[^.]+)$/, `_${++counter}$1`);
    }
    usedNames.add(name);
    return name;
}

/**
 * 外部ツールを使用した整形処理 (オプション)
 * M6: execFile + argv + cwd（cd は使わない）
 * M4: 整形前にバックアップを取り、整形失敗時は整形前の内容を復元する
 */
async function formatCode(workDir, outPath, language, signal) {
    try {
        if (language === 'verilog') {
            // Veribleを使用して整形
            await execFilePromise('verible-verilog-format', ['--inplace', outPath],
                { ...EXEC_OPTS, cwd: workDir, signal });
        } else if (language === 'vhdl') {
            // VSGを使用して整形 (--fix オプションで自動修正)
            await execFilePromise('vsg', ['-f', outPath, '--fix'],
                { ...EXEC_OPTS, cwd: workDir, signal });
        }
    } catch (err) {
        // H1: クライアント切断（abort）時は復元・続行の必要がないため即座に返す
        if (err && (err.code === 'ABORT_ERR' || err.name === 'AbortError')) {
            throw err;
        }
        console.warn(`[Formatter Warning] ${language} の整形に失敗しました（ツールが未インストールかもしれません）:`, err.message);
        // M4: 整形失敗時は整形前の内容（バックアップ）を復元して続行
        try {
            const backupPath = outPath + '.preformat.bak';
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, outPath);
                fs.unlinkSync(backupPath);
            }
        } catch (restoreErr) {
            console.warn(`[Formatter Restore Warning] 整形前内容の復元失敗:`, restoreErr.message);
        }
    }
}

app.post('/api/convert', async (req, res) => {
    const uploadedFiles = req.body.files;
    const direction = req.body.direction;

    // L5: directionの検証
    if (direction !== 'vhdl2verilog' && direction !== 'verilog2vhdl') {
        return res.status(400).json({ success: false, error: "不正な変換方向です。" });
    }

    if (!uploadedFiles || !Array.isArray(uploadedFiles) || uploadedFiles.length === 0) {
        return res.status(400).json({ success: false, error: "ファイルがありません。" });
    }

    // H2: 同時実行数上限のチェック（超過時は 503 を返して弾く）
    if (inFlightCount >= MAX_IN_FLIGHT) {
        return res.status(503).json({ success: false, error: "処理中のリクエストが多すぎます。しばらくしてから再試行してください。" });
    }
    inFlightCount++;
    // このリクエスト用に AbortController を作成し、全 execFile 呼び出しに signal を渡す
    const controller = new AbortController();
    const { signal } = controller;
    const deadlineTimer = setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);

    let workDir = null;

    // 全体期限超過やクライアント切断（req 'close'）で中断する
    const onAbort = () => {
        if (!res.writableEnded && !res.headersSent) {
            res.status(504).json({ success: false, error: "変換がタイムアウトしました、または接続が切断されました。" });
        } else if (!res.writableEnded) {
            res.end();
        }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    // M6: 各ファイルの検証（typeof string + 最大1MB）
    const invalidFiles = [];
    for (const file of uploadedFiles) {
        if (!file || typeof file.content !== 'string') {
            invalidFiles.push(String((file && file.name) || 'unknown'));
        } else if (file.content.length > MAX_FILE_SIZE) {
            invalidFiles.push(String(file.name || 'unknown') + '（サイズ超過: 1MBを超える）');
        }
    }
    if (invalidFiles.length > 0) {
        inFlightCount--;
        clearTimeout(deadlineTimer);
        return res.status(400).json({ success: false, error: `無効なファイル内容です: ${invalidFiles.join(', ')}` });
    }

    // 原子性の高い一時ディレクトリ作成（競合・重複の回避）
    try {
        workDir = fs.mkdtempSync(path.join(__dirname, 'work_'));
    } catch (e) {
        inFlightCount--;
        clearTimeout(deadlineTimer);
        return res.status(500).json({ success: false, error: '一時ディレクトリの作成に失敗しました。' });
    }

    // H3: 出力は workDir/out/ の専用サブディレクトリに配置（入力ファイルの上書きを絶対に防ぐ）
    const outDir = path.join(workDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });

    let workDirRemoved = false;
    const removeWorkDir = () => {
        if (workDirRemoved || !workDir) return;
        workDirRemoved = true;
        try { if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    };

    // 完了・異常・中断のいずれでも確実に後片付け（inFlightCount 減算・期限タイマー停止・作業ディレクトリ削除）
    const cleanup = () => {
        inFlightCount--;
        clearTimeout(deadlineTimer);
        removeWorkDir();
    };
    // 中断（クライアント切断・期限超過）時のみ作業ディレクトリを削除
    // （通常完了時も 'close' は発火するため、res.writableEnded で区別する）
    req.on('close', () => {
        if (!res.writableEnded) {
            controller.abort(); // H1: 切断時は AbortController で全子プロセスを中断
            cleanup();
        }
    });

    try {

        let convertedFiles = [];
        const perFileErrors = []; // M5: ファイル単位の失敗を収集
        const inputNames = new Set(); // H3: 入力ファイル名の管理（入力書き出しループ専用）
        const outputNames = new Set(); // H3: 出力ファイル名の管理（出力書き出しループ専用）
        const safeFileNames = []; // H1: 書き出し後に使うサニタイズ済みファイル名

        // 1. 全ファイルを一旦書き出し（H1: safeNameでパス TRAVERSAL・インジェクション対策）
        // H3: 入力ファイル名は inputNames で重複を回避（同名ファイルの上書きを防ぐ）
        for (const file of uploadedFiles) {
            const safe = safeName(file.name);
            if (!safe || safe.startsWith('.')) {
                perFileErrors.push({ file: String(file.name || ''), error: '無効なファイル名です。' });
                continue;
            }
            // M7: Windowsの予約ファイル名は拒否する
            if (WINDOWS_RESERVED_NAMES.test(safe)) {
                perFileErrors.push({ file: String(file.name || ''), error: 'Windowsの予約ファイル名のため使用できません。' });
                continue;
            }
            // M6: 入力拡張子の方角別検証
            const extOk = direction === 'verilog2vhdl' ? /\.(v|sv)$/i.test(safe) : /\.(vhd|vhdl)$/i.test(safe);
            if (!extOk) {
                perFileErrors.push({ file: String(file.name || ''), error: 'この変換方向には対応していないファイル拡張子です。' });
                continue;
            }
            const unique = uniqueName(safe, inputNames); // H3: 入力専用セットで重複回避
            safeFileNames.push({ original: file, safe: unique }); // ファイルと安全名のペアを保持
            fs.writeFileSync(path.join(workDir, unique), file.content);
        }

        if (safeFileNames.length === 0) {
            throw new Error("有効なファイルが1つもありません。");
        }

        if (direction === 'vhdl2verilog') {
            // 1. 全VHDLファイルをインポート（台帳登録）
            // M6: cwdオプションで作業ディレクトリへ移動（cdコマンド不使用）
            try {
                // .vhd と .vhdl の両方をインポート
                await execFilePromise('ghdl', ['-i', '--std=08', ...safeFileNames.map(f => f.safe)],
                    { ...EXEC_OPTS, cwd: workDir, signal });
            } catch (e) { /* 初期インポートのエラーは無視して次に進む */ }

            for (const { original: file, safe: safeFile } of safeFileNames) {
                if (signal.aborted) break; // 中断されたら以降の変換をスキップ
                // M1: コメント除去 + 文先頭アンカーでエンティティを抽出
                const entityMatches = extractEntities(file.content);

                for (const rawEntity of entityMatches) {
                    if (signal.aborted) break;
                    // H1: エンティティ名もサニタイズ（basename + 英数字・_・- のみ）
                    const entityName = safeName(rawEntity).replace(/[^A-Za-z0-9_.\-]/g, '_');
                    if (!entityName || entityName.startsWith('.')) continue;
                    // H3: 出力は out/ サブディレクトリへ（出力専用セットで重複回避）
                    const outFileName = uniqueName(`${entityName}.v`, outputNames);
                    const outPath = path.join(outDir, outFileName);

                    try {
                        // 2. 依存関係を解決しながらビルド
                        await execFilePromise('ghdl', ['-m', '--std=08', entityName],
                            { ...EXEC_OPTS, cwd: workDir, signal });

                        // 3. Verilogへ変換
                        const { stdout } = await execFilePromise(
                            'ghdl', ['--synth', '--std=08', '--latches', '--out=verilog', entityName],
                            { ...EXEC_OPTS, cwd: workDir, signal } // M5: cwd指定で作業ディレクトリ内で実行
                        );

                        // M4: 整形前にバックアップ（整形失敗時の復元用）
                        fs.writeFileSync(outPath, stdout);
                        fs.copyFileSync(outPath, outPath + '.preformat.bak');
                        await formatCode(workDir, outPath, 'verilog', signal);

                        const finalContent = fs.readFileSync(outPath, 'utf8');
                        convertedFiles.push({ name: outFileName, content: finalContent });
                    } catch (err) {
                        // H1: クライアント切断・期限超過による中断時は以降の処理を止める
                        if (err && (err.code === 'ABORT_ERR' || err.name === 'AbortError')) {
                            throw err;
                        }
                        // --- 不足ファイルの解析ロジック ---
                        const stderr = err.stderr || "";
                        const missingUnit = stderr.match(/unit\s+"([^"]+)"\s+not\s+found/i);

                        if (missingUnit) {
                            // 「XXX.vhd が足りない」と具体的に報告（他のファイルは変換を続行）
                            perFileErrors.push({ file: file.name, error: `不足ファイル検知: 「${missingUnit[1]}.vhd」を一緒にアップロードしてください。` });
                        } else {
                            perFileErrors.push({ file: file.name, error: `エンティティ「${entityName}」の変換に失敗: ${safeError(err)}` });
                        }
                    }
                }
            }
        } else {
            // Verilog -> VHDL
            for (const { original: file, safe: safeFile } of safeFileNames) {
                if (signal.aborted) break;
                // H3: 出力は out/ サブディレクトリへ（出力専用セットで重複回避）
                const outputName = safeFile.replace(/\.(v|sv)$/i, '') + '.vhd';
                const uniqueOutputName = uniqueName(outputName, outputNames);
                const outPath = path.join(outDir, uniqueOutputName);
                // M6: execFile + argv + cwd（cd不使用）
                const args = ['-t', 'vhdl', '-o', uniqueOutputName, safeFile];

                try {
                    await execFilePromise('iverilog', args, { ...EXEC_OPTS, cwd: workDir, signal });

                    // M4: 整形前にバックアップ（整形失敗時の復元用）
                    fs.copyFileSync(outPath, outPath + '.preformat.bak');
                    // フォーマット実行
                    await formatCode(workDir, outPath, 'vhdl', signal);

                    const vhdContent = fs.readFileSync(outPath, 'utf8');
                    convertedFiles.push({ name: uniqueOutputName, content: vhdContent });
                } catch (err) {
                    // H1: クライアント切断・期限超過による中断時は以降の処理を止める
                    if (err && (err.code === 'ABORT_ERR' || err.name === 'AbortError')) {
                        throw err;
                    }
                    // M5: 静かに失敗せず、エラーを収集して返す
                    console.error(`変換失敗: ${safeFile}`, err);
                    perFileErrors.push({ file: file.name, error: String(err.stderr || err.message) });
                }
            }
        }

        // 作業ディレクトリ削除
        removeWorkDir();

        if (convertedFiles.length === 0) {
            const detail = perFileErrors.length > 0 ? ' 詳細: ' + perFileErrors.map(e => `[${e.file}] ${e.error}`).join(' | ') : '';
            throw new Error(`変換結果が空です。${detail}`);
        }

        if (!res.writableEnded) {
            res.json({ success: true, files: convertedFiles, perFileErrors: perFileErrors });
        }

    } catch (e) {
        if (!res.headersSent) {
            const status = (e && (e.code === 'ABORT_ERR' || e.name === 'AbortError')) ? 504 : 500;
            res.status(status).json({ success: false, error: safeError(e) });
        }
    } finally {
        cleanup();
    }
});

const PORT = 3030;
// L9: ローカルホストのみにバインド
const server = app.listen(PORT, '127.0.0.1', () => console.log(`Server running on 127.0.0.1:${PORT}`));
// L9: バインド失敗等のサーバーエラーハンドリング
server.on('error', (err) => {
    console.error('Server error:', err);
});
