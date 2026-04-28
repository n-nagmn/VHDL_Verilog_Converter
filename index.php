<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>HDL Professional Converter</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #f0f2f5; color: #333; }
        .toolbar { margin-bottom: 15px; display: flex; align-items: center; gap: 12px; background: #fff; padding: 12px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border: 1px solid #ddd;}
        button { padding: 10px 18px; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; transition: all 0.2s; }
        button:active { transform: translateY(1px); }
        button:disabled { background: #ccc !important; cursor: not-allowed; }
        .btn-convert { background: #0078d4; color: white; }
        .btn-convert:hover { background: #005a9e; }
        .btn-download { background: #28a745; color: white; }
        .btn-zip { background: #6c757d; color: white; }
        .editor-container { display: flex; gap: 20px; height: 78vh; }
        .editor-box { flex: 1; display: flex; flex-direction: column; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        .editor-label { font-size: 14px; font-weight: bold; padding: 10px 15px; background: #f8f9fa; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
        .editor { flex: 1; }
        #fileListDisplay { font-size: 13px; color: #555; font-style: italic; }
        select { padding: 6px; border-radius: 4px; border: 1px solid #ccc; background: white; }
    </style>
</head>
<body>

    <h2 style="margin-top: 0;">HDL 相互変換 & 自動整形ツール</h2>
    
    <div class="toolbar">
        <input type="file" id="fileInput" style="display: none;" multiple onchange="loadFiles(event)">
        <button onclick="document.getElementById('fileInput').click()" style="background: #eee;">📁 ファイル選択</button>
        <span id="fileListDisplay">未選択</span>

        <select id="direction">
            <option value="vhdl2verilog">VHDL ➔ Verilog (Auto-Format)</option>
            <option value="verilog2vhdl">Verilog ➔ VHDL (Auto-Format)</option>
        </select>
        
        <button id="convertBtn" class="btn-convert" onclick="convertCode()">変換と整形を実行</button>
        
        <button id="dlBtn" class="btn-download" onclick="downloadSelected()" disabled>💾 保存</button>
        <button id="dlAllBtn" class="btn-zip" onclick="downloadAll()" disabled>📦 全ZIP保存</button>
        
        <span id="statusMessage" style="margin-left: auto; font-weight: bold; padding-right: 10px;"></span>
    </div>

    <div class="editor-container">
        <div class="editor-box">
            <div class="editor-label">入力ソース</div>
            <div id="editorLeft" class="editor"></div>
        </div>
        <div class="editor-box">
            <div class="editor-label">
                整形済み出力
                <select id="outputSelector" onchange="onOutputChange()" style="max-width: 250px;"></select>
            </div>
            <div id="editorRight" class="editor"></div>
        </div>
    </div>

    <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.38.0/min/vs/loader.min.js"></script>
    
    <script>
        let editorL, editorR;
        let inputFiles = [];
        let outputFiles = [];

        require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.38.0/min/vs' }});
        require(['vs/editor/editor.main'], function() {
            const commonConfig = {
                theme: 'vs-dark',
                automaticLayout: true,
                fontSize: 14,
                fontFamily: "'Cascadia Code', 'Consolas', monospace",
                minimap: { enabled: false },
                scrollBeyondLastLine: false
            };
            
            editorL = monaco.editor.create(document.getElementById('editorLeft'), { ...commonConfig, language: 'vhdl' });
            editorR = monaco.editor.create(document.getElementById('editorRight'), { ...commonConfig, language: 'verilog', readOnly: true });
        });

        async function loadFiles(event) {
            const files = Array.from(event.target.files);
            if (files.length === 0) return;
            
            inputFiles = [];
            for (const f of files) {
                const text = await f.text();
                inputFiles.push({ name: f.name, content: text });
            }
            
            editorL.setValue(inputFiles[0].content);
            document.getElementById('fileListDisplay').innerText = `${inputFiles.length}個を読込`;
            
            const ext = inputFiles[0].name.split('.').pop().toLowerCase();
            const mode = (ext === 'vhd' || ext === 'vhdl') ? 'vhdl' : 'verilog';
            monaco.editor.setModelLanguage(editorL.getModel(), mode);
        }

        async function convertCode() {
            const status = document.getElementById('statusMessage');
            if (inputFiles.length === 0) { alert("ファイルを選択してください"); return; }
            
            // 現在エディタに表示されている内容で上書き（編集対応）
            inputFiles[0].content = editorL.getValue();
            
            status.innerText = "⏳ 変換・整形中...";
            status.style.color = "#ef6c00";

            try {
                const res = await fetch('http://172.23.72.107:3030/api/convert', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ files: inputFiles, direction: document.getElementById('direction').value })
                });
                const data = await res.json();
                
                if (data.success) {
                    outputFiles = data.files;
                    updateOutputSelector();
                    displayOutput(0);
                    
                    document.getElementById('dlBtn').disabled = false;
                    document.getElementById('dlAllBtn').disabled = false;
                    
                    status.innerText = "✅ 完了";
                    status.style.color = "green";
                } else {
                    status.innerText = "❌ 失敗";
                    status.style.color = "red";
                    alert("サーバーエラー: " + data.error);
                }
            } catch (e) { 
                status.innerText = "🚫 通信失敗";
                status.style.color = "red";
                console.error(e);
            }
        }

        function updateOutputSelector() {
            const selector = document.getElementById('outputSelector');
            selector.innerHTML = "";
            outputFiles.forEach((file, index) => {
                const opt = document.createElement('option');
                opt.value = index;
                opt.innerText = file.name;
                selector.appendChild(opt);
            });
        }

        function onOutputChange() {
            displayOutput(document.getElementById('outputSelector').value);
        }

        function displayOutput(index) {
            if (outputFiles[index]) {
                editorR.setValue(outputFiles[index].content);
                const mode = outputFiles[index].name.endsWith('.vhd') ? 'vhdl' : 'verilog';
                monaco.editor.setModelLanguage(editorR.getModel(), mode);
            }
        }

        function downloadSelected() {
            const index = document.getElementById('outputSelector').value;
            const file = outputFiles[index];
            if (!file) return;
            const blob = new Blob([file.content], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = file.name;
            a.click();
        }

        async function downloadAll() {
            if (outputFiles.length === 0) return;
            const zip = new JSZip();
            outputFiles.forEach(f => zip.file(f.name, f.content));
            const content = await zip.generateAsync({ type: "blob" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = "hdl_formatted_files.zip";
            a.click();
        }
    </script>
</body>
</html>