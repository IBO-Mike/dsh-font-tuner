// dsh-font-tuner — 浏览器半（客户端插件）
//
// 作用：把 dsh GUI（桌面端内嵌的就是同一份 Web GUI，端口 127.0.0.1:19387）的
// 字体族换成主人想要的字体。原理是覆盖宿主 ui-theme 定义的字体 CSS 变量，
// 而不是去改 app.asar 里的构建产物（那样会撞 asar 完整性校验、升级即失效）。
//
// 覆盖面（变量 → 影响范围）：
//   --dsw-font-family      界面正文 + 大多数 markdown 排版（宿主默认 :root 定义）
//   --dsw-font-prose       长文正文（仅 dsh-claude-style 皮肤消费）
//   --dsw-font-serif       标题衬线（仅 dsh-claude-style 皮肤消费）
//   --ds-font-family-code  代码块 / 编辑器 / CodeMirror
//   --dsw-font-mono        终端与代码块回退栈
//   --dsh-font-mono        第三方皮肤用的 mono 回退栈
//
// 级联说明：宿主把 --dsw-font-family、--ds-font-family-code 定义在 :root，
// 皮肤 dsh-claude-style 把 --dsw-font-family/--dsw-font-prose/--dsw-font-serif
// 定义在 body[data-dsh-claude-style]（选择器更具体）。所以这里用 !important
// 声明自定义属性——important 声明跨特异性胜出，一次覆盖两条来源。
//
// 外部字体文件：宿主半把 ~/.dsh/dsh-font-tuner/fonts/ 挂在 /dsh-font-tuner/fonts/ 下，
// 卡片里一键生成 @font-face 贴进「自定义 CSS」，系统没装的字体也能用。
//
// 配置持久化在 localStorage（键 dsh-font-tuner/fonts/v1），只写本机渲染进程存储。
window.__ModuleLoader__.load({
  id: 'dsh-font-tuner',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { createElement: h, useState, useEffect } = React;

    const STYLE_ID = 'dsh-font-tuner/fonts.css';
    const STORE_KEY = 'dsh-font-tuner/fonts/v1';
    const FILES_URL = '/dsh-font-tuner/files.json';
    const CONFIG_URL = '/dsh-font-tuner/config.json';
    const FONTS_URL_PREFIX = '/dsh-font-tuner/fonts/';

    /** 默认配置 = 全空 = 一条声明都不发，装完对现有观感零影响（皮肤照常）。
     *  想改字体时再往输入框里填栈。 */
    const DEFAULTS = { ui: '', prose: '', code: '', custom: '' };

    /** 宿主原值（ui-theme base.css 的 :root），只用来做输入框占位提示。 */
    const HOST_DEFAULTS = {
      ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
      code: '"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei", monospace',
    };

    /** 配置字段顺序（脏检测、读写都按它走）。 */
    const KEYS = ['ui', 'prose', 'code', 'custom'];

    /** 从 localStorage 读“主人保存过的”配置。
     *  只有**非空**字段才算保存过——空字段视为“不覆盖”，继续吃配置文件兜底。 */
    function readStored() {
      const out = { values: { ui: '', prose: '', code: '', custom: '' }, present: {} };
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (!raw) return out;
        const parsed = JSON.parse(raw);
        for (const k of KEYS) {
          if (typeof parsed[k] === 'string' && parsed[k] !== '') {
            out.values[k] = parsed[k];
            out.present[k] = true;
          }
        }
      } catch (err) {
        /* 配置坏了就退回默认，别把 GUI 拖崩 */
      }
      return out;
    }

    /** 合并：localStorage 里保存过的字段优先，其余用宿主配置文件（config.json）兜底。 */
    function mergeWithFile(file) {
      const stored = readStored();
      const out = {};
      for (const k of KEYS) {
        if (stored.present[k]) out[k] = stored.values[k];
        else out[k] = file && typeof file[k] === 'string' ? file[k] : '';
      }
      return out;
    }

    /** 写配置（写进 localStorage 即视为“保存过”，此后不再被配置文件覆盖）。 */
    function writeConfig(fonts) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(fonts));
      } catch (err) {
        /* 隐私模式之类写不进去就算了，本次会话仍然生效 */
      }
    }

    /** 当前生效配置 + 版本号（配置变化时通知卡片刷新）。 */
    let current = { ui: '', prose: '', code: '', custom: '' };
    let fileConfig = null;
    let configRev = 0;
    const configWaiters = new Set();

    /** 换一份生效配置：写 DOM + 通知卡片。 */
    function publish(next) {
      current = next;
      configRev += 1;
      applyFonts(current);
      for (const notify of configWaiters) notify(configRev);
    }

    /** 清掉 localStorage 里保存过的字段，让配置文件兜底重新生效。 */
    function resetStorage() {
      try {
        window.localStorage.removeItem(STORE_KEY);
      } catch (err) {
        /* 删不掉就只影响持久化 */
      }
      publish(mergeWithFile(fileConfig));
    }

    /** 清掉能破坏 CSS 声明的字符，允许留引号和逗号。 */
    function sanitize(stack) {
      return String(stack).replace(/[{}<>;\\]/g, ' ').trim();
    }

    /** 生成覆盖样式表。
     *  空值 = 整条声明略过（保持宿主/皮肤原样，不多管闲事）；
     *  写 @ui = 跟随界面字体；custom 原样追加（@font-face 等自备内容）。
     *
     *  为什么要覆盖「皮肤别名」：dsh-claude-style 把长文的实际字体存在自己的
     *  --dsh-claude-font-prose / --dsh-claude-font-serif 里（宿主全局对
     *  --dsw-font-prose / --dsw-font-serif 的 var() 引用数是 0），而且它还会用
     *  body[data-dsh-claude-style][data-dsh-claude-typeface=claude] 这段更高特异性
     *  的规则重新声明 --dsw-font-family。所以这里连同别名一起压，选择器也带上
     *  html 与 typeface 分支——两边都盖住，不留斑驳。 */
    function buildCss(fonts) {
      const ui = sanitize(fonts.ui);
      const prose = sanitize(fonts.prose);
      const code = sanitize(fonts.code);
      const custom = typeof fonts.custom === 'string' ? fonts.custom.trim() : '';
      const proseStack = prose === '@ui' ? ui : prose;
      const codeStack = code === '@ui' ? ui : code;
      const lines = [];
      if (ui) {
        lines.push(`--dsw-font-family: ${ui} !important;`);
      }
      if (proseStack) {
        lines.push(`--dsw-font-prose: ${proseStack} !important;`);
        lines.push(`--dsw-font-serif: ${proseStack} !important;`);
        lines.push(`--dsh-claude-font-prose: ${proseStack} !important;`);
        lines.push(`--dsh-claude-font-serif: ${proseStack} !important;`);
      }
      if (codeStack) {
        lines.push(`--ds-font-family-code: ${codeStack} !important;`);
        lines.push(`--dsw-font-mono: ${codeStack} !important;`);
        lines.push(`--dsh-font-mono: ${codeStack} !important;`);
        lines.push(`--dsh-claude-font-code: ${codeStack} !important;`);
      }
      const varBlock = lines.length === 0
        ? '/* 未覆盖任何字体变量 */'
        : `html,\n:root,\nbody,\nbody[data-dsh-claude-style],\nbody[data-dsh-claude-style][data-dsh-claude-typeface=claude],\nbody[data-dsh-claude-style][data-dsh-claude-typeface=host] {\n  ${lines.join('\n  ')}\n}`;
      return `/* dsh-font-tuner */\n${varBlock}\n${custom ? `\n${custom}\n` : ''}`;
    }

    /** 落盘到 DOM：一个 style 标签，反复覆写内容，不叠加。 */
    function applyFonts(fonts) {
      if (typeof document === 'undefined') return;
      let tag = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
      if (!tag) {
        tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-font-tuner';
        tag.dataset.pluginCss = STYLE_ID;
        document.head.appendChild(tag);
      }
      tag.textContent = buildCss(fonts);
    }

    /** 单个字体文件的 @font-face 片段（family 默认取文件名去扩展名，可自行改）。 */
    function faceSnippet(file, family) {
      const name = family || file.replace(/\.[^.]+$/, '');
      return `@font-face {\n  font-family: '${name}';\n  src: url('${FONTS_URL_PREFIX}${encodeURIComponent(file)}');\n  font-display: swap;\n}`;
    }

    // ---- 设置卡片样式（类名 dsft- 前缀，不碰宿主内部类名）----
    const CSS_ID = 'dsh-font-tuner/settings-card.css';
    const CSS_TEXT = [
      '.dsft-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
      '.dsft-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.dsft-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dsft-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.dsft-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsft-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.dsft-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.dsft-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.dsft-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      '.dsft-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      '.dsft-chevronOpen{transform:rotate(180deg)}',
      '.dsft-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.dsft-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.dsft-field+.dsft-field{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsft-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}',
      '.dsft-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}',
      '.dsft-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.dsft-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      '.dsft-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 6px}',
      '.dsft-files{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}',
      '.dsft-file{justify-content:space-between;align-items:center;gap:8px;display:flex}',
      '.dsft-fileRow{min-width:0;color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;line-height:1.5;word-break:break-all}',
      '.dsft-insert{appearance:none;font:inherit;white-space:nowrap;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;flex:none;padding:2px 10px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:0 0}',
      '.dsft-insert:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dsft-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.dsft-status{min-width:0;flex:1;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dsft-discard,.dsft-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
      '.dsft-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
      '.dsft-discard:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dsft-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.dsft-discard:focus-visible,.dsft-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('');
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-font-tuner';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
    }

    const chevronIcon = h('svg', {
      width: 14,
      height: 14,
      viewBox: '0 0 14 14',
      fill: 'none',
      'aria-hidden': true,
    }, h('path', {
      d: 'M3.5 5.5 7 9l3.5-3.5',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }));

    /** 一行字段（label + 控件 + hint）。 */
    function field(label, control, hint) {
      return h('div', { className: 'dsft-field' },
        h('label', { className: 'dsft-label', htmlFor: control.props.id }, label),
        control,
        hint ? h('p', { className: 'dsft-hint' }, hint) : null);
    }

    /** 设置卡片：四个输入框 + 外部字体文件清单，改动即时预览，保存才落 localStorage。 */
    function makeCard() {
      function FontCard() {
        const [open, setOpen] = useState(false);
        const [saved, setSaved] = useState(() => Object.assign({}, current));
        const [draft, setDraft] = useState(() => Object.assign({}, current));
        const [files, setFiles] = useState(null); // null = 还没问过宿主
        const [dir, setDir] = useState('~/.dsh/dsh-font-tuner/fonts');
        const [rev, setRev] = useState(configRev);
        const dirty = KEYS.some((k) => draft[k] !== saved[k]);

        // 宿主 config.json 可能比卡片晚到：到货且主人还没改过，就把框里的值同步过去。
        useEffect(() => {
          const notify = (next) => setRev(next);
          configWaiters.add(notify);
          return () => { configWaiters.delete(notify); };
        }, []);
        useEffect(() => {
          if (dirty) return;
          setSaved(Object.assign({}, current));
          setDraft(Object.assign({}, current));
        }, [rev]);

        // 展开时才去问宿主有哪些字体文件；没展开不打请求。
        useEffect(() => {
          if (!open || files !== null) return undefined;
          let alive = true;
          fetch(FILES_URL)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('status ' + r.status))))
            .then((data) => {
              if (!alive) return;
              setFiles(Array.isArray(data && data.files) ? data.files : []);
              if (data && typeof data.dir === 'string' && data.dir) setDir(data.dir);
            })
            .catch(() => { if (alive) setFiles([]); });
          return () => { alive = false; };
        }, [open, files]);

        function edit(key, value) {
          const next = Object.assign({}, draft, { [key]: value });
          setDraft(next);
          applyFonts(next); // 即时预览
        }

        function insertFace(file, family) {
          const snippet = faceSnippet(file, family);
          const prev = draft.custom.trim();
          edit('custom', prev ? `${prev}\n\n${snippet}` : snippet);
        }

        function save() {
          writeConfig(draft);
          setSaved(draft);
          applyFonts(draft);
        }

        function reset() {
          resetStorage(); // 清掉本地保存 + 按配置文件兜底重算 + 写 DOM
          setSaved(Object.assign({}, current));
          setDraft(Object.assign({}, current));
        }

        return h('li', { className: 'dsft-card' + (open ? ' dsft-cardOpen' : '') },
          h('button', {
            type: 'button',
            className: 'dsft-header',
            'aria-expanded': open,
            'aria-label': (open ? '收起' : '展开') + '字体调整设置',
            onClick: () => setOpen(!open),
          },
            h('span', { className: 'dsft-headText' },
              h('span', { className: 'dsft-name' }, '字体调整'),
              h('span', { className: 'dsft-description' }, '改界面正文、长文与代码/终端三套字体栈，支持外部字体文件与宿主 config.json 兜底（CSS 变量覆盖，不动 app.asar）。')),
            dirty ? h('span', { className: 'dsft-pending' }, '未保存') : null,
            h('span', { className: 'dsft-chevron' + (open ? ' dsft-chevronOpen' : '') }, chevronIcon)),
          open ? h('div', { className: 'dsft-body' },
            field('界面与正文（--dsw-font-family）',
              h('textarea', {
                id: 'dsft-ui',
                className: 'dsft-input',
                rows: 3,
                value: draft.ui,
                placeholder: HOST_DEFAULTS.ui,
                onChange: (e) => edit('ui', e.target.value),
              }),
              '留空 = 不动（宿主／皮肤原样）。CSS 字体栈，逗号分隔，靠前的优先；中文建议把 "PingFang SC" / "HarmonyOS Sans SC" / "LXGW WenKai" 放在西文字体之后。'),
            field('长文正文（--dsw-font-prose / --dsw-font-serif）',
              h('textarea', {
                id: 'dsft-prose',
                className: 'dsft-input',
                rows: 3,
                value: draft.prose,
                placeholder: '留空 = 不动；@ui = 跟随界面字体',
                onChange: (e) => edit('prose', e.target.value),
              }),
              '只对消费这两个变量的皮肤（如 dsh-claude-style 的长文/标题）生效；宿主原生界面只用界面字体。留空则保留皮肤自己的衬线正文。'),
            field('代码与终端（--ds-font-family-code / --dsw-font-mono）',
              h('textarea', {
                id: 'dsft-code',
                className: 'dsft-input',
                rows: 3,
                value: draft.code,
                placeholder: HOST_DEFAULTS.code,
                onChange: (e) => edit('code', e.target.value),
              }),
              '代码块、编辑器、终端走这条链：--ds-font-family-code → --dsw-font-markdown-code*-font-family → --dsl-terminal-font。'),
            field('自定义 CSS（@font-face 等，原样注入）',
              h('textarea', {
                id: 'dsft-custom',
                className: 'dsft-input',
                rows: 6,
                value: draft.custom,
                placeholder: "@font-face {\n  font-family: 'Maple Mono';\n  src: url('/dsh-font-tuner/fonts/MapleMono-Regular.ttf');\n  font-display: swap;\n}",
                onChange: (e) => edit('custom', e.target.value),
              }),
              '字体文件放进 ' + dir + '（宿主半启动时自动创建该目录），下面清单会列出来。插入 @font-face 后，别忘了把字体名填进上面的字体栈。'),
            h('div', { className: 'dsft-field' },
              h('span', { className: 'dsft-label' }, '可用的外部字体文件'),
              files === null
                ? h('p', { className: 'dsft-hint' }, '读取中…')
                : files.length === 0
                  ? h('p', { className: 'dsft-hint' }, '目录里还没有字体文件（.ttf/.otf/.ttc/.woff/.woff2）。把下载的字体丢进去，重开卡片即可看到。')
                  : h('ul', { className: 'dsft-files' }, files.map((f) => h('li', { className: 'dsft-file', key: f.file },
                    h('span', { className: 'dsft-fileRow' },
                      f.file,
                      ' ',
                      h('span', { className: 'dsft-code' }, Math.max(1, Math.round((f.size || 0) / 1024)) + ' KB')),
                    h('button', {
                      type: 'button',
                      className: 'dsft-insert',
                      onClick: () => insertFace(f.file, f.family),
                    }, '插入 @font-face'))))),
            h('div', { className: 'dsft-footer' },
              h('p', { className: 'dsft-status', role: 'status' },
                dirty
                  ? '改动已即时预览，保存后刷新也保留。'
                  : KEYS.some((k) => readStored().present[k])
                    ? '当前：使用你保存过的设置（localStorage）。留空字段吃 config.json 兜底。'
                    : KEYS.some((k) => current[k])
                      ? '当前：来自宿主 ~/.dsh/dsh-font-tuner/config.json。'
                      : '未覆盖任何字体（留空即不动）。'),
              h('button', { type: 'button', className: 'dsft-discard', onClick: reset }, '恢复默认'),
              h('button', { type: 'button', className: 'dsft-save', disabled: !dirty, onClick: save }, '保存')),
          ) : null,
        );
      }
      return FontCard;
    }

    // 插件加载即应用配置：localStorage 里保存过的**非空**字段优先，其余用宿主 config.json 兜底。
    // 配置文件异步到货，所以先按本地应用一次，到货后再合并一次。
    function boot() {
      publish(mergeWithFile(null));
      fetch(CONFIG_URL)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('status ' + r.status))))
        .then((data) => {
          fileConfig = data && typeof data.config === 'object' && data.config !== null ? data.config : null;
          publish(mergeWithFile(fileConfig));
        })
        .catch(() => { /* 宿主半没起来就只吃 localStorage */ });
    }
    boot();

    exports.name = 'dsh-font-tuner';
    exports.inject = ['slots'];

    exports.apply = function apply(ctx) {
      const slots = ctx.get('slots');
      if (!slots) return;
      const Card = makeCard();
      ctx.slots.inject('settings.plugin.item', () => slots.register({
        name: 'settings.plugin.item',
        key: 'dsh-font-tuner',
        id: 'dsh-font-tuner-settings',
        order: 160,
        label: () => '字体调整',
      }, Card));
    };

    return module.exports;
  },
});
