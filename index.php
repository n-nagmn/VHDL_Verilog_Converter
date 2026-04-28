<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <title>HDL 相互変換ツール</title>
    <style>
        body { font-family: sans-serif; margin: 0; padding: 20px; background-color: #f4f4f9; }
        .toolbar { margin-bottom: 15px; display: flex; align-items: center; gap: 10px; background: #fff; padding: 10px; border-radius: 8px; border: 1px solid #ddd;}
        button { padding: 8px 15px; border-radius: 4px; border: none; font-weight: bold; cursor: pointer; transition: opacity 0.2s; }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-convert { background: #0078d4; color: white; }
        .btn-download { background: #28a745; color: white; }
        .btn-zip { background: #6c757d; color: white; }
        .editor-container { display: flex; gap: 20px; height: 75vh; }
        .editor-box { flex: 1; display: flex; flex-direction: column; }
        .editor-label { font-weight: bold; padding: 8px; background: #e0e0e0; border: 1px solid #ccc; border-bottom: none; display: flex; justify-content: space-between; align-items: center; }
        .editor { flex: 1; border: 1px solid #ccc; }
        #fileListDisplay { font-size: 12px; color: #666; }
        select { padding: 4px; border-radius: 4px; }
    </style>
</head>
<body>

    <h1>HDL 相互変換ツール</h1>
    
    <div class="toolbar">
        <input type="file" id="fileInput" style="display: none;" multiple onchange="loadFiles(event)">
        <button onclick="document.getElementById('fileInput').click()">📁 ファイル一括選択</button>
        <span id="fileListDisplay">選択されていません</span>

        <select id="direction">
            <option value="vhdl2verilog">VHDL &rarr; Verilog</option>
            <option value="verilog2vhdl">Verilog &rarr; VHDL</option>
        </select>
        
        <button id="convertBtn" class="btn-convert" onclick="convertCode()">変換を実行 &rarr;</button>
        
        <button id="dlBtn" class="btn-download" onclick="downloadSelected()" disabled>💾 表示中のみ保存</button>
        <button id="dlAllBtn" class="btn-zip" onclick="downloadAll()" disabled>📦 全ファイルをZIP保存</button>
        
        <span id="statusMessage" style="margin-left: auto; font-weight: bold;"></span>
    </div>

    <div class="editor-container">
        <div class="editor-box">
            <div class="editor-label">入力 (ソースコード)</div>
            <div id="editorLeft" class="editor"></div>
        </div>
        <div class="editor-box">
            <div class="editor-label">
                出力 (変換結果)
                <select id="outputSelector" onchange="onOutputChange()" style="max-width: 200px;"></select>
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
            editorL = monaco.editor.create(document.getElementById('editorLeft'), { language: 'vhdl', theme: 'vs-dark', automaticLayout: true });
            editorR = monaco.editor.create(document.getElementById('editorRight'), { language: 'verilog', theme: 'vs-dark', readOnly: true, automaticLayout: true });
        });

        async function loadFiles(event) {
            const files = Array.from(event.target.files);
            inputFiles = [];
            for (const f of files) {
                const text = await f.text();
                inputFiles.push({ name: f.name, content: text });
            }
            if (inputFiles.length > 0) {
                editorL.setValue(inputFiles[0].content);
                document.getElementById('fileListDisplay').innerText = `${inputFiles.length}個のファイルを読み込み済み`;
                
                // 言語設定の自動切り替え（入力側）
                const ext = inputFiles[0].name.split('.').pop().toLowerCase();
                const mode = (ext === 'vhd' || ext === 'vhdl') ? 'vhdl' : 'verilog';
                monaco.editor.setModelLanguage(editorL.getModel(), mode);
            }
        }

        async function convertCode() {
            const status = document.getElementById('statusMessage');
            if (inputFiles.length === 0) { status.innerText = "ファイルを選択してください"; return; }
            
            inputFiles[0].content = editorL.getValue();
            
            status.innerText = "変換中...";
            status.style.color = "orange";

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
                    
                    // ボタン類を有効化
                    document.getElementById('dlBtn').disabled = false;
                    document.getElementById('dlAllBtn').disabled = false;
                    
                    status.innerText = "変換成功";
                    status.style.color = "green";
                } else {
                    alert("エラー: " + data.error);
                    status.innerText = "失敗";
                    status.style.color = "red";
                }
            } catch (e) { 
                status.innerText = "サーバー接続失敗";
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
            const index = document.getElementById('outputSelector').value;
            displayOutput(index);
        }

        function displayOutput(index) {
            if (outputFiles[index]) {
                editorR.setValue(outputFiles[index].content);
                const mode = outputFiles[index].name.endsWith('.vhd') ? 'vhdl' : 'verilog';
                monaco.editor.setModelLanguage(editorR.getModel(), mode);
            }
        }

        // 個別ダウンロード
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

        // 全ファイル一括ZIPダウンロード
        async function downloadAll() {
            if (outputFiles.length === 0) return;
            
            const zip = new JSZip();
            const status = document.getElementById('statusMessage');
            const originalStatus = status.innerText;
            
            status.innerText = "ZIP生成中...";
            
            outputFiles.forEach(file => {
                zip.file(file.name, file.content);
            });

            const content = await zip.generateAsync({ type: "blob" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = "converted_hdl_files.zip";
            a.click();
            
            status.innerText = originalStatus;
        }
    </script>
</body>
</html>