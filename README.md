# @ibo-mike/dsh-font-tuner

DeepSeek Harness（dsh）桌面端／Web GUI 的**字体族**调整插件。桌面端内嵌的就是同一份 Web GUI（`http://127.0.0.1:19387`），所以装一次两边都生效。

## 它改的是什么

宿主 ui-theme 把字体定义成 CSS 变量，插件用 `!important` 覆盖这些变量：

| 变量 | 影响范围 | 宿主原值来源 |
| --- | --- | --- |
| `--dsw-font-family` | 界面正文 + 大部分 markdown 排版（131 处引用） | `ui-theme/src/styles/base.css` 的 `:root` |
| `--dsw-font-prose` / `--dsw-font-serif` | 长文正文 / 衬线标题（只对消费这两个变量的皮肤生效，如 dsh-claude-style） | 皮肤 `body[data-dsh-claude-style]` |
| `--ds-font-family-code` | 代码块、编辑器、CodeMirror（63 处引用） | 同上 `:root` |
| `--dsw-font-mono` / `--dsh-font-mono` | 代码／终端回退栈 | 同上 |

代码字体是链式继承的，改一处全通：
`--ds-font-family-code` → `--dsw-font-markdown-code-font-family` / `--dsw-font-markdown-code-block-font-family` → `--dsl-terminal-font` / `--dsl-code-block-content-font`。

为什么用 `!important`：宿主把变量定义在 `:root`，而 dsh-claude-style 这类皮肤把它定义在 `body[data-dsh-claude-style]`（选择器更具体）。important 声明跨特异性胜出，一次覆盖两条来源。

## 安装

推荐用插件管理器（会同时写 profile 的 `package.json` 依赖与 `dsh.profile.bundles`，以及 node_modules 链接）：

```
plugin_manager install_bundle → target: <本插件目录绝对路径>
```

从 GitHub 安装（推荐）：

```
plugin_manager install_bundle → target: github:IBO-Mike/dsh-font-tuner
```

手工三步（等价）：

1. 在 `$DSH_HOME/profiles/desktop/package.json` 的 `dependencies` 加
   `"@ibo-mike/dsh-font-tuner": "github:IBO-Mike/dsh-font-tuner"`，并在 `dsh.profile.bundles` 里加一行 `"@ibo-mike/dsh-font-tuner"`。
2. 在该目录跑 `pnpm install`（pnpm 随 App 自带：`.../Resources/app/runtime/pnpm/bin/pnpm.cjs`）。
3. 刷新 GUI；profile 是 `patchReload: live`，不行就重启 App。

本地开发也可以用 `file:<本插件目录绝对路径>` 代替 GitHub 地址。

卸载：用插件管理器移除本 bundle，或从 profile 的 `package.json` 里删掉依赖与 bundles 行再 `pnpm install`。

## 使用

设置 → 插件 → 「字体调整」卡片，四个输入框（**默认全空 = 一条声明都不发，装完观感零变化**）：

- **界面与正文**：如 `"PingFang SC", "HarmonyOS Sans SC", -apple-system, sans-serif`
- **长文正文**：留空 = 不动（保留皮肤自带衬线）；填 `@ui` = 跟随界面字体
- **代码与终端**：如 `"JetBrains Mono", "SF Mono", Menlo, monospace`
- **自定义 CSS（@font-face 等）**：原样注入，用来注册外部字体文件

改动即时预览，「保存」写入 `localStorage['dsh-font-tuner/fonts/v1']`，「恢复默认」删掉本地保存、回到 `config.json` 兜底（也没有就是宿主原样）。输入框空着时占位符显示宿主原值，方便对着改。字体栈里的 `; { } < >` 会被清洗，避免插进 CSS 声明外面（自定义 CSS 原样保留，由使用者负责）。

### 配置优先级

`~/.dsh/dsh-font-tuner/config.json` 是**兜底默认**，可以直接被别的东西（脚本、同步、迁移）预先写好：

```
localStorage 里保存过的**非空**字段  >  config.json 的字段  >  宿主原值（不覆盖）
```

空字段 = 不覆盖，所以保存过一次并不会让 config.json 失效；只有填了值的字段才算“我改过”。

```json
{
  "ui": "\"Shanggu Sans SC\", \"PingFang SC\", sans-serif",
  "prose": "\"Shanggu Serif SC\", Georgia, serif",
  "code": "\"JetBrains Mono\", \"SF Mono\", Menlo, monospace",
  "custom": "@font-face { ... }"
}
```

改完刷新 GUI 即可（宿主每请求现读，不用重启）。未知键会被丢弃，坏 JSON 会被忽略并在宿主日志里 warn。

## 外部字体文件（系统里没装的）

宿主半把 `~/.dsh/dsh-font-tuner/`（字体目录可用 `DSH_FONT_TUNER_DIR` 覆盖）挂成三条只读路由：

```
GET /dsh-font-tuner/files.json      → { dir, files: [{ file, size, family }] }
GET /dsh-font-tuner/config.json     → { path, config }
GET /dsh-font-tuner/fonts/<文件名>   → 字体字节（白名单扩展名，禁路径穿越）
```

用法：把 `.ttf/.otf/.ttc/.woff/.woff2` 丢进 `~/.dsh/dsh-font-tuner/fonts/` → 卡片里「可用的外部字体文件」会列出来 → 点「插入 @font-face」自动生成并填进自定义 CSS → 把生成的字体名写进对应字体栈 → 保存。

## 限制

- 只改字体族，字号仍走宿主自带的设置（ui-theme 的 `fontSize`，范围 10–22）。
- `--dsw-font-family-brand`（品牌字 Montserrat）没覆盖：改它会影响 logo 字形。
- 字体名写错不会报错，浏览器会静默掉到栈里的下一档。
- 桌面端的欢迎／登录窗口（`Resources/app/renderer/welcome.css`）是独立页面、不加载客户端插件，覆盖不到；要改得动 App 包内那个文件（升级会被还原）。
- 不动 `app.asar`：直接改构建产物会撞 Electron 的 asar 完整性哈希，且每次升级失效。
