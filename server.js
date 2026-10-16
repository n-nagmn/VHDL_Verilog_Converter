const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const fs = require('fs');
const path = require('path');

const app = express();
// M3: CORSを同一オリジン（およびOriginヘッダなしのcurl等）に限定
app.use(cors({ origin: (origin, cb) => cb(null, !origin) }));
app.use(express.json({ limit: '100mb' }));

// H1: ファイル名/エンティティ名のサニタイズ（パス TRAVERSAL・シェルインジェクション対策）
const safeName = (n) => path.basename(String(n || '').replace(/[\\\/]/g, '_')).replace(/[^\w.\-]/g, '_');

// M4: 全execFile呼び出し共通のタイムアウト・バッファ設定
const EXEC_OPTS = { timeout: 30000, maxBuffer: 50 * 1024 * 1024 };

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
 */
async function formatCode(workDir, outPath, language) {
    try {
        if (language === 'verilog') {
            // Veribleを使用して整形
            await execFilePromise('verible-verilog-format', ['--inplace', outPath],
                { ...EXEC_OPTS, cwd: workDir });
        } else if (language === 'vhdl') {
            // VSGを使用して整形 (--fix オプションで自動修正)
            await execFilePromise('vsg', ['-f', outPath, '--fix'],
                { ...EXEC_OPTS, cwd: workDir });
        }
    } catch (err) {
        console.warn(`[Formatter Warning] ${language} の整形に失敗しました（ツールが未インストールかもしれません）:`, err.message);
        // 整形に失敗しても、元の変換コードは残っているため続行
    }
}

app.post('/api/convert', async (req, res) => {
    const uploadedFiles = req.body.files;
    const direction = req.body.direction;

    // L5: directionの検証
    if (direction !== 'vhdl2verilog' && direction !== 'verilog2vhdl') {
        return res.status(400).json({ success: false, error: "不正な変換方向です。" });
    }

    if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ success: false, error: "ファイルがありません。" });
    }

    const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 10000);
    const workDir = path.join(__dirname, `work_${uniqueId}`);

    try {
        if (!fs.existsSync(workDir)) fs.mkdirSync(workDir);

        let convertedFiles = [];
        const perFileErrors = []; // M5: ファイル単位の失敗を収集
        const usedNames = new Set(); // M2: 出力ファイル名の重複管理
        const safeFileNames = []; // H1: 書き出し後に使うサニタイズ済みファイル名

        // 1. 全ファイルを一旦書き出し（H1: safeNameでパス TRAVERSAL・インジェクション対策）
        for (const file of uploadedFiles) {
            const safe = safeName(file.name);
            if (!safe || safe.startsWith('.')) {
                perFileErrors.push({ file: String(file.name || ''), error: '無効なファイル名です。' });
                continue;
            }
            safeFileNames.push(safe);
            fs.writeFileSync(path.join(workDir, safe), file.content);
        }

        if (safeFileNames.length === 0) {
            throw new Error("有効なファイルが1つもありません。");
        }

        if (direction === 'vhdl2verilog') {
            // 1. 全VHDLファイルをインポート（台帳登録）
            // M6: cwdオプションで作業ディレクトリへ移動（cdコマンド不使用）
            try {
                await execFilePromise('ghdl', ['-i', '--std=08', ...safeFileNames.filter(n => n.toLowerCase().endsWith('.vhd'))],
                    { ...EXEC_OPTS, cwd: workDir });
            } catch (e) { /* 初期インポートのエラーは無視して次に進む */ }

            for (let i = 0; i < uploadedFiles.length; i++) {
                const file = uploadedFiles[i];
                const safeFile = safeFileNames[i];
                // M1: コメント除去 + 文先頭アンカーでエンティティを抽出
                const entityMatches = extractEntities(file.content);

                for (const rawEntity of entityMatches) {
                    // H1: エンティティ名もサニタイズ（basename + 英数字・_・- のみ）
                    const entityName = safeName(rawEntity).replace(/[^A-Za-z0-9_.\-]/g, '_');
                    if (!entityName || entityName.startsWith('.')) continue;
                    // M2: 同名エンティティが複数ある場合はサフィックスで回避
                    const outFileName = uniqueName(`${entityName}.v`, usedNames);
                    const outPath = path.join(workDir, outFileName);

                    try {
                        // 2. 依存関係を解決しながらビルド
                        await execFilePromise('ghdl', ['-m', '--std=08', entityName],
                            { ...EXEC_OPTS, cwd: workDir });

                        // 3. Verilogへ変換
                        const { stdout } = await execFilePromise(
                            'ghdl', ['--synth', '--std=08', '--latches', '--out=verilog', entityName],
                            EXEC_OPTS
                        );

                        fs.writeFileSync(outPath, stdout);
                        await formatCode(workDir, outPath, 'verilog');

                        const finalContent = fs.readFileSync(outPath, 'utf8');
                        convertedFiles.push({ name: outFileName, content: finalContent });
                    } catch (err) {
                        // --- 不足ファイルの解析ロジック ---
                        const stderr = err.stderr || "";
                        const missingUnit = stderr.match(/unit\s+"([^"]+)"\s+not\s+found/i);

                        if (missingUnit) {
                            // 「XXX.vhd が足りない」と具体的にエラーを投げる
                            throw new Error(`不足ファイル検知: 「${missingUnit[1]}.vhd」を一緒にアップロードしてください。`);
                        }
                        perFileErrors.push({ file: file.name, error: `エンティティ「${entityName}」の変換に失敗: ${err.message}` });
                    }
                }
            }
        } else {
            // Verilog -> VHDL
            for (const safeFile of safeFileNames) {
                const outputName = safeFile.replace(/\.(v|sv)$/, '') + '.vhd';
                const uniqueOutputName = uniqueName(outputName, usedNames); // M2
                const outPath = path.join(workDir, uniqueOutputName);
                // M6: execFile + argv + cwd（cd不使用）
                const args = ['-t', 'vhdl', '-o', uniqueOutputName, safeFile];

                try {
                    await execFilePromise('iverilog', args, { ...EXEC_OPTS, cwd: workDir });

                    // フォーマット実行
                    await formatCode(workDir, outPath, 'vhdl');

                    const vhdContent = fs.readFileSync(outPath, 'utf8');
                    convertedFiles.push({ name: uniqueOutputName, content: vhdContent });
                } catch (err) {
                    // M5: 静かに失敗せず、エラーを収集して返す
                    console.error(`変換失敗: ${safeFile}`, err);
                    perFileErrors.push({ file: safeFile, error: String(err.stderr || err.message) });
                }
            }
        }

        // 作業ディレクトリ削除
        fs.rmSync(workDir, { recursive: true, force: true });

        if (convertedFiles.length === 0) {
            const detail = perFileErrors.length > 0 ? ' 詳細: ' + perFileErrors.map(e => `[${e.file}] ${e.error}`).join(' | ') : '';
            throw new Error(`変換結果が空です。${detail}`);
        }

        res.json({ success: true, files: convertedFiles, perFileErrors: perFileErrors });

    } catch (e) {
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
        res.status(500).json({ success: false, error: e.message });
    }
});

const PORT = 3030;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
