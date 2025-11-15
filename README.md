# Tabminal

Tabminal 是一個使用 Node.js、xterm.js 與 node-pty 打造的極簡網頁終端服務。後端僅啟動單一持久化的終端行程，瀏覽器端可以全螢幕佔據視窗，並支援自動重連、狀態提示與等比例縮放，確保刷新頁面後依然接續同一個 session。

## 功能特點

- 🎯 **單一持久終端**：伺服器啟動時建立一個 node-pty 行程，任何瀏覽器連線都會接管同一個終端，刷新頁面不會重置環境。
- ⚡ **低延遲串流**：WebSocket 直接雙向傳輸輸入/輸出資料，瀏覽器端利用 xterm.js 呈現即時結果。
- 🪟 **自適應視窗**：終端佔滿整個瀏覽器可視區域，透過 `ResizeObserver` 與 xterm fit addon 自動調整列數與行數。
- 🔄 **自動重連**：網路斷線或瀏覽器暫時睡眠後會於漸進式退避時間內自動重連，並重新套用終端尺寸。
- 🧠 **輸出快取**：伺服器保存最近的輸出，新的瀏覽器連線會先重播快取內容再持續串流。
- 📋 **健康檢查**：`/healthz` 端點可作為監控探針。

## 快速開始

```bash
npm install
npm run dev
```

預設伺服器會在 `http://localhost:8080` 提供服務。`dev` 指令會使用 `node --watch` 以便於開發；若要以 production 模式啟動，請使用 `npm start`。

### 必要條件

- Node.js 18.18 或更新版本。
- macOS / Linux 預設使用 `$SHELL`，Windows 則使用 `COMSPEC`（可自訂）。

### 常用環境變數

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 監聽埠 |
| `HOST` | `0.0.0.0` | 綁定的位址 |
| `TABMINAL_CWD` | 目前工作目錄 | 啟動終端的初始目錄 |
| `TABMINAL_HISTORY` | `1048576` | 伺服器端輸出快取上限（字元） |
| `TABMINAL_COLS` / `TABMINAL_ROWS` | `120` / `30` | 伺服器啟動時的預設終端尺寸 |
| `TABMINAL_HEARTBEAT` | `30000` | WebSocket ping 週期（毫秒） |

## 測試

```bash
npm test
```

測試使用 Vitest，並以虛擬的 pty/WS 實作驗證緩衝、寫入與尺寸調整的行為。若要持續開發可執行 `npm run test:watch`。

## 專案結構

```text
src/
  server.mjs              # HTTP + WebSocket 入口
  terminal-session.mjs    # 封裝持久終端 session 與客戶端協定
public/
  index.html              # xterm.js UI & 入口頁
  app.js                  # 前端邏輯：重連、調整、狀態顯示
  styles.css              # 全螢幕終端樣式
```

## 未來可以擴充的方向

1. 多使用者／多 session 支援，以 token 區分不同 pty。
2. 加入存取控制與 TLS 佈署腳本。
3. 在伺服器端記錄審核日誌或操作歷史。

歡迎依需求調整設定或整合部署工具（systemd、Docker 等）。
