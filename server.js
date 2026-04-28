const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

/**
 * 外部ツールを使用した整形処理 (オプション)
 */
async function formatCode(filePath, language) {
    try {
        if (language === 'verilog') {
            // Veribleを使用して整形
            await execPromise(`verible-verilog-format --inplace ${filePath}`);
        } else if (language === 'vhdl') {
            // VSGを使用して整形 (--fix オプションで自動修正)
            await execPromise(`vsg -f ${filePath} --fix`);
        }
    } catch (err) {
        console.warn(`[Formatter Warning] ${language} の整形に失敗しました（ツールが未インストールかもしれません）:`, err.message);
        // 整形に失敗しても、元の変換コードは残っているため続行
    }
}

app.post('/api/convert', async (req, res) => {
    const uploadedFiles = req.body.files;
    const direction = req.body.direction;
    
    if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ success: false, error: "ファイルがありません。" });
    }

    const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 10000);
    const workDir = path.join(__dirname, `work_${uniqueId}`);
    
    try {
        if (!fs.existsSync(workDir)) fs.mkdirSync(workDir);

        // 1. 全ファイルを一旦書き出し
        for (const file of uploadedFiles) {
            fs.writeFileSync(path.join(workDir, file.name), file.content);
        }

        let convertedFiles = [];

        if (direction === 'vhdl2verilog') {
            // VHDL -> Verilog
            await execPromise(`cd ${workDir} && ghdl -a --std=08 *.vhd`);

            for (const file of uploadedFiles) {
                const entityMatches = [...file.content.matchAll(/entity\s+(\w+)\s+is/gi)];
                
                for (const match of entityMatches) {
                    const entityName = match[1];
                    const outFileName = `${entityName}.v`;
                    const outPath = path.join(workDir, outFileName);

                    // 変換実行
                    const { stdout } = await execPromise(`cd ${workDir} && ghdl --synth --std=08 --latches --out=verilog ${entityName}`);
                    
                    // 一旦保存してフォーマットをかける
                    fs.writeFileSync(outPath, stdout);
                    await formatCode(outPath, 'verilog');
                    
                    const finalContent = fs.readFileSync(outPath, 'utf8');
                    convertedFiles.push({ name: outFileName, content: finalContent });
                }
            }
        } else {
            // Verilog -> VHDL
            for (const file of uploadedFiles) {
                const outputName = file.name.replace(/\.(v|sv)$/, '') + '.vhd';
                const outPath = path.join(workDir, outputName);
                const cmd = `cd ${workDir} && iverilog -t vhdl -o ${outputName} ${file.name}`;
                
                try {
                    await execPromise(cmd);
                    
                    // フォーマット実行
                    await formatCode(outPath, 'vhdl');
                    
                    const vhdContent = fs.readFileSync(outPath, 'utf8');
                    convertedFiles.push({ name: outputName, content: vhdContent });
                } catch (err) {
                    console.error(`変換失敗: ${file.name}`, err);
                }
            }
        }

        // 作業ディレクトリ削除
        fs.rmSync(workDir, { recursive: true, force: true });

        if (convertedFiles.length === 0) {
            throw new Error("変換結果が空です。");
        }

        res.json({ success: true, files: convertedFiles });

    } catch (e) {
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
        res.status(500).json({ success: false, error: e.message });
    }
});

const PORT = 3030;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));