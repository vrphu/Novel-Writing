
const obsidian = require('obsidian');
const { Modal, ItemView, Notice, Setting, TFile, TFolder, MarkdownView } = obsidian;

let FT = (s) => s;

let trNodeFn = null;
function setTranslator(fn, domFn) { FT = fn; if (typeof domFn === 'function') trNodeFn = domFn; }

const VIEW_SEARCH = 'nws-search';
const VIEW_MATERIALS = 'nws-materials';
const VIEW_METRICS = 'nws-metrics';
const VIEW_VERSIONS = 'nws-versions';
const VIEW_SESSIONS = 'nws-sessions';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t || Date.now()); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const timeStr = (t) => { const d = new Date(t); return dayKey(t) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const txt = (f) => String(f || '').replace(/\.md$/i, '');

/* ============ 默认设置 ============ */
const FEATURE_DEFAULTS = {
  symbolBar: true,                 // 悬浮符号栏开关
  symbolCompact: false,            // 迷你模式
  symbolPos: null,                 // {x,y} 拖动后位置
  symbolCustom: '',                // 自定义符号（连续字符串）
  versionEnabled: true,            // 自动快照
  versionMax: 30,                  // 每文件保留版本数
  versionThrottle: 5,              // 快照节流秒数
  awayThreshold: 60,               // 会话离开阈值（秒）
  sensitiveWords: '盗版,加微信,私聊,V信,最新版下载',
  targetColumn: '公众号',
};

/* ============ 工具：LCS 行级 diff ============ */
function lineDiff(a, b) {
  const A = String(a || '').split(/\r?\n/), B = String(b || '').split(/\r?\n/);
  // 超长文本降级为整段替换，避免 O(n*m) 卡死
  if (A.length * B.length > 250000) {
    return A.map((t) => ({ type: 'del', text: t })).concat(B.map((t) => ({ type: 'add', text: t })));
  }
  const n = A.length, m = B.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i++] }); }
    else { out.push({ type: 'add', text: B[j++] }); }
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}
function diffHtml(a, b) {
  return lineDiff(a, b).map((r) => '<div class="nws-diff-' + r.type + '">' + (r.type === 'add' ? '+ ' : r.type === 'del' ? '− ' : '  ') + esc(r.text) + '</div>').join('');
}

/* ============ 悬浮符号栏 ============ */
const SYMBOL_GROUPS = [
  { name: '标点', chars: ['，', '。', '？', '！', '；', '：', '、', '…', '——', '·', '「', '」', '『', '』'] },
  { name: '括号', chars: ['（', '）', '【', '】', '《', '》', '〔', '〕', '〖', '〗', '｛', '｝'] },
  { name: '引号', chars: ['“', '”', '‘', '’', '"', "'", '〝', '〞'] },
  { name: '符号', chars: ['￥', '％', '＃', '＠', '＆', '＊', '＋', '－', '＝', '／', '｜', '℃', '±', '×', '÷'] },
];

function buildSymbolBar(plugin) {
  const s = plugin.settings;
  const host = document.createElement('div');
  host.id = 'nws-symbol-bar';
  host.className = 'nws-symbar' + (s.symbolCompact ? ' compact' : '');
  const applyPos = () => {
    const p = s.symbolPos;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') {
      host.style.left = clamp(p.x, 0, Math.max(0, (window.innerWidth || 1200) - 220)) + 'px';
      host.style.top = clamp(p.y, 0, Math.max(0, (window.innerHeight || 800) - 120)) + 'px';
      host.style.bottom = 'auto';
    }
  };
  applyPos();
  const head = document.createElement('div');
  head.className = 'nws-symbar-head';
  const body = document.createElement('div');
  body.className = 'nws-symbar-body';
  
  const renderTexts = () => {
    head.innerHTML = '<span class="nws-symbar-grip">⋮⋮</span><span class="nws-symbar-title">' + FT('快捷符号') + '</span>' +
      '<button class="nws-symbar-x" data-act="min" title="' + FT('收起/展开') + '">−</button><button class="nws-symbar-x" data-act="close" title="' + FT('关闭（可在设置里重新开启）') + '">×</button>';
    const groups = SYMBOL_GROUPS.map((g) => ({ name: g.name, chars: g.chars.concat(s.symbolCustom ? Array.from(s.symbolCustom) : []) }));
    body.innerHTML = groups.map((g, i) => '<div class="nws-symgroup"><div class="nws-symlabel">' + esc(FT(g.name)) + '</div><div class="nws-symchars">' +
      g.chars.map((c) => '<button class="nws-sym" title="' + FT('插入 ') + esc(c) + '" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div></div>').join('');
  };
  renderTexts();
  host.appendChild(head);
  host.appendChild(body);
  (document.body || document.documentElement).appendChild(host);

  const insert = (ch) => {
    const v = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!v || !v.editor) { new Notice(FT('请先打开一篇正文笔记')); return; }
    try {
      v.editor.replaceSelection(ch);
      if (v.editor.focus) v.editor.focus();
    } catch (e) { new Notice(FT('插入失败：') + e.message); }
  };
  body.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('[data-c]') : null;
    if (b) insert(b.getAttribute('data-c'));
  });
  head.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('.nws-symbar-x') : null;
    if (!b) return;
    if (b.dataset && b.dataset.act === 'min') { host.classList.toggle('compact'); plugin.settings.symbolCompact = host.classList.contains('compact'); plugin.scheduleSave(); }
    else if (b.dataset && b.dataset.act === 'close') { host.style.display = 'none'; plugin.settings.symbolBar = false; plugin.saveNow(); new Notice(FT('已关闭快捷符号栏，可在设置→悬浮符号栏重新开启')); }
  });
  /* 拖拽移动 */
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('nws-symbar-x')) return;
    const r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    host.classList.add('dragging');
    try { head.setPointerCapture(e.pointerId); } catch (err) {}
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const x = clamp(e.clientX - drag.dx, 0, Math.max(0, (window.innerWidth || 1200) - drag.w - 4));
    const y = clamp(e.clientY - drag.dy, 0, Math.max(0, (window.innerHeight || 800) - 40));
    host.style.left = x + 'px'; host.style.top = y + 'px'; host.style.bottom = 'auto';
    drag.x = x; drag.y = y;
  });
  head.addEventListener('pointerup', () => {
    host.classList.remove('dragging');
    if (drag && drag.x != null) { plugin.settings.symbolPos = { x: drag.x, y: drag.y }; plugin.scheduleSave(); }
    drag = null;
  });
  return {
    refresh() {
      host.style.display = plugin.settings.symbolBar === false ? 'none' : '';
      host.classList.toggle('compact', !!plugin.settings.symbolCompact);
      applyPos();
    },
    destroy() { host.remove(); }
  };
}

/* ============ 版本历史 ============ */
function ensureVersionData(plugin) {
  plugin.data.versions = plugin.data.versions || {};
  plugin.data.drafts = plugin.data.drafts || {};
}

function pushVersion(plugin, path, content, reason) {
  if (plugin.settings.versionEnabled === false) return;
  const store = plugin.data.versions;
  const arr = store[path] || (store[path] = []);
  if (arr.length && arr[arr.length - 1].content === content) return;
  arr.push({ ts: Date.now(), content, reason: reason || '自动快照' });
  const max = clamp(Number(plugin.settings.versionMax) || 30, 3, 200);
  if (arr.length > max) arr.splice(0, arr.length - max);
  plugin.scheduleSave();
}

function setupVersions(plugin) {
  ensureVersionData(plugin);
  const timers = Object.create(null);
  const snap = async (path) => {
    delete timers[path];
    const d = plugin.data.drafts[path];
    if (!d || !d.base || d.base === d.text) return;
    const old = d.base;
    d.base = d.text; d.savedAt = Date.now();
    pushVersion(plugin, path, old, '编辑前快照');
    await plugin.saveNow();
  };
  const onEditorChange = (editor, info, view) => {
    if (plugin.settings.versionEnabled === false) return;
    let file = null;
    try { file = (view && view.file) || plugin.app.workspace.getActiveFile(); } catch (e) {}
    if (!file || !file.path || !/\.md$/i.test(file.path)) return;
    const path = file.path;
    let d = plugin.data.drafts[path];
    if (!d) d = plugin.data.drafts[path] = { text: '', base: '', ts: 0, savedAt: 0 };
    const content = editor.getValue();
    if (!d.base) { d.base = content; d.savedAt = Date.now(); }
    d.text = content; d.ts = Date.now();
    if (!timers[path]) timers[path] = setTimeout(() => snap(path), clamp(Number(plugin.settings.versionThrottle) || 5, 1, 120) * 1000);
    if (typeof plugin.noteSessionActivity === 'function') plugin.noteSessionActivity(true);
  };
  plugin.registerEvent(plugin.app.workspace.on('editor-change', onEditorChange));
  /* 手动快照命令使用 */
  const manualSnapshot = async () => {
    const f = plugin.app.workspace.getActiveFile();
    if (!f || !/\.md$/i.test(f.path)) { new Notice(FT('请先打开一个 md 笔记')); return; }
    const text = await plugin.app.vault.cachedRead(f);
    pushVersion(plugin, f.path, text, FT('手动快照'));
    await plugin.saveNow();
    new Notice(FT('已保存快照'));
  };
  /* 启动时检测比磁盘更新的草稿 */
  const checkDrafts = async () => {
    if (plugin.settings.versionEnabled === false) return;
    const drafts = plugin.data.drafts || {};
    for (const path of Object.keys(drafts)) {
      const d = drafts[path];
      if (!d || !d.text || !d.ts) continue;
      try {
        const f = plugin.app.vault.getAbstractFileByPath(path);
        if (!f || !(f instanceof TFile)) continue;
        const diskMtime = f.stat && f.stat.mtime ? f.stat.mtime : 0;
        if (d.ts <= diskMtime) continue;
        const disk = await plugin.app.vault.cachedRead(f);
        if (disk === d.text) continue;
        new DraftRecoverModal(plugin.app, plugin, path, d, disk).open();
        break; // 一次只提示一条，避免弹窗轰炸
      } catch (e) { /* 单文件失败不影响启动 */ }
    }
  };
  return { checkDrafts, manualSnapshot, pushVersion, dispose() { for (const k of Object.keys(timers)) clearTimeout(timers[k]); } };
}

