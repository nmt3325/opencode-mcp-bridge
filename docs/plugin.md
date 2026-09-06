# Notion AI × OpenCode 標準チャット

OpenCode の標準チャット画面・セッション・履歴をそのまま使い、入力を Notion AI に送り、返答を通常の assistant メッセージとして表示するプラグインです。推論とツール選択は Notion AI が担当します。ファイル編集は同梱 MCP が実際の OpenCode native tools で行い、ローカル側の二重 LLM 推論は行いません。

```text
OpenCode 標準チャット → Notion プロバイダー → Notion AI (token_v2)
                                              ↓ ツール呼び出し
手動設定の公開 HTTPS /mcp → 同梱 MCP → 専用 Bun worker → OpenCode native tools
```

## 前提

- **OpenCode 1.18.29**、Node.js 22+、Git。Linux で検証。
- Notion AI を利用できるアカウントの `token_v2`。公式 integration token とは別です。
- Notion から到達できる **公開 HTTPS URL**。トンネル・DNS・TLS は手動で用意します。
- 初回起動時に GitHub / npm への接続が必要です。固定された実行用 OpenCode ソースと依存関係を自動取得します。
- Bun 1.3.14 は platform-specific optional dependency の実行ファイルを直接利用します。postinstall は不要です。optional dependencies を省略する場合は `OPENCODE_MCP_BUN` に同バージョンの実行ファイルを指定してください。

Notion Web 内部 API を利用しています。公式の安定 API ではなく、変更時には追従が必要です。現在の接続先は app.notion.com です。

## PR / ソース版の導入

この変更は npm 公開操作を含みません。PR 版は次のようにビルドします。プラグイン自体は編集対象プロジェクトの外に配置してください。

```sh
git clone --branch feat/notion-opencode-plugin https://github.com/nmt3325/opencode-mcp-bridge.git "$HOME/.local/share/opencode-notion-plugin"
cd "$HOME/.local/share/opencode-notion-plugin"
npm ci --ignore-scripts
npm run build
```

OpenCode 設定の既存項目を残して、ビルド済みファイルの絶対 file URL を追加します。

```json
{
  "plugin": ["file:///absolute/path/to/opencode-notion-plugin/dist/plugin.js"]
}
```

`npm pack` は `dist`、Notion クライアント、実行アダプター、setup スクリプトを一つの tarball にまとめます。公開済みパッケージを使う段階では通常の npm プラグイン指定に置き換えられます。未ビルドの Git URL を `--ignore-scripts` でインストールしても `dist` は生成されません。

## Cookie と公開 URL

リポジトリ外の `~/.config/opencode/notion-account.json` などに保存します。

```json
{
  "token_v2": "YOUR_TOKEN_V2",
  "space_id": "OPTIONAL_NOTION_WORKSPACE_ID"
}
```

`space_id` は省略可能です。利用ワークスペースを固定する場合は指定してください。トークンをチャット・プロジェクト設定・Git に書かないでください。

```sh
chmod 600 "$HOME/.config/opencode/notion-account.json"
export NOTION_ACCOUNT_FILE="$HOME/.config/opencode/notion-account.json"
export OPENCODE_NOTION_MCP_URL='https://opencode.example.com/mcp'
cd /absolute/path/to/your/project
opencode
```

`NOTION_TOKEN_V2` 環境変数も利用でき、account file より優先されます。

公開 URL の `/mcp` を **`http://127.0.0.1:8787/mcp`** に転送してください。Authorization、Mcp-Session-Id、Streamable HTTP を透過させます。URL に資格情報・クエリー・フラグメントは含められません。

起動時にプラグインが自動で行うこと:

1. 必要な native runtime の取得・固定バージョン検証。
2. 専用 worker と認証付き MCP HTTP サーバーの起動。
3. プロジェクト名＋パスのハッシュを含む専用接続の Notion への登録または再利用。
4. その接続の読み取り・書き込み自動実行の有効化。
5. `notion` エージェントと `notion-ai/chat` の既定設定。

既存セッションで別モデルを明示選択している場合は標準 UI から Notion AI を選んでください。セットアップ失敗時も Notion プロバイダーに設定エラーを返し、別のローカル LLM へ黙って切り替えません。既存の他の Notion 接続を乗っ取ったり、権限を変更したりはしません。

## 全許可モードと境界

