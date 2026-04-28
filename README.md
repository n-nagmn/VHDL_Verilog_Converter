# VHDL_Verilog_Converter

ブラウザ上で動作する、VHDLとVerilogの相互変換および自動整形（フォーマット）ツールです。
Monaco Editorを採用したリッチなUIで、変換前後のコードを左右に並べて比較・編集できます。バックエンドの変換エンジンには `GHDL` と `Icarus Verilog` を、フォーマッタには `Verible` と `VSG` を採用しています。

## 主な機能

* **VHDL ➔ Verilog 変換**: `ghdl --synth` を利用した論理合成レベルでの変換。
* **Verilog ➔ VHDL 変換**: `iverilog -t vhdl` を利用した変換。
* **自動コード整形**: 変換後のコードに対して、外部ツールを用いた自動フォーマットを適用。
  * Verilog: `verible-verilog-format`
  * VHDL: `VSG (VHDL Style Guide)`
* **ブラウザエディタ**: Monaco Editorによるシンタックスハイライト対応の操作画面。
* **一括処理**: 複数ファイルの同時アップロードと、変換後ファイルのZIP一括ダウンロードに対応。

## 🛠 必須環境 (Prerequisites)

本システムを稼働させるには、バックエンドサーバーに以下のツールがインストールされ、パスが通っている必要があります。

### Node.js 環境
* Node.js (v14以上推奨)
* npm

### HDL 変換・解析ツール
* **[GHDL](https://github.com/ghdl/ghdl)**: VHDLの解析およびVerilogへの変換に使用（VHDL-2008をサポートしているバージョンが必要）。
* **[Icarus Verilog (iverilog)](https://github.com/steveicarus/iverilog)**: VerilogからVHDLへの変換に使用。

### HDL フォーマッタ
* **[Verible](https://github.com/chipsalliance/verible)** (`verible-verilog-format`): Verilogコードの自動整形に使用。
* **[VSG](https://github.com/jeremiah-c-leary/vhdl-style-guide)** (`vsg`): VHDLコードの自動整形に使用（Pythonの `pip install vsg` 等で導入可能）。

## セットアップ手順

### 1. バックエンド (Node.js APIサーバー) の構築

プロジェクトディレクトリで必要なパッケージをインストールし、サーバーを起動します。

```bash
# パッケージのインストール
npm install express cors

# サーバーの起動 (デフォルトポート: 3030)
node server.js
```

### 2. フロントエンド (Web UI) の配置

`index.php` をWebサーバー（Apache, Nginxなど）の公開ディレクトリに配置するか、PHPのビルトインサーバーを使用してホストします。

```bash
# PHPビルトインサーバーを使用する場合の例
php -S 0.0.0.0:8000
```

### 3. APIエンドポイントの設定（重要）

`index.php` 内の `fetch` リクエスト先が固定IP（`http://172.23.72.107:3030/api/convert`）になっています。
動作させる環境に合わせて、`index.php` の以下の行を適切なIPアドレスまたはドメインに書き換えてください。

```javascript
// index.php 73行目付近
const res = await fetch('[http://172.23.72.107:3030/api/convert](http://172.23.72.107:3030/api/convert)', {
    // ...
```

## 使用方法

1. ブラウザでフロントエンド（`index.php` をホストしているURL）にアクセスします。
2. **「📁 ファイル選択」** ボタンをクリックし、変換したい `.v`, `.sv`, または `.vhd` ファイルを選択します（複数選択可）。
3. 中央のプルダウンから変換方向（`VHDL ➔ Verilog` または `Verilog ➔ VHDL`）を選択します。
4. **「変換と整形を実行」** ボタンをクリックします。
5. 右側のエディタに変換・整形済みのコードが表示されます。複数のファイルがある場合は「整形済み出力」横のプルダウンで表示を切り替えられます。
6. **「💾 保存」** で現在表示中のファイルを、**「📦 全ZIP保存」** で変換された全てのファイルをZIP形式でダウンロードします。
