// dsh-font-tuner — 宿主半
//
// 干两件事：把「字体文件目录」和「配置文件」通过 HTTP 喂给 GUI。
//
//   GET /dsh-font-tuner/files.json          → { dir, files: [{ file, size, family }] }
//   GET /dsh-font-tuner/fonts/<文件名>       → 字体字节（只认白名单扩展名，禁路径穿越）
//   GET /dsh-font-tuner/config.json         → 配置文件内容（字体栈兜底默认）
//
// 根目录：$DSH_FONT_TUNER_DIR 的父目录，默认 ~/.dsh/dsh-font-tuner/
//   ├─ fonts/        放字体文件（启动时自动建）
//   └─ config.json   可选：{ ui, prose, code, custom }，只取字符串字段
// 只读、只发 GET/HEAD，不接受任何写入。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';

export const name = 'dsh-font-tuner';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/dsh-font-tuner';
const FONT_DIR = process.env.DSH_FONT_TUNER_DIR || join(homedir(), '.dsh', 'dsh-font-tuner', 'fonts');
const CONFIG_FILE = join(dirname(FONT_DIR), 'config.json');

/** 配置文件里合法且会被采纳的字段。 */
const CONFIG_KEYS = ['ui', 'prose', 'code', 'custom'];

/** 允许的字体扩展名 → Content-Type。 */
const MIME = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.otc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** 列目录：只回可用字体文件，family 用文件名（去扩展名）当默认名。 */
function listFonts() {
  try {
    if (!existsSync(FONT_DIR)) return [];
    return readdirSync(FONT_DIR)
      .filter((file) => !file.startsWith('.') && MIME[extname(file).toLowerCase()] !== undefined)
      .map((file) => {
        let size = 0;
        try {
          size = statSync(join(FONT_DIR, file)).size;
        } catch {
          /* 读不到大小就报 0，不影响引用 */
        }
        return { file, size, family: file.replace(/\.[^.]+$/, '') };
      })
      .sort((a, b) => a.file.localeCompare(b.file));
  } catch {
    return [];
  }
}

export function apply(ctx) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('dsh-font-tuner: webServer 不可用，字体文件路由未注册（CSS 覆盖不受影响）');
    return;
  }

  try {
    mkdirSync(FONT_DIR, { recursive: true });
  } catch {
    /* 建不出来就在 files.json 里如实回空列表 */
  }

  const sendJson = (res, status, value, extra = {}) => {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
      ...extra,
    });
    res.end(body);
  };

  const sendFile = (res, method, path, type) => {
    let body;
    try {
      // 每次请求现读：换字体文件不用重启宿主。
      body = readFileSync(path);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(body.byteLength),
      'cache-control': 'public, max-age=300',
    });
    res.end(method === 'HEAD' ? undefined : body);
  };

  const root = resolve(FONT_DIR);

  /** 读配置文件：只回字符串字段；文件缺失/坏掉都回 {}（配置是兜底，不该把页面搞崩）。 */
  const readConfigFile = () => {
    let raw;
    try {
      raw = readFileSync(CONFIG_FILE, 'utf8');
    } catch {
      return {};
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-font-tuner: ${CONFIG_FILE} 不是合法 JSON，已忽略（${error?.message ?? error}）`);
      return {};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const key of CONFIG_KEYS) {
      if (typeof parsed[key] === 'string') out[key] = parsed[key];
    }
    return out;
  };

  ctx.effect(() => [
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/files.json`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET, HEAD' });
          return;
        }
        sendJson(res, 200, { dir: FONT_DIR, files: listFonts() });
      },
    }),
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config.json`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET, HEAD' });
          return;
        }
        // 每请求现读：改完 config.json 刷新页面即可，不用重启宿主。
        sendJson(res, 200, { path: CONFIG_FILE, config: readConfigFile() });
      },
    }),
    webServer.register({
      kind: 'prefix',
      path: `${ROUTE_PREFIX}/fonts`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET, HEAD' });
          return;
        }
        let sub = '';
        try {
          sub = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(`${ROUTE_PREFIX}/fonts/`.length));
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        // 单层文件名：不认目录分隔符，也就没有穿越。
        if (sub === '' || sub.includes('/') || sub.includes('\\') || sub.includes('..')) {
          res.writeHead(403);
          res.end();
          return;
        }
        const type = MIME[extname(sub).toLowerCase()];
        if (type === undefined) {
          res.writeHead(415);
          res.end();
          return;
        }
        const target = join(FONT_DIR, sub);
        if (!resolve(target).startsWith(root + sep)) {
          res.writeHead(403);
          res.end();
          return;
        }
        sendFile(res, req.method, target, type);
      },
    }),
  ], 'dsh-font-tuner: 字体文件路由');
}