class DraftRecoverModal extends Modal {
  constructor(app, plugin, path, draft, disk) { super(app); this.p = plugin; this.path = path; this.draft = draft; this.disk = disk; }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: FT('检测到未保存的草稿') });
    contentEl.createEl('p', { text: this.path + '：草稿时间比磁盘文件更新。选择恢复草稿或保留磁盘内容。' });
    const pre = contentEl.createEl('pre', { cls: 'nws-recover-diff' });
    pre.innerHTML = diffHtml(this.disk, this.draft.text);
    const row = contentEl.createDiv();
    const b1 = row.createEl('button', { text: FT('恢复草稿（覆盖磁盘）') });
    b1.addEventListener('click', async () => {
      const f = this.app.vault.getAbstractFileByPath(this.path);
      if (!f) { new Notice(FT('文件已不存在')); return; }
      pushVersion(this.p, this.path, this.disk, FT('草稿恢复前快照'));
      await this.app.vault.modify(f, this.draft.text);
      await this.p.saveNow();
      new Notice(FT('草稿已恢复')); this.close();
    });
    const b2 = row.createEl('button', { text: FT('保留磁盘内容（丢弃草稿）') });
    b2.addEventListener('click', async () => { delete this.p.data.drafts[this.path]; await this.p.saveNow(); this.close(); });
    b2.style.marginLeft = '8px';
  }
  onClose() { this.contentEl.empty(); }
}

