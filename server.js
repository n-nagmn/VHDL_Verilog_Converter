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

app.post('/api/convert', async (req, res) => {
    const uploadedFiles = req.body.files; // [{name, content}, ...]
    const direction = req.body.direction;
    
    if (!uploadedFiles || uploadedFiles.length === 0) {
        return res.status(400).json({ success: false, error: "ファイルがありません。" });
    }

    const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 10000);
    const workDir = path.join(__dirname, `work_${uniqueId}`);
    
    try {
        if (!fs.existsSync(workDir)) fs.mkdirSync(workDir);

        // 1. 全ファイルを一旦書き出し（依存関係解決のため）
        for (const file of uploadedFiles) {
            fs.writeFileSync(path.join(workDir, file.name), file.content);
        }

        let convertedFiles = [];

        if (direction === 'vhdl2verilog') {
            // VHDL: 解析(analyze)を全ファイルに行い、その後各Entityを個別に合成(synth)
            // まず全ファイルを解析
            await execPromise(`cd ${workDir} && ghdl -a --std=08 *.vhd`);

            for (const file of uploadedFiles) {
                // ファイル内容からentity名を抽出 (簡易正規表現)
                const entityMatches = [...file.content.matchAll(/entity\s+(\w+)\s+is/gi)];
                
                for (const match of entityMatches) {
                    const entityName = match[1];
                    const { stdout } = await execPromise(`cd ${workDir} && ghdl --synth --std=08 --latches --out=verilog ${entityName}`);
                    convertedFiles.push({
                        name: `${entityName}.v`,
                        content: stdout
                    });
                }
            }
        } else {
            // Verilog to VHDL: 各ファイルを個別に変換
            for (const file of uploadedFiles) {
                const outputName = file.name.replace(/\.(v|sv)$/, '') + '.vhd';
                const cmd = `cd ${workDir} && iverilog -t vhdl -o ${outputName} ${file.name}`;
                
                try {
                    await execPromise(cmd);
                    const vhdContent = fs.readFileSync(path.join(workDir, outputName), 'utf8');
                    convertedFiles.push({
                        name: outputName,
                        content: vhdContent
                    });
                } catch (err) {
                    console.error(`変換失敗: ${file.name}`, err);
                }
            }
        }

        // 作業ディレクトリ削除
        fs.rmSync(workDir, { recursive: true, force: true });

        if (convertedFiles.length === 0) {
            throw new Error("変換結果が空です。コード内に有効なモジュール/エンティティがあるか確認してください。");
        }

        res.json({ success: true, files: convertedFiles });

    } catch (e) {
        if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
        res.status(500).json({ success: false, error: e.message });
    }
});

const PORT = 3030;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));