初期版は **全許可モード固定**。`read` / `write` / `edit` / `glob` / `grep` / `bash` / `webfetch` / `todowrite` が承認待ちなしで実行されます。MCP の bearer credential は token_v2 とは別に生成・保存します。Notion トークンやホストのモデル API キーを worker の環境には渡しません。

認証、ファイルツールのパスチェック、`external_directory` / `task` / `question` の拒否は維持します。ただし **シェルは OS のファイルシステム隔離ではありません**。全許可の bash は OS ユーザー権限で動きます。信頼できるプロジェクト、または専用コンテナ／VM で利用してください。

単体 CLI (`npm start` / `npm run start:http`) の従来の承認モードは変更しません。プログラムから toolbox を import する場合は `opencode-mcp-bridge/toolbox` を使用します。ルート export はプラグインです。

## 会話・停止・制限

- OpenCode セッションと Notion 会話を対応づけ、**新しいユーザー入力だけ**を送信します。全履歴の重複送信はしません。
- 完了済みの会話は再起動後も継続します。同じ message の再試行は保存済み返答を返し、編集を再実行しません。
- タイトル・要約・compaction 用のリクエストはローカル処理。本会話には送りません。自動 compaction は無効です。
- 一つのプロジェクトで進行できるターンは一つ。他セッションからの同時送信は明示的に拒否します。
- 停止時は Notion 中断を試行し、専用 worker の未完了ジョブをキャンセルします。通信障害時は Notion 側でも確認してください。
- 送信後に応答が不明になった message は自動再送しません。Notion 側を確認して、新しいメッセージまたは新規チャットを開始します。
- 状態は既定で `~/.local/state/opencode-notion`。会話の返答も含みます。ディレクトリ 0700 / ファイル 0600 とし、アカウント・ワークスペース・プロジェクトを分離します。
- 強制終了でロックが残った場合は、該当 OpenCode が動作していないことを確認し、エラーに示された lock だけを削除します。会話状態は消さないでください。
- **一つの公開 URL は一つのプロジェクト／起動専用**です。別ウィンドウ・worktree・別クライアントで共有しないでください。複数プロジェクトには別 URL とポートを用意します。停止は専用 worker の全ジョブが対象です。
- テキスト入力のみ。添付は黙って捨てず未対応エラーにします。
- 最終返答を標準 SSE 形式で表示し、待機中は heartbeat を送ります。Notion のトークン単位ストリーミングや、Notion 内のツールカード／途中経過の同期は未実装です。ファイル編集自体は実行されます。
- Notion 全会話の同期・取り込み、quota 回避のワークスペース自動作成／ローテーション、keep-awake、自動 continue は行いません。

## オプション

プラグイン指定を `["file:///.../dist/plugin.js", {"publicUrl":"https://example.com/mcp","accountFile":"/path/account.json","port":8787}]` の tuple にすることもできます。

| オプション | 環境変数 | 既定値 |
| --- | --- | --- |
| publicUrl | OPENCODE_NOTION_MCP_URL | 必須 |
| accountFile | NOTION_ACCOUNT_FILE | なし |
| spaceId | NOTION_SPACE_ID | file / アカウントから解決 |
| model | NOTION_DEFAULT_MODEL | default |
| stateDir | OPENCODE_NOTION_STATE_DIR | ~/.local/state/opencode-notion |
| runtimeDir | OPENCODE_MCP_RUNTIME_DIR | stateDir/runtime/1.18.29 |
| bun | OPENCODE_MCP_BUN | platform optional dependency |
| port | OPENCODE_MCP_PORT | 8787 |
| autoSetup | なし | true |

state/runtime は編集対象プロジェクトの外に置きます。bind は 127.0.0.1 固定です。

## 検証

```sh
npm run build
npm run setup:native
npm run typecheck:native
npm test
npm run test:opencode
npm run test:package
npm audit --omit=dev
```

`test:opencode` は未改変の固定 OpenCode 本体で plugin loader / provider / assistant イベント／再起動後の会話継続を確認します。TUI のピクセル比較ではありません。`test:package` は tarball を `--ignore-scripts --omit=dev` で新規インストールして、Bun と native runtime の自動取得・起動を検証します。

通常のテストは Notion の応答を模擬し、実アカウントや接続を変更しません。手動 live 検証の結果は [validation.md](validation.md) を参照してください。Cookie、会話識別子、接続 credential はリポジトリに含めません。