class VersionView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.p = plugin; this.path = ''; }
  getViewType() { return VIEW_VERSIONS; }
  getDisplayText() { return FT('写作台 · 版本历史'); }
  getIcon() { return 'history'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.p;
    const files = Object.keys(p.data.versions || {}).filter((k) => (p.data.versions[k] || []).length);
    if (!this.path && files.length) this.path = files[0];
    const list = (p.data.versions[this.path] || []).slice().reverse();
    const opts = files.map((f) => '<option value="' + esc(f) + '"' + (f === this.path ? ' selected' : '') + '>' + esc(f) + '</option>').join('');
    const rows = list.map((v, i) => '<div class="nws-ver-row" data-vi="' + (list.length - 1 - i) + '">' +
      '<span class="nws-ver-time">' + esc(timeStr(v.ts)) + '</span><span class="nws-ver-reason">' + esc(v.reason || '自动快照') + '</span>' +
      '<span class="nws-ver-len">' + String(v.content || '').length + ' 字</span>' +
      '<button class="nws-btn sm" data-va="diff">对比</button><button class="nws-btn sm" data-va="rollback">回滚</button></div>').join('') || '<div class="nws-empty">暂无快照。编辑正文时会自动节流生成，也可用命令「保存当前快照」。</div>';
    const root = setView(this, '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">版本历史</div><div class="nws-sp"></div>' +
      '<button class="nws-btn" data-act="snap">手动快照</button></div>' +
      '<div class="nws-row"><select class="nws-vsel">' + opts + '</select></div></div><div class="nws-ver-list">' + rows + '</div>');
    root.querySelector('[data-act="snap"]').addEventListener('click', async () => { await p._features.versions.manualSnapshot(); this.render(); });
    const sel = root.querySelector('.nws-vsel');
    sel.addEventListener('change', () => { this.path = sel.value; this.render(); });
    root.querySelectorAll('[data-vi]').forEach((row) => row.querySelectorAll('[data-va]').forEach((b) => b.addEventListener('click', () => {
      const v = list[Number(row.getAttribute('data-vi'))];
      if (b.getAttribute('data-va') === 'diff') new VersionDiffModal(this.app, p, this.path, v).open();
      else new RollbackConfirmModal(this.app, p, this.path, v).open();
    })));
  }
}
function setView(view, html) {
  const c = view.contentEl || (view.containerEl && view.containerEl.querySelector('.view-content')) || view.containerEl;
  c.empty(); c.innerHTML = html;

  try { if (typeof trNodeFn === 'function') trNodeFn(c); } catch (e) {}
  return c;
}
class VersionDiffModal extends Modal {
  constructor(app, p, path, v) { super(app); this.p = p; this.path = path; this.v = v; }
  async onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: FT('版本对比 · ') + timeStr(this.v.ts) });
    let disk = '';
    try { const f = this.app.vault.getAbstractFileByPath(this.path); if (f) disk = await this.app.vault.cachedRead(f); } catch (e) {}
    const box = contentEl.createDiv(); box.className = 'nws-diff';
    box.innerHTML = diffHtml(this.v.content, disk);
  }
  onClose() { this.contentEl.empty(); }
}
class RollbackConfirmModal extends Modal {
  constructor(app, p, path, v) { super(app); this.p = p; this.path = path; this.v = v; }
  async onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: FT('确认回滚') });
    contentEl.createEl('p', { text: this.path + ' → ' + timeStr(this.v.ts) + ' 的版本。回滚前会先为当前内容自动再存一个快照。' });
    const btn = contentEl.createEl('button', { text: FT('确认回滚') });
    btn.addEventListener('click', async () => {
      const f = this.app.vault.getAbstractFileByPath(this.path);
      if (!f) { new Notice(FT('文件不存在')); return; }
      const cur = await this.app.vault.cachedRead(f);
      pushVersion(this.p, this.path, cur, FT('回滚前自动快照'));
      await this.app.vault.modify(f, this.v.content);
      await this.p.saveNow();
      new Notice(FT('已回滚')); this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 编辑器命令 ============ */
function activeEditor(plugin) {
  const v = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  return v && v.editor ? v.editor : null;
}
function lineRange(ed) {
  const a = ed.getCursor('from'), b = ed.getCursor('to');
  return { from: a.line, to: b.line };
}
function registerEditorCommands(plugin) {
  const add = (id, name, fn) => plugin.addCommand({ id, name, editorCallback: fn });
  const wrapSelection = (ed, left, right, ph) => {
    const sel = ed.getSelection();
    if (!sel) { ed.replaceSelection(left + (ph || '') + right); const c = ed.getCursor(); ed.setCursor({ line: c.line, ch: c.ch - right.length }); }
    else ed.replaceSelection(left + sel + right);
  };
  add('ed-toggle-mode', '编辑器：切换源码/阅读模式', () => {
    const v = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!v) { new Notice(FT('请先打开笔记')); return; }
    try {
      const src = v.currentMode && v.currentMode.type === 'source';
      v.setViewMode(src ? 'preview' : 'source');
    } catch (e) { new Notice(FT('切换失败：') + e.message); }
  });
  const gotoHeading = (dir) => {
    const ed = activeEditor(plugin); if (!ed) { new Notice(FT('请先打开笔记')); return; }
    const lines = ed.getValue().split('\n'); const cur = ed.getCursor().line;
    const test = (i) => /^\s{0,3}#{1,6}\s+/.test(lines[i] || '');
    let i = cur + dir;
    while (i >= 0 && i < lines.length && !test(i)) i += dir;
    if (i < 0 || i >= lines.length) { new Notice(dir > 0 ? FT('已是最后一个标题') : FT('已是第一个标题')); return; }
    ed.setCursor({ line: i, ch: 0 }); ed.scrollIntoView({ line: i, ch: 0 }, true);
  };
  add('ed-prev-heading', FT('编辑器：上一标题'), () => gotoHeading(-1));
  add('ed-next-heading', FT('编辑器：下一标题'), () => gotoHeading(1));
  add('ed-insert-toc', FT('编辑器：插入目录（当前文档标题）'), (ed) => {
    const lines = ed.getValue().split('\n');
    const toc = lines.map((l, i) => { const m = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(l); return m ? { lv: m[1].length, t: m[2].replace(/[#*`\[\]]/g, '').trim(), i } : null; })
      .filter(Boolean).map((h) => '  '.repeat(h.lv - 1) + '- [[#' + h.t + '|' + h.t + ']]');
    if (!toc.length) { new Notice(FT('当前文档没有标题')); return; }
    ed.replaceSelection(toc.join('\n') + '\n');
  });
  add('ed-find-replace', '编辑器：查找替换', () => plugin.app.commands.executeCommandById(plugin.manifest.id + ':find-replace'));
  add('ed-insert-table', '编辑器：插入表格', (ed) => ed.replaceSelection(FT('\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n')));
  add('ed-insert-code', '编辑器：插入代码块', (ed) => {
    const sel = ed.getSelection();
    ed.replaceSelection('\n```\n' + (sel || '') + '\n```\n');
  });
  add('ed-insert-quote', '编辑器：插入引用', (ed) => {
    const { from, to } = lineRange(ed); const lines = ed.getValue().split('\n');
    const picked = lines.slice(from, to + 1).map((l) => '> ' + l).join('\n');
    ed.replaceRange(picked, { line: from, ch: 0 }, { line: to, ch: lines[to] ? lines[to].length : 0 });
  });
  add('ed-insert-footnote', '编辑器：插入脚注', (ed) => {
    const n = (ed.getValue().match(/\[\^(\d+)\]/g) || []).length + 1;
    ed.replaceSelection('[^' + n + ']');
    const last = ed.getValue().split('\n').length;
    ed.replaceRange('\n[^' + n + ']: 注释内容\n', { line: last, ch: 0 });
  });
  add('ed-insert-task', '编辑器：插入待办', (ed) => ed.replaceSelection('- [ ] '));
  add('ed-insert-image', '编辑器：插入图片', (ed) => ed.replaceSelection('![[图片名.png]]'));
  add('ed-insert-math', '编辑器：插入公式', (ed) => ed.replaceSelection('\n$$\n' + (ed.getSelection() || 'E = mc^2') + '\n$$\n'));
  add('ed-insert-hr', '编辑器：插入分隔线', (ed) => ed.replaceSelection('\n---\n'));
  add('ed-bold', '编辑器：加粗', (ed) => wrapSelection(ed, '**', '**', '粗体'));
  add('ed-italic', '编辑器：斜体', (ed) => wrapSelection(ed, '*', '*', '斜体'));
  add('ed-strike', '编辑器：删除线', (ed) => wrapSelection(ed, '~~', '~~', '删除线'));
  add('ed-sort-lines', '编辑器：选中行排序（A→Z）', (ed) => {
    const { from, to } = lineRange(ed); const lines = ed.getValue().split('\n');
    const picked = lines.slice(from, to + 1);
    if (picked.length < 2) { new Notice(FT('请选中至少两行')); return; }
    picked.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    ed.replaceRange(picked.join('\n'), { line: from, ch: 0 }, { line: to, ch: lines[to] ? lines[to].length : 0 });
  });
  add('ed-sort-lines-desc', '编辑器：选中行排序（Z→A）', (ed) => {
    const { from, to } = lineRange(ed); const lines = ed.getValue().split('\n');
    const picked = lines.slice(from, to + 1);
    if (picked.length < 2) { new Notice(FT('请选中至少两行')); return; }
    picked.sort((a, b) => b.localeCompare(a, 'zh-CN'));
    ed.replaceRange(picked.join('\n'), { line: from, ch: 0 }, { line: to, ch: lines[to] ? lines[to].length : 0 });
  });
  add('ed-word-count', '编辑器：选中文字字数统计', (ed) => {
    const s = ed.getSelection(); if (!s) { new Notice(FT('请先选中文字')); return; }
    new Notice(FT('选中 ') + s.replace(/\s/g, '').length + FT(' 字（含标点 ') + s.length + FT(' 字符）'));
  });
  add('save-snapshot', '保存当前快照（版本历史）', () => plugin._features.versions.manualSnapshot());
  add('open-versions', '打开版本历史', () => plugin.activateView(VIEW_VERSIONS));
}

/* ============ 全局搜索与标签体系 ============ */
const SEARCH_SCOPES = [
  ['all', '全部'], ['title', '标题'], ['body', '正文'], ['tags', '标签'],
  ['platform', '平台'], ['topic', '话题'], ['column', '专栏'],
];
const FILE_FLAGS = [
  ['starred', '收藏'], ['pinned', '置顶'], ['archived', '归档'], ['trashed', '回收站'],
];
function fileMeta(p, path) {
  return p.data.fileMeta[path] || (p.data.fileMeta[path] = { tags: [], platform: '', topic: '', column: '', starred: false, pinned: false, archived: false, trashed: false });
}
function hl(text, q) {
  const s = String(text == null ? '' : text);
  if (!q) return esc(s);
  const i = s.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + String(q).length)) + '</mark>' + esc(s.slice(i + String(q).length));
}
function tagChip(p, name) {
  const t = (p.data.tags || []).find((x) => x.name === name);
  return '<span class="nws-tagchip"' + (t && t.color ? ' style="--tagc:' + esc(t.color) + '"' : '') + '>' + esc(name) + '</span>';
}

class SearchView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.p = plugin; this.q = ''; this.scope = 'all'; this.flag = ''; this.sel = {}; }
  getViewType() { return VIEW_SEARCH; }
  getDisplayText() { return FT('写作台 · 全局搜索'); }
  getIcon() { return 'search'; }
  async onOpen() { this.render(); }
  async results() {
    const p = this.p, out = [];
    const files = p.app.vault.getMarkdownFiles ? p.app.vault.getMarkdownFiles() : [];
    for (const f of files) {
      const m = p.data.fileMeta[f.path] || {};
      if (this.flag && !m[this.flag]) continue;
      let content = '';
      try { content = await p.app.vault.cachedRead(f); } catch (e) {}
      const fields = {
        title: f.basename || txt(f.path), body: content,
        tags: (m.tags || []).join(' '), platform: m.platform || '', topic: m.topic || '', column: m.column || '',
      };
      const hay = this.scope === 'all' ? Object.keys(fields).map((k) => fields[k]).join(' ') : (fields[this.scope] || '');
      if (this.q && String(hay).toLowerCase().indexOf(this.q.toLowerCase()) < 0) continue;
      let line = '', ln = 0;
      if (this.q) {
        const lines = content.split('\n');
        const i = lines.findIndex((l) => l.toLowerCase().indexOf(this.q.toLowerCase()) >= 0);
        if (i >= 0) { line = lines[i].trim().slice(0, 160); ln = i + 1; }
      }
      out.push({ path: f.path, meta: m, snippet: line || content.replace(/[#>*`\[\]]/g, '').trim().slice(0, 120), line: ln });
    }
    return out;
  }
  async render() {
    const p = this.p;
    const rows = await this.results();
    const scopes = SEARCH_SCOPES.map(([k, n]) => '<option value="' + k + '"' + (this.scope === k ? ' selected' : '') + '>' + n + '</option>').join('');
    const flags = [['', '全部']].concat(FILE_FLAGS).map(([k, n]) => '<button class="nws-fbtn ' + (this.flag === k ? 'on' : '') + '" data-fl="' + k + '">' + n + '</button>').join('');
    const tags = (p.data.tags || []).map((t) => tagChip(p, t.name) + '<button class="nws-tag-del" data-td="' + esc(t.name) + '" title="删除标签">×</button>').join('');
    const filters = (p.data.savedFilters || []).map((f) => '<button class="nws-fchip" data-sf="' + esc(f.name) + '">' + esc(f.name) + '</button>').join('');
    const cards = rows.map((r) => '<div class="nws-search-row" data-path="' + esc(r.path) + '">' +
      '<input type="checkbox" data-ck="' + esc(r.path) + '"' + (this.sel[r.path] ? ' checked' : '') + '>' +
      '<div class="nws-search-main"><div class="nws-search-title" data-open="' + esc(r.path) + '">' + hl(txt(r.path), this.q) +
      (r.meta.pinned ? ' <span title="置顶">📌</span>' : '') + (r.meta.starred ? ' <span title="收藏">★</span>' : '') + '</div>' +
      '<div class="nws-search-snip">' + (r.line ? '<span class="nws-hitline">第 ' + r.line + ' 行</span> ' : '') + hl(r.snippet, this.q) + '</div>' +
      '<div class="nws-search-meta">' + (r.meta.tags || []).map((n) => tagChip(p, n)).join('') +
      (r.meta.platform ? '<span class="nws-mini">平台:' + esc(r.meta.platform) + '</span>' : '') +
      (r.meta.topic ? '<span class="nws-mini">话题:' + esc(r.meta.topic) + '</span>' : '') +
      (r.meta.column ? '<span class="nws-mini">专栏:' + esc(r.meta.column) + '</span>' : '') +
      '<button class="nws-linkbtn" data-rel="' + esc(r.path) + '">相关文章</button></div></div></div>').join('') ||
      '<div class="nws-empty">没有命中。试试其他关键词或范围。</div>';
    const root = setView(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">全局搜索 <span class="nws-tag">' + rows.length + ' 条</span></div><div class="nws-sp"></div>' +
      '<button class="nws-btn" data-act="tags">标签管理</button><button class="nws-btn" data-act="savefilter">保存筛选</button></div>' +
      '<div class="nws-row"><input class="nws-search-input" placeholder="搜索标题 / 正文 / 标签 / 平台 / 话题 / 专栏" value="' + esc(this.q) + '">' +
      '<select class="nws-scope">' + scopes + '</select><button class="nws-btn pri" data-act="go">搜索</button></div>' +
      '<div class="nws-filters">' + flags + '</div>' +
      (filters ? '<div class="nws-savedfilters">已存筛选：' + filters + '</div>' : '') +
      '<div class="nws-bulkbar"><input class="nws-bulktag" placeholder="标签名（批量打标签）">' +
      '<button class="nws-btn sm" data-bulk="tag">打标签</button>' +
      FILE_FLAGS.map(([k, n]) => '<button class="nws-btn sm" data-bulk="' + k + '">' + n + '</button>').join('') +
      '<button class="nws-btn sm" data-bulk="untag">取消选中</button></div>' +
      (tags ? '<div class="nws-taglist">标签：' + tags + '</div>' : '') + '</div>' +
      '<div class="nws-search-list">' + cards + '</div>');

    const doGo = () => { const inp = root.querySelector('.nws-search-input'); this.q = (inp && inp.value || '').trim(); this.sel = {}; this.render(); };
    root.querySelector('[data-act="go"]').addEventListener('click', doGo);
    root.querySelector('.nws-search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doGo(); });
    root.querySelector('.nws-scope').addEventListener('change', (e) => { this.scope = e.target.value; });
    root.querySelectorAll('[data-fl]').forEach((b) => b.addEventListener('click', () => { this.flag = b.getAttribute('data-fl'); this.render(); }));
    root.querySelectorAll('[data-ck]').forEach((c) => c.addEventListener('change', () => { if (c.checked) this.sel[c.getAttribute('data-ck')] = true; else delete this.sel[c.getAttribute('data-ck')]; }));
    root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      const f = p.app.vault.getAbstractFileByPath(b.getAttribute('data-open'));
      if (f) p.app.workspace.getLeaf('tab').openFile(f);
    }));
    root.querySelectorAll('[data-rel]').forEach((b) => b.addEventListener('click', () => new RelatedModal(this.app, p, b.getAttribute('data-rel')).open()));
    root.querySelectorAll('[data-td]').forEach((b) => b.addEventListener('click', () => {
      p.data.tags = (p.data.tags || []).filter((t) => t.name !== b.getAttribute('data-td')); p.saveNow(); this.render();
    }));
    root.querySelectorAll('[data-sf]').forEach((b) => b.addEventListener('click', () => {
      const f = (p.data.savedFilters || []).find((x) => x.name === b.getAttribute('data-sf'));
      if (f) { this.q = f.q; this.scope = f.scope; this.flag = f.flag; this.render(); }
    }));
    root.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
      const paths = Object.keys(this.sel);
      if (!paths.length) { new Notice(FT('请先勾选文件')); return; }
      const act = b.getAttribute('data-bulk');
      const tagInp = root.querySelector('.nws-bulktag');
      const tag = (tagInp && tagInp.value || '').trim();
      if (act === 'untag') this.sel = {};
      else for (const path of paths) {
        const m = fileMeta(p, path);
        if (act === 'tag') { if (tag && (m.tags || []).indexOf(tag) < 0) { m.tags = m.tags || []; m.tags.push(tag); } }
        else m[act] = !m[act];
      }
      await p.saveNow(); this.render(); new Notice(FT('已处理 ') + paths.length + FT(' 个文件'));
    }));
    root.querySelector('[data-act="tags"]').addEventListener('click', () => new TagManageModal(this.app, p, () => this.render()).open());
    root.querySelector('[data-act="savefilter"]').addEventListener('click', () => new InputTextModal(this.app, '保存筛选', '筛选名称', async (name) => {
      if (!name) return;
      p.data.savedFilters.push({ name, q: this.q, scope: this.scope, flag: this.flag });
      await p.saveNow(); this.render(); new Notice(FT('筛选已保存'));
    }).open());
  }
}

class InputTextModal extends Modal {
  constructor(app, title, label, cb, def) { super(app); this.title = title; this.label = label; this.cb = cb; this.def = def || ''; }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: this.title });
    const inp = contentEl.createEl('input'); inp.value = this.def; inp.placeholder = this.label;
    const btn = contentEl.createEl('button', { text: FT('确定') });
    const go = () => { this.cb(inp.value.trim()); this.close(); };
    btn.addEventListener('click', go);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}
