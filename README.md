# opencode-mcp-bridge

[opencode](https://opencode.ai) の HTTP サーバー (`opencode serve`) を **MCP (Model Context Protocol) サーバー**として公開するブリッジです。
MCP しか接続できない AI チャット（tool calling API を直接使えないクライアント）から、opencode のコーディングエージェントとシェルをフル機能で操作するために作りました。

> **設計上の最重要ポイント**: すべての MCP ツールは **必ず 55 秒以内にレスポンスを返します**。
> 60 秒でタイムアウトする MCP クライアントでも「呼び出し失敗」にならないよう、長時間処理は必ず
> 「開始 → ジョブ ID を返す → ポーリング」の非同期パターンに分解しています。

## なぜブリッジが必要か

| 課題 | 素の opencode | 本ブリッジ |
| --- | --- | --- |
| MCP サーバーとして起動できるか | ❌ opencode は MCP *クライアント*機能しか持たない | ✅ Streamable HTTP / stdio の MCP サーバー |
| エージェント実行の待ち時間 | `POST /session/{id}/message` は完了までブロック（数分）→ 60 秒制限で必ず失敗 | ✅ `opencode_start` が即返し、`opencode_wait` で分割ポーリング |
| シェルの長時間コマンド | 完了までブロック | ✅ ジョブ化して `opencode_shell_output` で増分取得、延長・kill も可能 |
| 危険コマンド | 設定次第 | ✅ ブリッジ側にも deny/allow のガードを二重化 |
| API のバージョン差 | v2 experimental な `/api/shell` はビルドにより存在しない | ✅ 起動時に能力を検出し、無ければ旧 API に自動フォールバック |

## アーキテクチャ

```text
  MCP クライアント (60 秒制限あり)
        │  Streamable HTTP: POST /mcp    （または stdio）
        ▼
  opencode-mcp-bridge  ──  HTTP  ──▶  opencode serve (127.0.0.1:4096)
        │                                   │
        │                                   ├── /session, /session/{id}/prompt_async
        │                                   ├── /api/shell（v2）または /session/{id}/shell（legacy）
        │                                   ├── /file/content, /find, /find/file
        │                                   └── /permission, /question
        └── 55 秒ハードキャップ + ジョブ管理 + コマンドガード
```

## ツール一覧（20 個）

### エージェント
| ツール | 説明 |
| --- | --- |
| `opencode_start` | プロンプトを投げてセッションを開始（即座に `session_id` を返す）。`prompt_async` が無い環境ではバックグラウンド送信にフォールバック |
| `opencode_wait` | 指定秒数だけ完了を待つ。未完なら `finished:false` と待機中の permission を返すので、そのまま再呼び出しすればよい |
| `opencode_result` | セッションのメッセージ履歴を取得（ページング対応） |
| `opencode_abort` | 実行中のセッションを中断 |
| `opencode_sessions` | セッション一覧 |

### シェル
| ツール | 説明 |
| --- | --- |
| `opencode_shell` | コマンドをジョブとして開始し、`wait_seconds`（既定 5 秒）だけ待つ。終わらなければ `shell_id` と `cursor` を返す |
| `opencode_shell_output` | `cursor` 以降の出力だけを増分取得。完了するまでツール内で最大 45 秒待機 |
| `opencode_shell_status` | ジョブの状態・終了コード |
| `opencode_shell_list` | 実行中/完了済みジョブ一覧 |
| `opencode_shell_extend` | タイムアウト延長（v2 API のみ） |
| `opencode_shell_kill` | ジョブを強制終了 |

### ファイル・検索
| ツール | 説明 |
| --- | --- |
| `opencode_read` | ファイル読み取り（オフセット/行数指定可） |
| `opencode_grep` | 内容検索 |
| `opencode_find_file` | ファイル名検索 |
| `opencode_diff` | 作業ツリーの差分 |

### 承認（permission / question）
| ツール | 説明 |
| --- | --- |
| `opencode_permissions_pending` | 承認待ちの一覧 |
| `opencode_permission_reply` | `once` / `always` / `reject` で応答 |
| `opencode_questions_pending` | エージェントからの質問一覧 |
| `opencode_question_reply` | 質問への回答 |

### 診断
| ツール | 説明 |
| --- | --- |
| `opencode_health` | 接続確認と API 能力検出（`shellApi: v2 / legacy` など） |

すべてのツールは JSON テキストを返し、`ok` と **`next_action`**（次に呼ぶべきツールのヒント）を含みます。
これにより、tool calling に不慣れなチャット AI でも「次に何をすればよいか」を迷いません。

## セットアップ

```bash
git clone https://github.com/nmt3325/opencode-mcp-bridge.git
cd opencode-mcp-bridge
npm install
npm run build

# 1) opencode をサーバーモードで起動
opencode serve --port 4096 --hostname 127.0.0.1

# 2) ブリッジを起動（HTTP モード）
OPENCODE_BASE_URL=http://127.0.0.1:4096 \
OPENCODE_MCP_TOKEN=$(openssl rand -hex 24) \
node dist/index.js --http --port 8787
```

stdio で使う場合は `node dist/index.js --stdio`。

### MCP クライアント設定例

Streamable HTTP:

```json
{
  "mcpServers": {
    "opencode": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <OPENCODE_MCP_TOKEN>" }
    }
  }
}
```

stdio:

```json
{
  "mcpServers": {
    "opencode": {
      "command": "node",
      "args": ["/path/to/opencode-mcp-bridge/dist/index.js", "--stdio"],
      "env": { "OPENCODE_BASE_URL": "http://127.0.0.1:4096" }
    }
  }
}
```

## 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `OPENCODE_BASE_URL` | `http://127.0.0.1:4096` | opencode サーバーの URL |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | – | opencode 側 Basic 認証 |
| `OPENCODE_API_TOKEN` | – | Bearer で送る場合 |
| `OPENCODE_MCP_HOST` / `OPENCODE_MCP_PORT` | `127.0.0.1` / `8787` | ブリッジの待受 |
| `OPENCODE_MCP_TOKEN` | – | 設定すると `Authorization: Bearer` か `x-mcp-token` を要求 |
| `OPENCODE_MCP_WAIT_MAX_SECONDS` | `45` | 1 回のツール呼び出しで待つ最大秒数（上限 50） |
| `OPENCODE_MCP_POLL_INTERVAL_MS` | `1000` | ポーリング間隔 |
| `OPENCODE_MCP_REQUEST_TIMEOUT_MS` | `20000` | opencode への 1 リクエストのタイムアウト |
| `OPENCODE_MCP_MAX_OUTPUT_CHARS` | `20000` | 1 レスポンスの最大文字数（超過分は切り詰め、続きは cursor で取得） |
| `OPENCODE_MCP_SHELL_TIMEOUT_SECONDS` | `120` | シェルジョブの既定タイムアウト |
| `OPENCODE_MCP_DENY_PATTERNS` | 下記 | 追加の拒否パターン（`,` 区切り、ワイルドカード可） |
| `OPENCODE_MCP_ALLOW_PATTERNS` | – | 設定するとホワイトリスト運用になる |
| `OPENCODE_MCP_DEFAULT_DIRECTORY` / `_AGENT` / `_MODEL` | – | 既定の作業ディレクトリ / エージェント / モデル |

既定の拒否パターン: `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `mkfs*`, `dd if=* of=/dev/*`, `shutdown*`, `reboot*`, `halt*`, `chmod -R 777 /*`, フォークボム など。

## セキュリティ

- **必ず `127.0.0.1` にバインド**してください。opencode のサーバーモードは認証が無く、シェル実行 API を含みます（過去に `/find` 経由のコマンドインジェクション事例あり）。外部公開する場合は Tailscale / SSH トンネル + `OPENCODE_MCP_TOKEN` を併用してください。
- ブリッジのガードは**二重防御の 1 枚目**です。opencode 側の `permission` 設定（`examples/opencode.json`）も必ず設定してください。
- 可能なら専用コンテナ / VM 内で動かし、ホストの鍵や本番環境の認証情報を置かないこと。

## テスト

```bash
npm test     # test/e2e.sh
```

`test/mock-opencode.mjs`（依存ゼロのモック opencode）を起動し、**curl だけで MCP over HTTP を叩いて** 44 項目を検証します。

- v2 API 構成: initialize / tools/list / 各ツール / permission 承認フロー / セッション無し時 400 応答
- `--legacy` 構成: `/api/shell` と `prompt_async` を 404 にして、旧 API への自動フォールバックを検証

```text
===================================
 passed: 44   failed: 0
===================================
```

実物の opencode に対する疎通確認は `bash test/smoke-real.sh`（`opencode serve` が起動している必要あり）。

## ライセンス

MIT