class TagManageModal extends Modal {
  constructor(app, p, refresh) { super(app); this.p = p; this.refresh = refresh; }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: FT('标签索引与颜色') });
    const list = contentEl.createDiv();
    const render = () => {
      list.empty();
      (this.p.data.tags || []).forEach((t) => {
        const row = list.createDiv(); row.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0';
        const inp = row.createEl('input'); inp.type = 'color'; inp.value = t.color || '#888888';
        inp.addEventListener('change', async () => { t.color = inp.value; await this.p.saveNow(); });
        row.createEl('span', { text: t.name });
        const del = row.createEl('button', { text: FT('删除') });
        del.addEventListener('click', async () => { this.p.data.tags = this.p.data.tags.filter((x) => x !== t); await this.p.saveNow(); render(); });
      });
    };
    render();
    const inp = contentEl.createEl('input'); inp.placeholder = FT('新标签名');
    const add = contentEl.createEl('button', { text: FT('新增标签') });
    add.addEventListener('click', async () => {
      const name = inp.value.trim();
      if (!name) return;
      if (!(this.p.data.tags || []).some((t) => t.name === name)) this.p.data.tags.push({ name, color: '#8a8f98' });
      await this.p.saveNow(); inp.value = ''; render();
    });
    const done = contentEl.createEl('button', { text: FT('完成') });
    done.style.marginLeft = '8px';
    done.addEventListener('click', () => { this.close(); if (this.refresh) this.refresh(); });
  }
  onClose() { this.contentEl.empty(); }
}
class RelatedModal extends Modal {
  constructor(app, p, path) { super(app); this.p = p; this.path = path; }
  async onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: FT('相关文章推荐') });
    const mine = this.p.data.fileMeta[this.path] || {};
    const base = new Set([].concat(mine.tags || [], mine.topic ? [mine.topic] : [], mine.column ? [mine.column] : []));
    if (!base.size) { contentEl.createEl('p', { text: FT('当前文件还没有标签/话题/专栏，无法计算相关度。可在全局搜索里勾选文件打标签。') }); return; }
    const scored = [];
    for (const f of (this.p.app.vault.getMarkdownFiles ? this.p.app.vault.getMarkdownFiles() : [])) {
      if (f.path === this.path) continue;
      const m = this.p.data.fileMeta[f.path] || {};
      const other = new Set([].concat(m.tags || [], m.topic ? [m.topic] : [], m.column ? [m.column] : []));
      let inter = 0; other.forEach((x) => { if (base.has(x)) inter++; });
      const union = new Set([].concat([...base], [...other])).size;
      if (inter) scored.push({ path: f.path, score: inter / union, common: [...other].filter((x) => base.has(x)) });
    }
    scored.sort((a, b) => b.score - a.score);
    const box = contentEl.createDiv();
    box.innerHTML = scored.slice(0, 5).map((s) => '<div class="nws-rel-row"><b>' + esc(txt(s.path)) + '</b> <span class="nws-mini">' + Math.round(s.score * 100) + '% · ' + esc(s.common.join('/')) + '</span></div>').join('') || '<div class="nws-empty">暂无相关文章</div>';
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 灵感池与素材库 ============ */
const MATERIAL_KINDS = ['摘录', '链接', '图片', '引用'];
const TOPIC_STATES = ['灵感', '选题', '写作中', '已完成', '归档'];
function legacyStatus(s) { return s === '待定' ? '选题' : s === '采用' ? '写作中' : s === '放弃' ? '归档' : (s || '灵感'); }

class MaterialView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.p = plugin; this.kind = '全部'; this.topicState = ''; }
  getViewType() { return VIEW_MATERIALS; }
  getDisplayText() { return FT('写作台 · 素材库'); }
  getIcon() { return 'archive'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.p;
    const mats = (p.data.materials || []).slice().reverse();
    const notes = (p.data.notes || []).slice().reverse();
    const kinds = ['全部'].concat(MATERIAL_KINDS).map((k) => '<button class="nws-fbtn ' + (this.kind === k ? 'on' : '') + '" data-mk="' + k + '">' + k + '</button>').join('');
    const shown = mats.filter((m) => this.kind === '全部' || m.kind === this.kind);
    const matRows = shown.map((m) => '<div class="nws-mat-row" data-mid="' + m.id + '">' +
      '<span class="nws-mat-kind">' + esc(m.kind) + '</span><div class="nws-mat-main"><div class="nws-mat-content">' + esc(m.content) + '</div>' +
      '<div class="nws-mini">来源：' + esc(m.source || '手动') + (m.copyright ? ' · 版权：' + esc(m.copyright) : '') + ' · ' + esc(timeStr(m.created)) + '</div></div>' +
      '<button class="nws-btn sm" data-ma="quote">引用到文章</button><button class="nws-btn sm" data-ma="edit">编辑</button><button class="nws-btn sm" data-ma="del">删</button></div>').join('') || '<div class="nws-empty">还没有素材。可新建摘录/链接/图片/引用，并记录版权备注。</div>';
    const stateBtns = TOPIC_STATES.map((s) => '<button class="nws-fbtn ' + (this.topicState === s ? 'on' : '') + '" data-ts="' + s + '">' + s + '<span class="nws-cnt">' + notes.filter((n) => legacyStatus(n.status) === s).length + '</span></button>').join('');
    const shownNotes = notes.filter((n) => !this.topicState || legacyStatus(n.status) === this.topicState);
    const topicRows = shownNotes.map((n) => '<div class="nws-topic-row"><span class="nws-mini">' + esc(legacyStatus(n.status)) + '</span> <span>' + esc(n.content.slice(0, 120)) + '</span>' +
      '<select data-ns="' + n.id + '">' + TOPIC_STATES.map((s) => '<option' + (legacyStatus(n.status) === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></div>').join('') || '<div class="nws-empty">该状态下暂无选题。</div>';
    const root = setView(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">素材库</div><div class="nws-sp"></div><button class="nws-btn pri" data-act="new">＋ 新建素材</button></div>' +
      '<div class="nws-filters">' + kinds + '</div></div><div class="nws-mat-list">' + matRows + '</div>' +
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">选题池 · 五态流转</div><div class="nws-sp"></div><button class="nws-btn" data-act="newtopic">＋ 新建选题</button></div>' +
      '<div class="nws-psub">灵感 → 选题 → 写作中 → 已完成 → 归档（与旧状态：待定/采用/放弃 自动兼容）</div>' +
      '<div class="nws-filters">' + stateBtns + '</div></div><div class="nws-topic-list">' + topicRows + '</div>');
    root.querySelector('[data-act="new"]').addEventListener('click', () => new MaterialModal(this.app, p, null, () => this.render()).open());
    root.querySelector('[data-act="newtopic"]').addEventListener('click', async () => {
      const n = await p.captureInspiration('（新选题）', ''); if (n) new InspirationEditModalShim(p, n, () => this.render());
    });
    root.querySelectorAll('[data-mk]').forEach((b) => b.addEventListener('click', () => { this.kind = b.getAttribute('data-mk'); this.render(); }));
    root.querySelectorAll('[data-ts]').forEach((b) => b.addEventListener('click', () => { this.topicState = b.getAttribute('data-ts'); this.render(); }));
    root.querySelectorAll('[data-ns]').forEach((s) => s.addEventListener('change', async () => {
      const n = p.noteById(s.getAttribute('data-ns')); if (!n) return;
      n.status = s.value; await p.saveNow(); this.render(); new Notice(FT('状态已更新：') + FT(s.value));
    }));
    root.querySelectorAll('[data-mid]').forEach((row) => row.querySelectorAll('[data-ma]').forEach((b) => b.addEventListener('click', async () => {
      const m = p.data.materials.find((x) => x.id === row.getAttribute('data-mid')); if (!m) return;
      const act = b.getAttribute('data-ma');
      if (act === 'del') { p.data.materials = p.data.materials.filter((x) => x !== m); await p.saveNow(); this.render(); }
      else if (act === 'edit') new MaterialModal(this.app, p, m, () => this.render()).open();
      else {
        const v = p.app.workspace.getActiveViewOfType(MarkdownView);
        if (!v || !v.editor) { new Notice(FT('请先打开一篇文章再引用')); return; }
        v.editor.replaceSelection('\n> ' + m.content.replace(/\n/g, '\n> ') + (m.source ? '\n> —— ' + m.source : '') + (m.copyright ? FT('（版权：') + m.copyright + '）' : '') + '\n');
        m.usedIn = m.usedIn || [];
        const f = p.app.workspace.getActiveFile(); if (f && m.usedIn.indexOf(f.path) < 0) m.usedIn.push(f.path);
        await p.saveNow(); new Notice(FT('已引用到当前文章'));
      }
    })));
  }
}
function InspirationEditModalShim(p, note, refresh) {
  /* 复用主插件的灵感编辑弹窗；若主插件未暴露则用内置修改器 */
  if (p._openInspirationEditor) p._openInspirationEditor(note, refresh);
  else new Notice(FT('选题已创建，可在「灵感」面板中编辑'));
}
class MaterialModal extends Modal {
  constructor(app, p, m, refresh) { super(app); this.p = p; this.m = m; this.refresh = refresh; }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: this.m ? FT('编辑素材') : FT('新建素材') });
    const kindSel = contentEl.createEl('select');
    kindSel.innerHTML = MATERIAL_KINDS.map((k) => '<option' + (this.m && this.m.kind === k ? ' selected' : '') + '>' + k + '</option>').join('');
    const content = contentEl.createEl('textarea'); content.placeholder = FT('素材内容 / 链接 / 图片路径'); content.rows = 5;
    if (this.m) content.value = this.m.content;
    const source = contentEl.createEl('input'); source.placeholder = FT('来源（网址/书名/作者）'); if (this.m) source.value = this.m.source || '';
    const copy = contentEl.createEl('input'); copy.placeholder = FT('版权备注（如：CC BY / 已获授权 / 个人原创）'); if (this.m) copy.value = this.m.copyright || '';
    const btn = contentEl.createEl('button', { text: FT('保存') });
    btn.addEventListener('click', async () => {
      const c = content.value.trim(); if (!c) { new Notice(FT('内容不能为空')); return; }
      if (this.m) { this.m.kind = kindSel.value; this.m.content = c; this.m.source = source.value.trim(); this.m.copyright = copy.value.trim(); }
      else this.p.data.materials.push({ id: uid(), kind: kindSel.value, content: c, source: source.value.trim(), copyright: copy.value.trim(), tags: [], created: Date.now(), usedIn: [] });
      await this.p.saveNow(); this.close(); if (this.refresh) this.refresh();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 导入导出 ============ */
const enc = new TextEncoder();
const dec = new TextDecoder();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/* 最小 ZIP（store 无压缩）写入器，用于生成不依赖第三方库的 DOCX */
function zipStore(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); lh.set(name, 30);
    chunks.push(lh, data);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); ch.set(name, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eo = new Uint8Array(22), ev = new DataView(eo.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return new Blob(chunks.concat(central, [eo]), { type: 'application/octet-stream' });
}
/* ZIP 读取（store + deflate-raw），用于导入 DOCX */
async function unzipEntries(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let i = u8.length - 22;
  while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
  if (i < 0) throw new Error('不是有效的 zip/docx 文件');
  const count = dv.getUint16(i + 10, true);
  let off = dv.getUint32(i + 16, true);
  const out = {};
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nlen));
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    const comp = u8.subarray(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
    let data = comp;
    if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压 DOCX（deflate），请改用 DOCX 另存为 MD/TXT');
      const ds = new DecompressionStream('deflate-raw');
      data = new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer());
    } else if (method !== 0) throw new Error('不支持的 DOCX 压缩方式: ' + method);
    out[name] = data;
    off += 46 + nlen + elen + clen;
  }
  return out;
}
function docxToMd(xml) {
  if (typeof DOMParser === 'undefined') return xml.replace(/<[^>]+>/g, '');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const ps = Array.from(doc.getElementsByTagName('w:p'));
  return ps.map((p) => Array.from(p.getElementsByTagName('w:t')).map((t) => t.textContent).join('')).join('\n');
}
function mdToHtml(md) {
  const lines = String(md).split(/\r?\n/);
  const out = []; let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line)) { out.push(inCode ? '</code></pre>' : '<pre><code>'); inCode = !inCode; continue; }
    if (inCode) { out.push(esc(line)); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push('<h' + h[1].length + '>' + esc(h[2]) + '</h' + h[1].length + '>'); continue; }
    if (!line.trim()) { out.push('<br>'); continue; }
    let s = esc(line);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/!?\[\[([^\]]+)\]\]/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    out.push('<p>' + s + '</p>');
  }
  if (inCode) out.push('</code></pre>');
  return '<!doctype html><html><head><meta charset="utf-8"><title>导出</title></head><body>' + out.join('\n') + '</body></html>';
}
function htmlToMd(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<\/h[1-6]>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
}
function stripMd(md) {
  return String(md).replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '')).replace(/!?\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[#>*`_~]/g, '');
}
function encryptText(text, key) {
  const a = enc.encode(text), k = enc.encode(key || 'nws'), o = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] ^ k[i % k.length];
  let s = ''; for (let i = 0; i < o.length; i++) s += String.fromCharCode(o[i]);
  return 'NWSENC1:' + btoa(s);
}
function docxBlob(content) {
  const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const REL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const paras = String(content).split(/\r?\n/).map((l) => '<w:p><w:r><w:t xml:space="preserve">' + esc(l).replace(/\t/g, '&#9;') + '</w:t></w:r></w:p>').join('');
  const DOC = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paras + '</w:body></w:document>';
  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(CT) },
    { name: '_rels/.rels', data: enc.encode(REL) },
    { name: 'word/document.xml', data: enc.encode(DOC) },
  ]);
}

class ImpExpModal extends Modal {
  constructor(app, p) { super(app); this.p = p; }
  async onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: FT('导入 / 导出') });
    const f = this.app.workspace.getActiveFile();
    contentEl.createEl('p', { text: FT('当前文件：') + (f ? f.path : '（未打开）') + '　导出目录：导出/' });
    const sec1 = contentEl.createEl('h3', { text: FT('导入到本地库') });
    const inp = contentEl.createEl('input'); inp.type = 'file'; inp.multiple = true;
    inp.accept = '.md,.txt,.html,.htm,.docx';
    const impBtn = contentEl.createEl('button', { text: FT('导入所选文件') });
    impBtn.addEventListener('click', async () => {
      if (!inp.files || !inp.files.length) { new Notice(FT('请先选择文件')); return; }
      let n = 0;
      for (const file of Array.from(inp.files)) {
        try {
          const name = file.name.replace(/\.(docx|html?|txt|md)$/i, '');
          let text = '';
          if (/\.docx$/i.test(file.name)) {
            const entries = await unzipEntries(await file.arrayBuffer());
            const xml = dec.decode(entries['word/document.xml'] || new Uint8Array());
            text = docxToMd(xml);
          } else {
            text = await file.text();
            if (/\.html?$/i.test(file.name)) text = htmlToMd(text);
          }
          await this.p.ensureFolder('导入');
          await this.app.vault.create('导入/' + name + '.md', text);
          n++;
        } catch (e) { console.error('[导入失败]', e); new Notice(FT('导入失败：') + file.name + '（' + e.message + '）'); }
      }
      if (n) new Notice(FT('已导入 ') + n + FT(' 个文件到 导入/'));
    });
    const sec2 = contentEl.createEl('h3', { text: FT('导出当前文件') });
    const fmts = contentEl.createDiv();
    const doExport = async (fmt) => {
      if (!f) { new Notice(FT('请先打开要导出的文件')); return; }
      const text = await this.app.vault.cachedRead(f);
      await this.p.ensureFolder(FT('导出'));
      const base = '导出/' + txt(f.path);
      try {
        if (fmt === 'md' || fmt === 'txt' || fmt === 'html' || fmt === 'docx') {
          const ext = fmt === 'md' ? 'md' : fmt === 'txt' ? 'txt' : fmt === 'html' ? 'html' : 'docx';
          const content = fmt === 'md' ? text : fmt === 'txt' ? stripMd(text) : fmt === 'html' ? mdToHtml(text) : docxBlob(text);
          if (ext === 'docx') await this.app.vault.createBinary(base + '.docx', await content.arrayBuffer());
          else await this.app.vault.create(base + '.' + ext, content);
          new Notice(FT('已导出：') + base + '.' + ext);
        } else if (fmt === 'pdf') {
          const w = window.open('', '_blank');
          if (!w) { new Notice(FT('浏览器拦截了打印窗口')); return; }
          w.document.write(mdToHtml(text)); w.document.close();
          setTimeout(() => { w.focus(); w.print(); }, 350);
          new Notice(FT('已打开打印预览，在对话框中选择「另存为 PDF」'));
        }
      } catch (e) { console.error(e); new Notice(FT('导出失败：') + e.message); }
    };
    [['md', 'Markdown'], ['txt', 'TXT'], ['html', 'HTML'], ['docx', 'Word(docx)'], ['pdf', 'PDF(打印)']].forEach(([k, n]) => {
      const b = fmts.createEl('button', { text: n }); b.style.margin = '0 6px 6px 0';
      b.addEventListener('click', () => doExport(k));
    });
    const sec3 = contentEl.createEl('h3', { text: FT('一键全量导出（可加密）') });
    const keyInp = contentEl.createEl('input'); keyInp.placeholder = FT('加密口令（留空则不加密）');
    const allBtn = contentEl.createEl('button', { text: FT('导出全部 md 为一个文件') });
    allBtn.addEventListener('click', async () => {
      const files = this.app.vault.getMarkdownFiles ? this.app.vault.getMarkdownFiles() : [];
      const bundle = [];
      for (const x of files) {
        try { bundle.push('\n\n===== ' + x.path + ' =====\n\n' + await this.app.vault.cachedRead(x)); } catch (e) {}
      }
      await this.p.ensureFolder('导出');
      const key = keyInp.value.trim();
      const name = '导出/全量-' + dayKey(Date.now()) + (key ? '.nwsenc' : '.md');
      const body = key ? encryptText(bundle.join(''), key) : bundle.join('');
      await this.app.vault.create(name, body);
      new Notice(FT('已导出 ') + files.length + FT(' 篇：') + name);
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 发布前检查 ============ */
const PRESET_PLATFORMS = [
  { name: '公众号', tip: '建议 1200~3000 字，段落不宜过长，封面图必需' },
  { name: '知乎', tip: '标题需明确观点，正文可分小节，引用来源需注明' },
  { name: '小红书', tip: '建议 300~800 字，开头 3 行抓人，配图与话题标签重要' },
];
function preflightChecks(p, path, text) {
  const meta = p.data.fileMeta[path] || {};
  const words = text.replace(/\s/g, '').length;
  const hasTitle = /^#{1,2}\s+\S/m.test(text) || /^title:/m.test(text);
  const tags = (text.match(/(?:^|\s)#[\u4e00-\u9fa5\w]+/g) || []).length + (meta.tags || []).length;
  const hasCover = /!\[[^\]]*\]\(|!\[\[[^\]]+\]\]/.test(text);
  const bad = (p.settings.sensitiveWords || '').split(/[,，]/).map((s) => s.trim()).filter((s) => s && text.indexOf(s) >= 0);
  const links = Array.from(text.matchAll(/\[\[([^\]|]+)/g)).map((m) => m[1]);
  const broken = links.filter((l) => !p.app.vault.getAbstractFileByPath(l.endsWith('.md') ? l : l + '.md'));
  const blankRuns = (text.match(/\n{4,}/g) || []).length;
  const fm = /^---\r?\n[\s\S]*?\r?\n---/.test(text);
  const mk = (name, level, msg) => ({ name, level, msg });
  return [
    mk(FT('字数'), words >= 300 ? 'ok' : 'warn', words + FT(' 字') + (words >= 300 ? FT('（达标）') : FT('（建议至少 300 字）'))),
    mk(FT('标题'), hasTitle ? 'ok' : 'fail', hasTitle ? FT('已检测到标题') : FT('缺少一级/二级标题或 title 元数据')),
    mk(FT('标签'), tags > 0 ? 'ok' : 'warn', tags ? FT('检测到 ') + tags + FT(' 个标签') : FT('未检测到标签，可能影响推荐')),
    mk(FT('封面'), hasCover ? 'ok' : 'warn', hasCover ? FT('已插入图片') : FT('未检测到封面图')),
    mk(FT('敏感词'), bad.length ? 'fail' : 'ok', bad.length ? FT('命中：') + bad.join('、') : FT('未命中敏感词表')),
    mk(FT('链接'), broken.length ? 'warn' : 'ok', broken.length ? FT('失效链接：') + broken.join('、') : (links.length ? links.length + FT(' 个链接均有效') : FT('无内部链接'))),
    mk(FT('排版'), blankRuns ? 'warn' : 'ok', blankRuns ? FT('存在 ') + blankRuns + FT(' 处连续空行（≥4）') : FT('无异常空行')),
    mk(FT('元数据'), fm ? 'ok' : 'warn', fm ? FT('含 frontmatter') : FT('缺少 frontmatter（标题/标签/日期/简介）')),
  ];
}
class PreflightModal extends Modal {
  constructor(app, p) { super(app); this.p = p; }
  async onOpen() {
    const { contentEl } = this; contentEl.empty();
    const f = this.app.workspace.getActiveFile();
    contentEl.createEl('h2', { text: FT('发布前检查') });
    if (!f) { contentEl.createEl('p', { text: FT('请先打开要检查的文章') }); return; }
    const text = await this.app.vault.cachedRead(f);
    contentEl.createEl('p', { text: f.path + ' · ' + text.replace(/\s/g, '').length + FT(' 字') });
    const checks = preflightChecks(this.p, f.path, text);
    const box = contentEl.createDiv();
    box.innerHTML = checks.map((c) => '<div class="nws-pre-row level-' + c.level + '"><b>' + esc(c.name) + '</b><span class="nws-pre-level">' +
      (c.level === 'ok' ? FT('通过') : c.level === 'warn' ? FT('提醒') : FT('未通过')) + '</span><span>' + esc(c.msg) + '</span></div>').join('');
    contentEl.createEl('h3', { text: FT('多平台预览与复制') });
    const sel = contentEl.createEl('select');
    sel.innerHTML = PRESET_PLATFORMS.map((x) => '<option>' + FT(x.name) + '</option>').join('');
    const tip = contentEl.createEl('p'); tip.className = 'nws-mini';
    const ta = contentEl.createEl('textarea'); ta.rows = 12; ta.style.width = '100%';
    const render = () => {
      const cur = PRESET_PLATFORMS.find((x) => x.name === sel.value) || PRESET_PLATFORMS[0];
      tip.textContent = FT(cur.tip);
      const tags = (this.p.data.fileMeta[f.path] || {}).tags || [];
      ta.value = text + '\n\n' + tags.map((t) => '#' + t).join(' ');
    };
    sel.addEventListener('change', render); render();
    const copy = contentEl.createEl('button', { text: FT('复制到剪贴板') });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(ta.value); new Notice(FT('已复制 ') + sel.value + FT(' 版本')); }
      catch (e) { ta.select(); new Notice(FT('请按 Ctrl+C 复制')); }
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 发布数据复盘 ============ */
class MetricsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.p = plugin; }
  getViewType() { return VIEW_METRICS; }
  getDisplayText() { return FT('写作台 · 发布复盘'); }
  getIcon() { return 'trending-up'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.p;
    const rows = (p.data.metrics || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const views = sum('views'), inter = sum('likes') + sum('stars') + sum('comments') + sum('shares');
    const rate = views ? (inter / views * 100).toFixed(2) : '0.00';
    const byPlat = {};
    rows.forEach((r) => { const k = r.platform || '未标注'; byPlat[k] = (byPlat[k] || 0) + (Number(r.views) || 0); });
    const plat = Object.keys(byPlat).map((k) => '<div class="nws-dist-row"><span>' + esc(k) + '</span><span class="nws-dist-bar"><i style="width:' + (views ? Math.round(byPlat[k] / views * 100) : 0) + '%"></i></span><span>' + fmtN(byPlat[k]) + '</span></div>').join('') || '<div class="nws-mini">暂无数据</div>';
    const byTopic = {};
    rows.forEach((r) => { const m = p.data.fileMeta[r.path] || {}; const k = m.topic || '未标注'; byTopic[k] = (byTopic[k] || 0) + (Number(r.views) || 0); });
    const topics = Object.keys(byTopic).sort((a, b) => byTopic[b] - byTopic[a]).slice(0, 8)
      .map((k) => '<span class="nws-tagchip">' + esc(k) + ' ' + fmtN(byTopic[k]) + '</span>').join('');
    /* 趋势折线 */
    const pts = rows.slice(-20);
    const maxV = Math.max(1, ...pts.map((r) => Number(r.views) || 0));
    const w = 680, h = 150, step = pts.length > 1 ? w / (pts.length - 1) : w;
    const poly = pts.map((r, i) => (i * step).toFixed(1) + ',' + (h - (Number(r.views) || 0) / maxV * (h - 20)).toFixed(1)).join(' ');
    const chart = pts.length ? '<svg viewBox="0 0 ' + w + ' ' + h + '" class="nws-metric-chart"><polyline points="' + poly + '" fill="none" stroke="var(--interactive-accent)" stroke-width="2"/>' +
      pts.map((r, i) => '<circle cx="' + (i * step).toFixed(1) + '" cy="' + (h - (Number(r.views) || 0) / maxV * (h - 20)).toFixed(1) + '" r="3" fill="var(--interactive-accent)"/>').join('') + '</svg>' : '<div class="nws-empty">录入数据后显示趋势</div>';
    /* 洞察 */
    const topPlat = Object.keys(byPlat).sort((a, b) => byPlat[b] - byPlat[a])[0];
    const best = rows.slice().sort((a, b) => (b.views || 0) - (a.views || 0))[0];
    const insight = rows.length
      ? '累计阅读 ' + fmtN(views) + '，互动率 ' + rate + '%。阅读量最高的平台是「' + esc(topPlat || '') + '」，表现最好的单篇是「' + esc(txt(best.path || '')) + '」（' + fmtN(best.views) + ' 阅读）。' + (Number(rate) < 3 ? ' 互动率偏低，可在文末增加明确互动引导。' : ' 互动表现良好，可复用该选题结构。')
      : '尚无发布数据。在下方录入阅读/点赞/收藏/评论/转发/收益后，自动生成趋势与洞察。';
    const table = rows.slice().reverse().map((r) => '<div class="nws-metric-row" data-mid="' + r.id + '"><span>' + esc(r.date) + '</span><span>' + esc(txt(r.path)) + '</span><span>' + esc(r.platform || '') + '</span>' +
      '<span>读 ' + fmtN(r.views) + '</span><span>赞 ' + fmtN(r.likes) + '</span><span>藏 ' + fmtN(r.stars) + '</span><span>评 ' + fmtN(r.comments) + '</span><span>转 ' + fmtN(r.shares) + '</span><span>¥' + fmtN(r.income) + '</span><button class="nws-btn sm" data-md="del">删</button></div>').join('') || '<div class="nws-empty">暂无记录</div>';
    const root = setView(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">发布数据复盘</div><div class="nws-sp"></div>' +
      '<button class="nws-btn pri" data-act="new">＋ 回填数据</button><button class="nws-btn" data-act="csv">导出 CSV</button></div>' +
      '<div class="nws-kpi-grid"><div class="nws-kpi"><div class="k">累计阅读</div><div class="v">' + fmtN(views) + '</div></div>' +
      '<div class="nws-kpi"><div class="k">累计互动</div><div class="v">' + fmtN(inter) + '</div></div>' +
      '<div class="nws-kpi"><div class="k">互动率</div><div class="v">' + rate + '%</div></div>' +
      '<div class="nws-kpi"><div class="k">累计收益</div><div class="v">¥' + fmtN(sum('income')) + '</div></div></div></div>' +
      '<div class="nws-metric-grid"><div><h3>阅读趋势</h3>' + chart + '</div><div><h3>平台分布</h3>' + plat + '<h3>话题分布</h3><div>' + topics + '</div></div></div>' +
      '<div class="nws-insight"><b>复盘洞察</b><div>' + insight + '</div></div>' +
      '<div class="nws-metric-table">' + table + '</div>');
    root.querySelector('[data-act="new"]').addEventListener('click', () => new MetricModal(this.app, p, () => this.render()).open());
    root.querySelector('[data-act="csv"]').addEventListener('click', async () => {
      const head = '日期,文章,平台,阅读,点赞,收藏,评论,转发,收益\n';
      const lines = rows.map((r) => [r.date, '"' + String(txt(r.path)).replace(/"/g, '""') + '"', r.platform, r.views, r.likes, r.stars, r.comments, r.shares, r.income].join(',')).join('\n');
      await p.ensureFolder('导出');
      const path = '导出/发布数据-' + dayKey(Date.now()) + '.csv';
      await p.app.vault.create(path, head + lines);
      new Notice(FT('已导出 ') + path);
    });
    root.querySelectorAll('[data-md]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('[data-mid]').getAttribute('data-mid');
      p.data.metrics = p.data.metrics.filter((m) => m.id !== id); await p.saveNow(); this.render();
    }));
  }
}
function fmtN(n) { return (Number(n) || 0).toLocaleString('en-US'); }
class MetricModal extends Modal {
  constructor(app, p, refresh) { super(app); this.p = p; this.refresh = refresh; }
  onOpen() {
    const { contentEl } = this; contentEl.empty();
    contentEl.createEl('h2', { text: FT('回填发布数据') });
    const f = this.app.workspace.getActiveFile();
    const mkInp = (ph, type) => { const i = contentEl.createEl('input'); i.placeholder = ph; if (type) i.type = type; return i; };
    const date = mkInp('日期 YYYY-MM-DD'); date.value = dayKey(Date.now());
    const path = mkInp('文章路径'); path.value = f ? f.path : '';
    const platform = mkInp('平台（公众号/知乎/小红书…）'); platform.value = this.p.settings.targetColumn || '公众号';
    const views = mkInp('阅读', 'number'), likes = mkInp('点赞', 'number'), stars = mkInp('收藏', 'number');
    const comments = mkInp('评论', 'number'), shares = mkInp('转发', 'number'), income = mkInp('收益（元）', 'number');
    const btn = contentEl.createEl('button', { text: FT('保存') });
    btn.addEventListener('click', async () => {
      if (!path.value.trim()) { new Notice(FT('请填写文章路径')); return; }
      this.p.data.metrics.push({
        id: uid(), date: date.value || dayKey(Date.now()), path: path.value.trim(), platform: platform.value.trim(),
        views: +views.value || 0, likes: +likes.value || 0, stars: +stars.value || 0,
        comments: +comments.value || 0, shares: +shares.value || 0, income: +income.value || 0,
      });
      await this.p.saveNow(); this.close(); if (this.refresh) this.refresh(); new Notice(FT('已回填'));
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ============ 会话统计 ============ */
function setupSession(plugin) {
  const S = { lastTick: Date.now(), lastActive: Date.now(), awayStart: 0, breaks: 0, openMs: 0, activeMs: 0, awayMs: 0 };
  const INTERVAL = 30000;
  const save = () => {
    const now = Date.now(), dt = now - S.lastTick; S.lastTick = now;
    const limit = clamp(Number(plugin.settings.awayThreshold) || 60, 10, 3600) * 1000;
    const away = (now - S.lastActive) > limit;
    if (away) {
      S.awayMs += dt;
      if (!S.awayStart) { S.awayStart = now; S.breaks++; }
    } else { S.activeMs += dt; S.awayStart = 0; }
    S.openMs += dt;
    const d = plugin.data.sessionDays[dayKey(now)] || (plugin.data.sessionDays[dayKey(now)] = { open: 0, active: 0, away: 0, breaks: 0 });
    d.open += dt; d.active += away ? 0 : dt; d.away += away ? dt : 0; d.breaks = S.breaks;
    plugin.scheduleSave();
  };
  const timer = setInterval(save, INTERVAL);
  let onVis = null;
  try {
    onVis = () => { if (typeof document !== 'undefined' && document.hidden) S.lastActive = Date.now() - 86400000; else S.lastActive = Date.now(); };
    document.addEventListener('visibilitychange', onVis);
  } catch (e) {}
  return {
    tick(typing) { if (typing) S.lastActive = Date.now(); },
    dispose() { clearInterval(timer); try { if (onVis) document.removeEventListener('visibilitychange', onVis); } catch (e) {} }
  };
}
function streakDays(daily) {
  let streak = 0;
  const d = new Date();
  for (;;) {
    const k = dayKey(d.getTime());
    const v = daily[k];
    if (v && (v.words || 0) > 0) { streak++; d.setDate(d.getDate() - 1); }
    else break;
    if (streak > 3650) break;
  }
  return streak;
}
class SessionView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.p = plugin; }
  getViewType() { return VIEW_SESSIONS; }
  getDisplayText() { return FT('写作台 · 会话统计'); }
  getIcon() { return 'activity'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.p, today = dayKey(Date.now());
    const s = p.data.sessionDays[today] || { open: 0, active: 0, away: 0, breaks: 0 };
    const d = p.data.daily[today] || {};
    const hours = d.hours || [];
    let bestH = 0; hours.forEach((v, h) => { if ((v || 0) > (hours[bestH] || 0)) bestH = h; });
    const activeH = s.active / 3600000;
    const words = d.words || 0;
    const cards = [
      ['打开时长', (s.open / 60000).toFixed(0) + ' 分'], ['有效输入', (s.active / 60000).toFixed(0) + ' 分'],
      ['离开时长', (s.away / 60000).toFixed(0) + ' 分'], ['中断次数', String(s.breaks || 0)],
      ['专注度', (s.open ? Math.round(s.active / s.open * 100) : 0) + '%'],
      ['字/时效率', activeH ? Math.round(words / activeH) + ' 字' : '0 字'],
      ['最佳时段', hours.length ? pad(bestH) + ':00–' + pad((bestH + 1) % 24) + ':00' : '暂无'],
      ['连续更新', streakDays(p.data.daily || {}) + ' 天'],
    ].map(([k, v]) => '<div class="nws-kpi"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('');
    const days = Object.keys(p.data.sessionDays).sort().slice(-7);
    const bars = days.map((k) => {
      const x = p.data.sessionDays[k];
      return '<div class="nws-sess-row"><span>' + esc(k) + '</span><span class="nws-dist-bar"><i style="width:' + (x.open ? Math.round(x.active / x.open * 100) : 0) + '%"></i></span>' +
        '<span>有效 ' + (x.active / 60000).toFixed(0) + ' 分 / 打开 ' + (x.open / 60000).toFixed(0) + ' 分 · 中断 ' + (x.breaks || 0) + '</span></div>';
    }).join('') || '<div class="nws-empty">会话数据每 30 秒累计一次，稍后刷新可见。</div>';
    const root = setView(this, '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">会话统计</div><div class="nws-sp"></div><button class="nws-btn" data-act="refresh">刷新</button></div>' +
      '<div class="nws-psub">离开超过设定阈值（设置页可改，默认 60 秒）即计入离开时长与中断次数；有效输入由正文编辑事件驱动。</div>' +
      '<div class="nws-kpi-grid">' + cards + '</div></div><h3>近 7 天专注度</h3><div class="nws-sess-list">' + bars + '</div>');
    root.querySelector('[data-act="refresh"]').addEventListener('click', () => this.render());
  }
}

/* ============ 扩展设置页 ============ */
function appendSettings(containerEl, plugin) {
  const p = plugin;
  containerEl.createEl('h3', { text: FT('悬浮符号栏') });
  new Setting(containerEl).setName('显示悬浮快捷符号栏').setDesc('可拖拽顶部手柄移动位置，点击符号插入到光标处；不影响正文内容以外的任何文件')
    .addToggle((t) => t.setValue(p.settings.symbolBar !== false).onChange(async (v) => { p.settings.symbolBar = v; if (p._features) p._features.symbar.refresh(); await p.saveNow(); }));
  new Setting(containerEl).setName('迷你模式').setDesc('只保留标题栏，点击展开')
    .addToggle((t) => t.setValue(!!p.settings.symbolCompact).onChange(async (v) => { p.settings.symbolCompact = v; if (p._features) p._features.symbar.refresh(); await p.saveNow(); }));
  new Setting(containerEl).setName('自定义符号').setDesc('追加到「标点」分组末尾，直接输入字符即可，无需分隔符')
    .addText((t) => t.setValue(p.settings.symbolCustom || '').onChange(async (v) => { p.settings.symbolCustom = v; await p.saveNow(); new Notice(FT('自定义符号已保存，重载插件后显示在新符号栏中')); }));
  new Setting(containerEl).setName('重置符号栏位置').addButton((b) => b.setButtonText('回到默认位置').onClick(async () => { p.settings.symbolPos = null; await p.saveNow(); new Notice(FT('位置已重置，重载插件后生效')); }));

  containerEl.createEl('h3', { text: FT('自动保存与版本历史') });
  new Setting(containerEl).setName('启用编辑自动快照').setDesc('编辑正文时按节流间隔自动保存快照；快照只存在插件数据里，不改动正文文件')
    .addToggle((t) => t.setValue(p.settings.versionEnabled !== false).onChange(async (v) => { p.settings.versionEnabled = v; await p.saveNow(); }));
  new Setting(containerEl).setName('快照节流（秒）').setDesc('停止连续输入后再等多久写入快照，默认 5 秒')
    .addText((t) => t.setValue(String(p.settings.versionThrottle)).onChange(async (v) => { p.settings.versionThrottle = clamp(parseInt(v, 10) || 5, 1, 120); await p.saveNow(); }));
  new Setting(containerEl).setName('每篇保留版本数').setDesc('默认 30，超出后自动丢弃最旧版本')
    .addText((t) => t.setValue(String(p.settings.versionMax)).onChange(async (v) => { p.settings.versionMax = clamp(parseInt(v, 10) || 30, 3, 200); await p.saveNow(); }));

  containerEl.createEl('h3', { text: FT('发布与会话') });
  new Setting(containerEl).setName('会话离开阈值（秒）').setDesc('超过这个时间没有输入即计为离开，默认 60 秒；用于会话统计的中断与专注度')
    .addText((t) => t.setValue(String(p.settings.awayThreshold)).onChange(async (v) => { p.settings.awayThreshold = clamp(parseInt(v, 10) || 60, 10, 3600); await p.saveNow(); }));
  new Setting(containerEl).setName('敏感词表').setDesc('发布前检查用，逗号分隔；命中会标为未通过')
    .addText((t) => t.setValue(p.settings.sensitiveWords || '').onChange(async (v) => { p.settings.sensitiveWords = v; await p.saveNow(); }));
  new Setting(containerEl).setName('默认发布平台').setDesc('发布复盘回填表单的预填平台')
    .addText((t) => t.setValue(p.settings.targetColumn || '').onChange(async (v) => { p.settings.targetColumn = v; await p.saveNow(); }));
}

/* ============ 入口 ============ */
function setupFeatures(plugin) {
  /* 设置与数据兜底 */
  for (const k of Object.keys(FEATURE_DEFAULTS)) if (plugin.settings[k] === undefined) plugin.settings[k] = FEATURE_DEFAULTS[k];
  plugin.data.tags = plugin.data.tags || [];
  plugin.data.fileMeta = plugin.data.fileMeta || {};
  plugin.data.materials = plugin.data.materials || [];
  plugin.data.metrics = plugin.data.metrics || [];
  plugin.data.savedFilters = plugin.data.savedFilters || [];
  plugin.data.sessionDays = plugin.data.sessionDays || {};
  ensureVersionData(plugin);
  plugin.noteSessionActivity = (typing) => {
    const s = plugin._features && plugin._features.session;
    if (s && typeof s.tick === 'function') s.tick(typing);
  };

  const versions = setupVersions(plugin);
  const symbar = plugin.settings.symbolBar === false ? { refresh() {}, destroy() {} } : buildSymbolBar(plugin);

  for (const [id, cls] of [[VIEW_VERSIONS, VersionView], [VIEW_SEARCH, SearchView], [VIEW_MATERIALS, MaterialView],
    [VIEW_METRICS, MetricsView], [VIEW_SESSIONS, SessionView]]) {
    plugin.registerView(id, (leaf) => new cls(leaf, plugin));
  }

  registerEditorCommands(plugin);
  const session = setupSession(plugin);
  plugin.addRibbonIcon('history', FT('写作台 · 版本历史'), () => plugin.activateView(VIEW_VERSIONS));
  plugin.addRibbonIcon('search', FT('写作台 · 全局搜索'), () => plugin.activateView(VIEW_SEARCH));
  plugin.addRibbonIcon('archive', FT('写作台 · 素材库'), () => plugin.activateView(VIEW_MATERIALS));
  plugin.addRibbonIcon('trending-up', FT('写作台 · 发布复盘'), () => plugin.activateView(VIEW_METRICS));
  plugin.addRibbonIcon('activity', FT('写作台 · 会话统计'), () => plugin.activateView(VIEW_SESSIONS));
  plugin.addCommand({ id: 'open-global-search', name: '打开全局搜索与标签体系', callback: () => plugin.activateView(VIEW_SEARCH) });
  plugin.addCommand({ id: 'open-materials', name: '打开素材库与选题池', callback: () => plugin.activateView(VIEW_MATERIALS) });
  plugin.addCommand({ id: 'open-metrics', name: '打开发布数据复盘', callback: () => plugin.activateView(VIEW_METRICS) });
  plugin.addCommand({ id: 'open-sessions', name: '打开会话统计', callback: () => plugin.activateView(VIEW_SESSIONS) });
  plugin.addCommand({ id: 'import-export', name: '导入导出（MD/TXT/HTML/DOCX/PDF/加密包）', callback: () => new ImpExpModal(plugin.app, plugin).open() });
  plugin.addCommand({ id: 'preflight', name: '发布前检查（八项 + 平台预览）', callback: () => new PreflightModal(plugin.app, plugin).open() });
  plugin.addCommand({ id: 'toggle-symbol-bar', name: '显示/隐藏悬浮符号栏', callback: () => {
    plugin.settings.symbolBar = plugin.settings.symbolBar === false;
    symbar.refresh(); plugin.saveNow();
  } });

  setTimeout(() => versions.checkDrafts(), 1600);

  const api = {
    versions, symbar, session,
    dispose() {
      versions.dispose(); symbar.destroy(); session.dispose();
    }
  };
  plugin._features = api;
  return api;
}

module.exports = { setTranslator, setView,
  setupFeatures, appendSettings, FEATURE_DEFAULTS, lineDiff, diffHtml, SYMBOL_GROUPS,
  VIEW_SEARCH, VIEW_MATERIALS, VIEW_METRICS, VIEW_VERSIONS, VIEW_SESSIONS,
  preflightChecks, zipStore, unzipEntries, docxToMd, mdToHtml, htmlToMd, stripMd, encryptText, docxBlob, streakDays,
};
