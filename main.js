'use strict';

const obsidian = require('obsidian');
const {
  Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab,
  TFile, TFolder, normalizePath, MarkdownView
} = obsidian;


let Decoration = null, ViewPlugin = null, RangeSetBuilder = null;
const cmLoadErrors = [];
try {
  const cmView = require('@codemirror/view');
  Decoration = cmView.Decoration;
  ViewPlugin = cmView.ViewPlugin;
  if (cmView.EditorView) globalThis.__NWS_EditorView = cmView.EditorView;
} catch (e) { cmLoadErrors.push('@codemirror/view: ' + (e && e.message || e)); }
try {
  const cmState = require('@codemirror/state');
  RangeSetBuilder = cmState.RangeSetBuilder;
} catch (e) { cmLoadErrors.push('@codemirror/state: ' + (e && e.message || e)); }
/* 兜底：部分老旧/定制版 Obsidian 不暴露内部模块时，尝试官方对象（大概率没有） */
if (!ViewPlugin && obsidian.ViewPlugin) ViewPlugin = obsidian.ViewPlugin;
if (!Decoration && obsidian.Decoration) Decoration = obsidian.Decoration;
if (!RangeSetBuilder && obsidian.RangeSetBuilder) RangeSetBuilder = obsidian.RangeSetBuilder;
/* ViewPlugin.fromClass 需要 Decoration.set 可用；三者齐备才注册 */
const HAS_CM = !!(Decoration && ViewPlugin && Decoration.set && ViewPlugin.fromClass);

/* ---------- 常量 ---------- */
const VIEW_CATALOG = 'nws-catalog';
const VIEW_OUTLINE = 'nws-outline';
const VIEW_ENTITIES = 'nws-entities';
const VIEW_NOTES = 'nws-notes';
const VIEW_PLOTS = 'nws-plots';       // 情节
const VIEW_LINES = 'nws-lines';       // 时间-空间双线
const VIEW_STATS = 'nws-stats';       // 数据中心（热力图 / 码字统计）
const VIEW_ANNOT = 'nws-annot';       // v2.7 批注管理

/* 情节四阶段 */
const PLOT_STAGES = [
  { key: 'begin', label: '开端', emoji: '🌱' },
  { key: 'develop', label: '发展', emoji: '🌿' },
  { key: 'climax', label: '高潮', emoji: '🔥' },
  { key: 'end', label: '结局', emoji: '🏁' }
];
/* 双线节点可绑定的设定类型（取库 + 情节 + 自定义） */
const LINE_BIND_KINDS = ['人物', '角色关系', '地理', '力量体系', '物品道具', '社会文化', '经济科技', '剧情', '场景', '冲突', '伏笔', '时间线', '线索', '信息差', '情绪', '情节'];
/* ===== v2.4：多轨时间/空间/情绪线 =====
   track（轨）= { id, name, axis:'time'|'space'|'emotion', view, bindings, order, created }
 
const TRACK_AXES = [
  { key: 'time', name: '时间线', emoji: '⏳' },
  { key: 'space', name: '空间线', emoji: '🗺️' },
  { key: 'emotion', name: '情绪线', emoji: '💗' }
];
/* 视角：时间/空间/情绪都可用；情绪视角有专属触发源字段 */
const TRACK_VIEWS = [
  { key: 'event', name: '事件视角', emoji: '📌', node: '事件', at: '时间刻度', hint: '围绕独立事件按时间/顺序串接' },
  { key: 'person', name: '人物视角', emoji: '👤', node: '经历节点', at: '时间/年龄', hint: '围绕某个人物的经历推进' },
  { key: 'plot', name: '情节视角', emoji: '🧩', node: '情节节点', at: '章节/幕', hint: '围绕情节发展推进' },
  { key: 'space', name: '空间视角', emoji: '🗺️', node: '地点节点', at: '位置/坐标', hint: '围绕地点与场景转换' },
  { key: 'emotion', name: '情绪视角', emoji: '💗', node: '情绪节点', at: '触发点（事件/地点/时间段/外部条件）', hint: '记录情绪变化；触发源可绑定事件/地点/人物/条件，情绪强度用内容描述' }
];
/* 重命名建议：按「轴 + 视角」给出可直接用的线名模板 */
const TRACK_NAME_PRESETS = {
  time: ['主角成长时间线', '故事发展时间线', '张三的行动轨迹', '双线对照·时间'],
  space: ['京城地理线', '主角行动路线', '场景转换空间线', '双线对照·空间'],
  emotion: ['主角情绪曲线', '由事件引发的情绪变化', '某地的情绪氛围线', '读者情绪张力线']
};
function trackAxisDef(k) { return TRACK_AXES.find((a) => a.key === k) || TRACK_AXES[0]; }
function trackViewDef(k) { return TRACK_VIEWS.find((v) => v.key === k) || TRACK_VIEWS[0]; }

const PALETTE = ['#C98B86', '#8FAF95', '#86A0BD', '#D2A271', '#D4BE76', '#A797BE'];
const PALETTE_NAMES = ['红', '绿', '蓝', '橙', '黄', '紫'];
/* v2.2：右键一级常用归类（用户最常点），直接平铺在右键菜单，不再藏进两级子菜单 */
const QUICK_CLASSIFY = [
  { type: '伏笔', group: '剧情大纲+伏笔库', emoji: '🔖' },
  { type: '情节', group: '剧情大纲+伏笔库', emoji: '🧩' },
  { type: '人物', group: '人物库', emoji: '👤' },
  { type: '地理', group: '地理/势力库', emoji: '🗺️' },
  { type: '角色关系', group: '角色关系库', emoji: '🔗' },
  { type: '线索', group: '剧情大纲+伏笔库', emoji: '🔎' },
  { type: '力量体系', group: '力量或规则库', emoji: '⚡' },
  { type: '主题', group: '世界观总纲', emoji: '🎭' },
];

/* ===== v2.0：两级设定库体系（大类 → 小库） =====
   大类（group）= 用户指定的 6 类 + 主题库 + 语言风格库；无法归类者落入「独立」。
   小库（lib/type）= 具体的设定类型，每条设定仍是 设定/<名称>.md，type 写入 frontmatter。
   fields 用于生成模板正文骨架（## 字段），每个大类与小库都有自己的模板。 */
const ENTITY_GROUPS = [
  { name: '世界观总纲', emoji: '🌍', color: 1, fields: ['时代背景', '世界起源', '核心矛盾', '世界运行法则', '社会形态', '科技/力量水平', '地理概览', '文化信仰'], libs: ['世界观', '社会文化', '经济科技', '主题'] },
  { name: '人物库', emoji: '👤', color: 2, fields: ['角色定位', '姓名/称号', '外貌', '性格', '能力/特长', '背景经历', '动机与目标', '人际关系', '登场章节'], libs: ['人物'] },
  { name: '角色关系库', emoji: '🔗', color: 5, fields: ['关系方A', '关系方B', '关系类型', '关系起点', '演变过程', '关键事件', '现状', '关联章节'], libs: ['角色关系'] },
  { name: '地理/势力库', emoji: '🗺️', color: 1, fields: ['位置', '类型', '气候/地貌', '重要地点', '势力归属', '历史事件', '关联角色', '关联章节'], libs: ['地理', '场景', '势力'] },
  { name: '力量或规则库', emoji: '⚡', color: 3, fields: ['体系/规则名称', '来源', '等级/条款', '核心内容', '代价与限制', '例外情况', '代表角色', '关联情节'], libs: ['力量体系', '物品道具', '规则'] },
  { name: '剧情大纲+伏笔库', emoji: '🧩', color: 3, fields: ['类型（主线/支线）', '一句话梗概', '开端', '发展', '高潮', '结局', '伏笔/线索', '关联角色', '关联章节'], libs: ['剧情', '情节', '伏笔', '冲突', '时间线', '线索', '信息差', '情绪'] },
  { name: '独立', emoji: '📌', color: 0, fields: ['说明', '要点', '关联设定', '关联章节'], libs: ['语言风格', '自定义'] },
];
const GROUP_BY_NAME = Object.create(null);
ENTITY_GROUPS.forEach((g) => { GROUP_BY_NAME[g.name] = g; });
/* 小库 → 大类 映射 */
const LIB_GROUP = Object.create(null);
ENTITY_GROUPS.forEach((g) => g.libs.forEach((l) => { LIB_GROUP[l] = g.name; }));
function groupOfLib(lib) { return LIB_GROUP[lib] || '独立'; }
function libsOfGroup(group) { const g = GROUP_BY_NAME[group]; return g ? g.libs.slice() : ['自定义']; }
function groupEmoji(group) { return (GROUP_BY_NAME[group] || {}).emoji || '📌'; }
/* v2.11：大类 → 子文件夹名（大类「地理/势力库」含斜杠，替换为间隔号以免变成多级目录） */
function groupFolderName(group) {
  return String(group || '独立').replace(/[\\/:*?"<>|]/g, '·').trim() || '独立';
}
/* v2.11：某条设定应存放的分类目录（设定/<大类>/），大类以 frontmatter nws_group 为准 */
function groupFolderOf(e) { return groupFolderName((e && e.group) || groupOfLib((e && e.type) || '人物') || '独立'); }
function groupFields(group) { const g = GROUP_BY_NAME[group] || GROUP_BY_NAME['独立']; return g.fields; }

/* 小库定义（含模板字段）。保留全部旧库名以兼容已有数据，并新增大库所需的新库。 */
const LIBRARIES = [
  { name: '人物', emoji: '👤', color: 2, fields: ['定位', '性别', '年龄', '外貌', '性格', '能力/特长', '背景经历', '动机与目标', '人际关系', '登场章节'] },
  { name: '角色关系', emoji: '🔗', color: 5, fields: ['关系方A', '关系方B', '关系类型', '关系起点', '演变过程', '关键事件', '现状', '关联章节'] },
  { name: '地理', emoji: '🗺️', color: 1, fields: ['位置', '类型', '气候', '地貌', '重要地点', '势力归属', '历史事件', '关联角色'] },
  { name: '力量体系', emoji: '⚡', color: 3, fields: ['体系名称', '力量来源', '等级划分', '核心规则', '代价与限制', '代表角色', '关联情节'] },
  { name: '物品道具', emoji: '🗡️', color: 3, fields: ['类别', '外观', '功能/效果', '稀有度', '来历', '限制条件', '持有者', '关联章节'] },
  { name: '社会文化', emoji: '🏛️', color: 1, fields: ['所属地域', '组织/族群', '制度结构', '习俗礼仪', '信仰', '语言', '关联冲突'] },
  { name: '经济科技', emoji: '⚙️', color: 4, fields: ['经济形态', '核心技术', '关键资源', '交易方式', '技术水平', '社会影响', '关联设定'] },
  { name: '剧情', emoji: '🧩', color: 3, fields: ['类型（主线/支线）', '梗概', '起因', '转折点', '高潮', '结局', '关联角色', '关联章节'] },
  { name: '场景', emoji: '🏞️', color: 1, fields: ['地点', '时间', '参与角色', '氛围', '发生事件', '前后关联', '关联章节'] },
  { name: '冲突', emoji: '⚔️', color: 0, fields: ['冲突方', '起因', '升级过程', '关键转折', '解决方式', '影响后果', '关联角色', '关联章节'] },
  { name: '伏笔', emoji: '🔖', color: 0, fields: ['伏笔内容', '埋设位置', '揭示位置', '关联角色', '关联情节', '读者提示'] },
  { name: '时间线', emoji: '⏳', color: 5, fields: ['时间点', '事件', '参与方', '地点', '因果关系', '关联章节'] },
  { name: '线索', emoji: '🔎', color: 4, fields: ['线索内容', '发现位置', '指向', '关联角色', '关联伏笔', '关联章节'] },
  { name: '信息差', emoji: '💡', color: 5, fields: ['知情方', '不知情方', '信息内容', '形成原因', '利用方式', '关联剧情'] },
  { name: '情绪', emoji: '💗', color: 5, fields: ['情绪主体', '热点/情绪爆点', '触发事件（事件发展）', '触发地点', '触发时间段', '外部条件', '情绪变化', '外化表现', '关联角色', '关联章节'] },
  { name: '世界观', emoji: '🌍', color: 1, fields: ['时代背景', '世界起源', '核心矛盾', '世界运行法则', '社会形态', '科技/力量水平', '地理概览', '文化信仰'] },
  { name: '势力', emoji: '🏯', color: 1, fields: ['势力名称', '势力类型', '所在地', '首领/核心', '成员构成', '势力目标', '与其他势力关系', '关联角色', '关联章节'] },
  { name: '规则', emoji: '📜', color: 3, fields: ['规则名称', '适用领域', '核心条款', '违反后果', '例外情况', '制定者', '关联设定', '关联章节'] },
  { name: '主题', emoji: '🎭', color: 5, fields: ['主题名称', '主题阐述', '人物承载', '情节体现', '象征意象', '反复出现的元素', '读者落点', '关联章节'] },
  { name: '语言风格', emoji: '✒️', color: 4, fields: ['叙述人称', '叙述视角', '语言基调', '句式特点', '用词偏好', '对话风格', '修辞偏好', '应避免', '参考范例'] },
  { name: '自定义', emoji: '🖋️', color: 0, fields: ['类型', '说明', '要点', '关联设定', '关联章节'] },
];
const LIB_BY_NAME = Object.create(null);
LIBRARIES.forEach((l) => { LIB_BY_NAME[l.name] = l; });
const DEFAULT_ENTITY_TYPES = LIBRARIES.map((l) => l.name);
const DEFAULT_ENTITY_TYPE_COLOR = Object.create(null);
LIBRARIES.forEach((l) => { DEFAULT_ENTITY_TYPE_COLOR[l.name] = l.color; });

/* ===== 大纲模板体系 =====
   每种大纲类型一套字段骨架（用户按模板补充内容）；'自定义' 走通用骨架。
   新建大纲时先选类型，即套用对应模板并生成同名 md 笔记（含模板内容）。 */
const OUTLINE_TEMPLATES = {
  '章节': { emoji: '📄', fields: ['本章概要', '出场角色', '场景地点', '情节推进', '冲突转折', '伏笔/线索', '字数目标', '备注'] },
  '总纲': { emoji: '📕', fields: ['一句话卖点', '题材与定位', '核心冲突', '主要人物弧光', '三幕结构', '关键转折点', '主题命题', '预计篇幅'] },
  '卷纲': { emoji: '📗', fields: ['本卷目标', '承接上卷', '核心事件', '主要人物', '起承转合', '卷末钩子', '关联章节'] },
  '情节': { emoji: '🧩', fields: ['一句话概括', '开端', '发展', '高潮', '结局', '参与角色', '关联章节', '备注'] },
  '人物': { emoji: '👤', fields: ['角色定位', '外貌', '性格', '动机目标', '能力特长', '背景经历', '人际关系', '登场章节'] },
  '背景': { emoji: '🎬', fields: ['时代年代', '地域地点', '社会环境', '势力组织', '核心规则', '关联设定'] },
  '场景': { emoji: '🏞️', fields: ['地点', '时间', '天气氛围', '在场角色', '发生事件', '情绪基调'] },
  '伏笔': { emoji: '🔖', fields: ['伏笔内容', '埋设章节', '误导方向', '揭示章节', '关联角色', '读者提示'] },
  '时间线': { emoji: '⏳', fields: ['时间点', '事件', '涉及人物', '地点', '因果关系', '关联章节'] },
  '主题': { emoji: '🎭', fields: ['主题命题', '人物承载', '情节体现', '象征意象', '反复元素', '读者落点'] },
  '自定义': { emoji: '🖋️', fields: ['说明', '要点', '关联对象', '备注'] },
};
/* v2.2：每种模板字段的填写引导（让新建笔记的模板"可直接照着填"，而非只有空标题） */
const OUTLINE_FIELD_HINTS = {
  '一句话卖点': '用一句话说清这个故事最抓人的地方。', '题材与定位': '类型、读者群、篇幅预期。', '核心冲突': '主角想要什么，什么在阻止他。',
  '主要人物弧光': '主角从 A 状态到 B 状态的变化。', '三幕结构': '起（激励事件）/承（对抗）/转合（高潮+结局）三段要点。', '关键转折点': '改变故事走向的几个节点。',
  '主题命题': '这本书最终想表达什么。', '预计篇幅': '总字数 / 章节数估计。',
  '本卷目标': '这一卷要完成的最小目标。', '承接上卷': '上一卷结尾留下的钩子如何接。', '核心事件': '本卷最重要的 2-3 件事。',
  '主要人物': '本卷出场与成长的角色。', '起承转合': '本卷的开端/发展/转折/收束。', '卷末钩子': '把读者带向下一卷的悬念。', '关联章节': '本卷覆盖的章节范围。',
  '本章概要': '这一章发生了什么（三句话内）。', '出场角色': '本章登场的角色。', '场景地点': '主要场景与地点。', '情节推进': '本章相对上一章推进了什么。',
  '冲突转折': '本章的冲突与转折。', '伏笔/线索': '本章埋下或揭示的伏笔。', '字数目标': '本章计划字数（默认 3000）。',
  '一句话概括': '这条情节一句话说清。', '开端': '情节如何开始。', '发展': '情节如何展开。', '高潮': '最紧张的时刻。', '结局': '情节如何收尾。', '参与角色': '涉及的角色。',
  '角色定位': '主角/配角/反派？承担什么叙事功能。', '外貌': '外貌特征。', '性格': '性格与弱点。', '动机目标': '想要什么，为什么。',
  '能力特长': '擅长什么。', '背景经历': '过往经历。', '人际关系': '与其他角色的关系。', '登场章节': '首次登场章节。',
  '时代年代': '故事发生的时代。', '地域地点': '主要地理范围。', '社会环境': '社会氛围。', '势力组织': '主要势力。', '核心规则': '世界运行规则。', '关联设定': '相关设定条目。',
  '地点': '地点名称。', '时间': '发生时间。', '天气氛围': '天气与环境氛围。', '在场角色': '在场角色。', '发生事件': '发生的事件。', '情绪基调': '这一幕的情绪色彩。',
  '伏笔内容': '埋了什么伏笔。', '埋设章节': '在哪一章埋设。', '误导方向': '引导读者往哪个方向误会。', '揭示章节': '在哪一章揭示。', '读者提示': '给读者的线索。',
  '时间点': '具体时间点。', '事件': '发生的事件。', '涉及人物': '涉及的人物。', '因果关系': '与前因后果的联系。',
  '主题命题': '想表达的主题。', '人物承载': '由哪个角色承载。', '情节体现': '哪条情节体现。', '象征意象': '反复出现的意象。', '反复元素': '反复出现的元素。', '读者落点': '希望读者读完后留下什么感受。',
  '说明': '说明。', '要点': '要点。', '关联对象': '关联的人物/情节/设定。', '备注': '其它补充。'
};
function outlineTemplateFields(type) {
  const t = OUTLINE_TEMPLATES[type] || OUTLINE_TEMPLATES['自定义'];
  return t.fields;
}
function outlineEmoji(type) {
  return (OUTLINE_TEMPLATES[type] || {}).emoji || '📋';
}
/* 旧九类 → 新库映射（v2→v3 迁移） */
const LIB_MIGRATE = { '角色': '人物', '情节': '剧情', '场景': '场景', '伏笔': '伏笔', '时间线': '时间线', '空间线': '地理', '线索': '线索', '信息差': '信息差', '情绪': '情绪' };
/* 大纲类型（章节/情节/人物等，可自定义） */
const DEFAULT_OUTLINE_TYPES = ['总纲', '卷纲', '章节', '情节', '人物', '背景', '场景', '伏笔', '时间线', '主题', '自定义'];

/* v2.6.1：章节状态四选项（点目录里的状态标签循环切换）。旧值映射：空白→草稿、草稿→写作中、修订中→待修订、已完成/已定稿→已定稿 */
const CH_STATUS = ['草稿', '写作中', '待修订', '已定稿'];
const PLUGIN_VERSION = '2.13.0';
/* 设定笔记「出场章节」自动统计区的标记（只替换标记之后的内容，不碰用户正文） */
const NWS_APPEAR_MARK = '<!-- NWS:APPEARANCES -->';

/* ===== v2.1：码字数据 / 番茄钟 / 专注模式 ===== */
const DEFAULT_CHAPTER_TARGET = 3000;
/* 专注壁纸：纯 CSS 渐变，无需外部图片 */
const FOCUS_WALLPAPERS = [
  { id: 'none', name: '无壁纸', theme: 'auto', css: '' },
  { id: 'mist', name: '晨雾·浅', theme: 'light', css: 'linear-gradient(135deg,#f3f0e9 0%,#e8eee9 45%,#dfe6ee 100%)' },
  { id: 'sand', name: '暖沙·浅', theme: 'light', css: 'linear-gradient(135deg,#faf3e7 0%,#f0e5d2 55%,#e7d9c3 100%)' },
  { id: 'lilac', name: '丁香·浅', theme: 'light', css: 'linear-gradient(135deg,#f3eef5 0%,#e9e2ef 50%,#dfe6f0 100%)' },
  { id: 'paper', name: '纸白·浅', theme: 'light', css: 'linear-gradient(135deg,#faf8f2 0%,#f4f1e9 55%,#ece8dd 100%)' },
  /* v2.13：纯黑夜模式——不发灰、高对比深色系（底色接近纯黑，色彩仅作氛围微调） */
  { id: 'midnight', name: '纯黑·夜', theme: 'dark', css: 'linear-gradient(180deg,#040507 0%,#07090d 60%,#050609 100%)' },
  { id: 'navy', name: '藏蓝·夜', theme: 'dark', css: 'linear-gradient(180deg,#040813 0%,#081020 60%,#050a14 100%)' },
  { id: 'espresso', name: '深咖·夜', theme: 'dark', css: 'linear-gradient(180deg,#0a0705 0%,#140d08 60%,#0a0705 100%)' },
  { id: 'forest', name: '墨黑绿·夜', theme: 'dark', css: 'linear-gradient(180deg,#040a06 0%,#0a150c 60%,#050b07 100%)' },
  { id: 'wine', name: '深酒红·夜', theme: 'dark', css: 'linear-gradient(180deg,#0a0407 0%,#150a0f 60%,#0a0508 100%)' },
  { id: 'ink', name: '夜墨·深', theme: 'dark', css: 'linear-gradient(135deg,#1a2130 0%,#253048 50%,#121722 100%)' },
  { id: 'plum', name: '暮紫·深', theme: 'dark', css: 'linear-gradient(135deg,#221a2c 0%,#302442 50%,#170f20 100%)' },
  { id: 'graphite', name: '石墨·深', theme: 'dark', css: 'linear-gradient(135deg,#14171b 0%,#1d222a 55%,#0c0e11 100%)' },
  { id: 'darkgreen', name: '墨绿·深', theme: 'dark', css: 'linear-gradient(135deg,#0c1712 0%,#14231c 55%,#08110c 100%)' },
];
/* 程序化背景音（Web Audio 合成，不依赖外部文件）：持续环境声，可随时关 */
const FOCUS_SOUNDS = [
  { id: 'off', name: '🔇 关闭' },
  { id: 'rain', name: '🌧 雨滴' },
  { id: 'drip', name: '💧 滴答' },
  { id: 'bubble', name: '🫧 咕噜咕噜' },
  { id: 'noise', name: '🌊 白噪音' },
];
/* v2.8：打字音效——每次敲键盘才响一下（与背景音分离） */
const TYPING_SOUNDS = [
  { id: 'off', name: '🔇 关闭' },
  { id: 'key', name: '⌨️ 机械键盘' },
  { id: 'soft', name: '🤍 轻柔按键' },
  { id: 'type', name: '📜 打字机' },
];
function dateKey(d) {
  const x = d ? new Date(d) : new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + '时' : '') + (m ? m + '分' : '') + (s ? s + '秒' : '') || '0秒';
}

const TYPE_EMOJI = {
  '角色': '👤', '人物': '👤', '情节': '🧩', '场景': '🏞️', '背景': '🎬', '伏笔': '🔖',
  '线索': '🔎', '时间线': '⏳', '空间线': '🗺️', '信息差': '💡', '情绪': '💗',
  '大纲': '📋', '总纲': '📕', '卷纲': '📗', '章纲': '📘'
};
function typeEmoji(t, isOutline) {
  if (LIB_BY_NAME[t]) return LIB_BY_NAME[t].emoji;
  if (TYPE_EMOJI[t]) return TYPE_EMOJI[t];
  if (/人物|角色|人/.test(t)) return '👤';
  if (/情节|剧情/.test(t)) return '🧩';
  if (/场景|空间|地点/.test(t)) return '🏞️';
  if (/背景/.test(t)) return '🎬';
  if (/伏笔/.test(t)) return '🔖';
  if (/线索/.test(t)) return '🔎';
  if (/时间/.test(t)) return '⏳';
  if (/信息/.test(t)) return '💡';
  if (/情绪|情感|心理/.test(t)) return '💗';
  return isOutline ? '📄' : '🔹';
}

const DEFAULT_SETTINGS = {
  folderOutline: '大纲',
  folderSetting: '设定',
  folderBody: '正文',
  folderInspiration: '灵感',          // v10：每条灵感一个同名 md 笔记
  inspirationFile: '灵感.md',         // 旧字段，仅兼容读取，不再写入
  dialogueHighlight: true,
  dialogueEnglish: true,
  entityHighlight: true,
  entityNameMatch: true,
  entityAliasMatch: true,
  entityEmoji: true,
  entityClickJump: true,                // v3.0：单击正文设定词直接打开该设定笔记
  noteChip: false,
  autoCollectBracket: false,
  hoverDelay: 200,
  currentPara: false,
  /* v2.1 码字数据 / 专注 */
  chapterTarget: DEFAULT_CHAPTER_TARGET, // 每章默认目标字数（章节可单独覆盖）
  showProgressBar: true,                // 顶部悬浮渐变进度条
  paceWindow: 60,                       // 码字速度统计窗口（秒）
  pomodoroWork: 25,                     // 番茄钟专注分钟
  pomodoroBreak: 5,                     // 短休分钟
  pomodoroLongBreak: 15,                // 长休分钟
  pomodoroRounds: 4,                    // 几轮后长休
  focusMinutes: 25,                     // 自定义专注时长
  focusWallpaper: 'midnight',           // 专注壁纸 id（默认纯黑夜模式）
  focusSound: 'off',                   // 背景音 id（可持续环境声，可关）
  focusSoundVolume: 0.3,               // 背景音音量 0-1
  /* v2.8：更易专注 */
  focusFullscreen: true,               // 进入专注自动全屏（隐藏侧边栏 + 系统全屏）
  focusDim: 0.32,                      // 专注遮罩变暗程度 0-0.9（v2.11 从 .55 调低，去发灰感）
  typeSound: 'off',                    // 打字音效 id（v2.11：默认静音，仅专注会话中才响）
  typeSoundVolume: 0.35,               // 打字音效音量 0-1
  typingMode: false,                   // 打字模式：当前段高亮+前后渐淡
  typingRadius: 2,                     // 渐淡段数
  lineMode: 'both',                    // 旧字段，兼容读取（三轴开关见 visibleAxes）
  /* v2.4：三轴独立开关——任意组合显示时间/空间/情绪线；null 时按 lineMode 推断 */
  visibleAxes: ['time', 'space'],
  /* v2.7：批注 + 码字里程碑 */
  annotShow: true,                     // 批注底纹开关
  milestoneMark: true,                 // 每 N 字在行右侧标注里程碑
  milestoneStep: 300,                  // 每 300 字在行右标注里程碑
  dailyGoal: 1000,                     // v2.13：日更目标字数（目标达成率统计）
  /* 设定笔记末尾自动生成「出场章节」统计表（保留） */
  appearSync: true,
};
/* ---------- 工具 ---------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fmt(n) { return (n || 0).toLocaleString('en-US'); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function debounce(fn, ms) {
  let h = null;
  return function () { clearTimeout(h); const a = arguments, s = this; h = setTimeout(() => fn.apply(s, a), ms); };
}
function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}
/* 实体是否显式设了颜色：-1/null 表示「未设色」→ 正文加粗+下划线；否则彩色加粗 */
function hasEntityColor(e) { return !!(e && e.color != null && e.color >= 0 && e.color < 6); }
/* 去掉 frontmatter 后取正文骨架内容（用于悬浮卡展示设定内容） */
function fileBody(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}
function stripForCount(text) {
  let t = String(text || '');
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/^#{1,6}\s.*$/gm, '');
  t = t.replace(/【[^】]*】/g, '');
  return t;
}
function countWords(text) {
  let t = stripForCount(text);
  t = t.replace(/[，。！？；：、“”‘’《》（）【】—…、,.!?;:'"()\[\]{}<>《》\-]/g, '');
  const cjk = (t.match(/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const latin = (t.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}
/* 统计一段文本内若干词条出现的总次数（长词优先、非重叠） */
function countTerms(text, terms) {
  const list = (terms || []).filter((x) => x && String(x).trim()).map((x) => String(x));
  if (!list.length) return 0;
  list.sort((a, b) => b.length - a.length);
  const re = new RegExp(list.map(escapeRegex).join('|'), 'g');
  const m = stripForCount(text).match(re);
  return m ? m.length : 0;
}
function stamp() { return new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function stampFrom(ts) { if (!ts) return ''; return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

/* ================= 插件主类 ================= */
class NovelWriterStudio extends Plugin {
  async onload() {
    const saved = (await this.loadData()) || {};
    this.data = this.normalizeData(saved);
    this.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings || {});
    /* v2.8 迁移：旧「轻键盘」从背景音拆到打字音效 */
    if (this.settings.focusSound === 'key') { this.settings.focusSound = 'off'; }
    /* v2.11：默认打字静音；仅把从未设置过的旧值归零，尊重用户主动选过的音效 */
    if (this.settings.typeSound === undefined || this.settings.typeSound === null || this.settings.typeSound === 'key') this.settings.typeSound = 'off';
    if (this.settings.focusWallpaper === 'mist' || this.settings.focusWallpaper === 'graphite' || this.settings.focusWallpaper === 'pine' || this.settings.focusWallpaper === 'slate' || this.settings.focusWallpaper === 'coffee' || this.settings.focusWallpaper === 'amber') this.settings.focusWallpaper = 'midnight';
    /* v2.11 迁移：旧遮罩 0.55 太灰 → 调亮到 0.32（尊重用户自定义值） */
    if (this.settings.focusDim === 0.55) this.settings.focusDim = 0.32;
    /* v2.10 迁移：里程碑 500 → 300；仅当仍是旧默认值时改，尊重用户自定义值 */
    if (this.settings.milestoneStep === 500) this.settings.milestoneStep = 300;

    this.entityVersion = 0;
    this.wordCache = Object.create(null);
    this.stats = { perEntity: Object.create(null), perChapter: Object.create(null), chapters: [], totalWords: 0 };
    this.capturing = false;
    this.scheduleSave = debounce(() => this.saveNow(), 1000);
    this.scheduleRescan = debounce(() => this.rescan(true), 600);
    this.scheduleAppearSync = debounce(() => this.syncEntityAppearances(), 2500);
    /* v2.1 码字实时状态 */
    this.paceSamples = [];              // [{t, w}] 最近码字样本（实时速度）
    this.liveCounts = Object.create(null); // path -> 上次记录字数（避免与 rescan 重复计数）
    this._lastTypeAt = 0;
    this.focusState = { active: false, wallpaper: '', sound: null, timer: null, endAt: 0, seconds: 0, paused: false, left: 0, mode: '' };
    this.pomodoro = { running: false, timer: null, left: 0, phase: 'work', round: 0 };

    /* 防御式加载：单步失败只记日志，不拖垮整个插件 */
    const step = async (label, fn) => { try { await fn(); } catch (e) { console.error('[小说写作台] ' + label + ' 失败:', e); } };
    await step('初始化目录结构', () => this.ensureStructure());
    await step('同步设定目录', () => this.ensureLibFolders());
    await step('设定文件→索引', () => this.syncFilesToIndex());
    await step('大纲文件→索引', () => this.syncOutlineFiles());
    await step('设定索引→文件', () => this.ensureEntityFiles());
    await step('写入大类归属', () => this.ensureGroupMeta());
    await step('设定按大类分目录', () => this.migrateEntityFolders());
    await step('清理模板提示语', () => this.cleanTemplateHints());
    await step('大纲索引→文件', () => this.ensureOutlineFiles());
    await step('灵感索引→文件', () => this.ensureNoteFiles());
    await step('灵感文件→索引', () => this.syncNoteFiles());
    await step('清理旧灵感.md', () => this.retireOldInspirationFile());
    await step('统计扫描', () => this.rescan(false));

    this.registerView(VIEW_CATALOG, (leaf) => new CatalogView(leaf, this));
    this.registerView(VIEW_OUTLINE, (leaf) => new OutlineView(leaf, this));
    this.registerView(VIEW_ENTITIES, (leaf) => new EntitiesView(leaf, this));
    this.registerView(VIEW_NOTES, (leaf) => new NotesView(leaf, this));
    this.registerView(VIEW_PLOTS, (leaf) => new PlotsView(leaf, this));
    this.registerView(VIEW_LINES, (leaf) => new LinesView(leaf, this));
    this.registerView(VIEW_STATS, (leaf) => new StatsView(leaf, this));
    this.registerView(VIEW_ANNOT, (leaf) => new AnnotsView(leaf, this));

    if (HAS_CM) {
      this.registerEditorExtension(this.buildMarkExtension());
      console.log('[小说写作台] CM6 正文装饰层已注册（设定高亮/引号/批注/里程碑生效）');
    } else {
      console.error('[小说写作台] CM6 装饰层加载失败，正文高亮不可用。诊断：', cmLoadErrors.join(' | ') || '模块未导出装饰类');
    }

    this.addRibbonIcon('folder-tree', '写作台 · 目录', () => this.activateView(VIEW_CATALOG));
    this.addRibbonIcon('list-tree', '写作台 · 大纲', () => this.activateView(VIEW_OUTLINE));
    this.addRibbonIcon('shapes', '写作台 · 设定库', () => this.activateView(VIEW_ENTITIES));
    this.addRibbonIcon('git-branch', '写作台 · 情节', () => this.activateView(VIEW_PLOTS));
    this.addRibbonIcon('git-merge', '写作台 · 时间/空间/情绪线', () => this.activateView(VIEW_LINES));
    this.addRibbonIcon('lightbulb', '写作台 · 灵感', () => this.activateView(VIEW_NOTES));
    this.addRibbonIcon('chart-no-axes-column', '写作台 · 数据中心', () => this.activateView(VIEW_STATS));
    this.addRibbonIcon('sticky-note', '写作台 · 批注', () => this.activateView(VIEW_ANNOT));
    this.addRibbonIcon('search', '写作台 · 查找替换', () => new FindReplaceModal(this.app, this).open());
    this.addRibbonIcon('timer', '写作台 · 番茄钟', () => new FocusModal(this.app, this, 'pomodoro').open());
    this.addRibbonIcon('eye', '写作台 · 专注模式', () => new FocusModal(this.app, this, 'focus').open());

    this.buildHover();
    this.buildAnnotHover();
    this.buildProgressBar();
    this.buildFocusHUD();
    this.registerCommands();
    this.registerContextMenu();
    this.registerEvent(this.app.vault.on('modify', () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on('create', () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on('delete', () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on('rename', () => this.scheduleRescan()));
    /* v2.1：切换文件 / 编辑器变化时刷新进度条；定时器做实时速度衰减与进度条刷新 */
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshProgressBar()));
    this._barTimer = setInterval(() => this.tickLive(), 1000);
    this.registerInterval(this._barTimer);

    this.addSettingTab(new NSSettingTab(this.app, this));
    setTimeout(() => this.refreshViews(), 800);
    /* 加载成功提示：HAS_CM 状态直接反映正文高亮是否可用（v2.10 根因修复） */
    const migrated = !saved.schemaVersion || saved.schemaVersion < 13;
    const cmNote = HAS_CM ? '正文设定高亮已就绪' : '⚠️ 正文高亮不可用（CM6 未加载，请看控制台）';
    setTimeout(() => new Notice('📖 小说写作台 v' + PLUGIN_VERSION + ' 已加载' + (migrated ? ' · 旧数据已迁移' : '') + ' · ' + cmNote), 1200);
  }

  onunload() {
    if (this.hoverEl) this.hoverEl.remove();
    if (this.barEl) this.barEl.remove();
    if (this.hudEl) this.hudEl.remove();
    clearTimeout(this.hoverTimer); clearTimeout(this.hoverHideTimer);
    if (this._barTimer) clearInterval(this._barTimer);
    this.stopSound();
    this.clearFocusWallpaper();
    if (this.pomodoro && this.pomodoro.timer) clearInterval(this.pomodoro.timer);
    if (this.focusState && this.focusState.timer) clearInterval(this.focusState.timer);
  }

  /* ---------- 数据 ---------- */
  normalizeData(d) {
    d = d || {};
    d.entities = d.entities || [];
    d.outlines = d.outlines || [];
    d.notes = d.notes || [];
    d.chapters = d.chapters || {};
    d.entityTypes = d.entityTypes && d.entityTypes.length ? d.entityTypes : DEFAULT_ENTITY_TYPES.slice();
    d.outlineTypes = d.outlineTypes && d.outlineTypes.length ? d.outlineTypes : DEFAULT_OUTLINE_TYPES.slice();
    d.typeColors = d.typeColors || Object.assign({}, DEFAULT_ENTITY_TYPE_COLOR);
    d.settings = d.settings || {};
    /* 一次性迁移：旧六类设定 → 新九类（保留自定义类型与已设颜色） */
    if (!d.schemaVersion || d.schemaVersion < 2) {
      const OLD = ['人物', '背景设定', '环境', '伏笔', '信息差', '线索'];
      const mapType = { '人物': '角色', '背景设定': '场景', '环境': '场景' };
      const custom = (d.entityTypes || []).filter((t) => OLD.indexOf(t) < 0 && DEFAULT_ENTITY_TYPES.indexOf(t) < 0);
      d.entities.forEach((e) => { if (mapType[e.type]) { e.type = mapType[e.type]; e.color = DEFAULT_ENTITY_TYPE_COLOR[e.type]; } });
      d.entityTypes = DEFAULT_ENTITY_TYPES.slice().concat(custom);
      const newColors = Object.assign({}, DEFAULT_ENTITY_TYPE_COLOR);
      Object.keys(d.typeColors || {}).forEach((k) => { if (d.entityTypes.indexOf(k) >= 0 && newColors[k] == null) newColors[k] = d.typeColors[k]; });
      d.typeColors = newColors;
      d.schemaVersion = 2;
    }
    /* v3 迁移：九类/自定义 → 12 模板库（文件化）。保留自定义库与用户已设颜色 */
    if (!d.schemaVersion || d.schemaVersion < 3) {
      const customTypes = (d.entityTypes || []).filter((t) => !LIB_MIGRATE[t] && !LIB_BY_NAME[t]);
      d.entities.forEach((e) => {
        let nt = LIB_MIGRATE[e.type] || e.type;
        if (!LIB_BY_NAME[nt] && customTypes.indexOf(nt) < 0) nt = '人物';
        e.type = nt;
        if (e.color == null) e.color = (LIB_BY_NAME[nt] ? LIB_BY_NAME[nt].color : 2);
      });
      d.entityTypes = DEFAULT_ENTITY_TYPES.slice().concat(customTypes);
      const colors = Object.assign({}, DEFAULT_ENTITY_TYPE_COLOR);
      Object.keys(d.typeColors || {}).forEach((k) => { if (d.entityTypes.indexOf(k) >= 0 && colors[k] == null) colors[k] = d.typeColors[k]; });
      d.typeColors = colors;
      d.schemaVersion = 3;
    }
    /* v4 迁移：新增情节（plots）与时间-空间双线（timeline / spaceline 节点） */
    if (!d.schemaVersion || d.schemaVersion < 4) {
      d.plots = d.plots || [];
      d.lineNodes = d.lineNodes || [];
      d.schemaVersion = 4;
    }
    /* v5 迁移：灵感新增绑定对象与处理状态 */
    if (!d.schemaVersion || d.schemaVersion < 5) {
      (d.notes || []).forEach((n) => { n.bindings = n.bindings || []; n.status = n.status || '待定'; });
      d.schemaVersion = 5;
    }
    /* v6 迁移：新增「自定义」设定库；大纲文件化（补 file/color/tags 字段） */
    if (!d.schemaVersion || d.schemaVersion < 6) {
      if ((d.entityTypes || []).indexOf('自定义') < 0) (d.entityTypes || []).push('自定义');
      if (d.typeColors && d.typeColors['自定义'] == null) d.typeColors['自定义'] = 5;
      (d.outlines || []).forEach((o) => { o.color = o.color == null ? 3 : o.color; o.tags = o.tags || []; o.file = o.file || ''; });
      d.schemaVersion = 6;
    }
    /* v7 迁移：两级设定库——把每条设定按其 type 归入 8 大类之一；无法归类者「独立」。
       新增 主题库/语言风格库 的类型与默认色，并把所有新小库并入 entityTypes。 */
    if (!d.schemaVersion || d.schemaVersion < 7) {
      LIBRARIES.forEach((l) => { if ((d.entityTypes || []).indexOf(l.name) < 0) (d.entityTypes || []).push(l.name); });
      const colors = Object.assign({}, DEFAULT_ENTITY_TYPE_COLOR);
      Object.keys(d.typeColors || {}).forEach((k) => { if (colors[k] == null) colors[k] = d.typeColors[k]; });
      d.typeColors = colors;
      (d.entities || []).forEach((e) => { e.group = groupOfLib(e.type); });
      d.schemaVersion = 7;
    }
    /* v8 迁移：码字日志（按天）、章节目标字数、专注会话 */
    if (!d.schemaVersion || d.schemaVersion < 8) {
      d.daily = d.daily || {};        // { 'YYYY-MM-DD': { words, secs, focus, sessions } }
      d.focusSessions = d.focusSessions || [];
      d.schemaVersion = 8;
    }
    /* v9 迁移：多轨时间/空间线——把旧的两条固定线（line='time'|'space'）转成 tracks */
    if (!d.schemaVersion || d.schemaVersion < 9) {
      d.tracks = d.tracks || [];
      if (!d.tracks.length) {
        d.tracks.push({ id: 'trk_time', name: '主线时间轴', axis: 'time', view: 'event', order: 0, created: Date.now() });
        d.tracks.push({ id: 'trk_space', name: '主线空间线', axis: 'space', view: 'space', order: 1, created: Date.now() });
      }
      (d.lineNodes || []).forEach((n) => {
        if (!n.trackId) n.trackId = (n.line === 'space' ? 'trk_space' : 'trk_time');
        if (!n.view) n.view = (n.line === 'space' ? 'space' : 'event');
      });
      d.schemaVersion = 9;
    }
    /* v10 迁移：灵感文件化——每条灵感一条 md 笔记（灵感/<标题>.md）。
       旧的 notes 数据保留，加载期由 ensureNoteFiles 落成文件；删除统一 灵感.md。 */
    if (!d.schemaVersion || d.schemaVersion < 10) {
      d.settings = d.settings || {};
      if (!d.settings.folderInspiration) d.settings.folderInspiration = '灵感';
      (d.notes || []).forEach((n) => { n.file = n.file || ''; });
      d.schemaVersion = 10;
    }
    /* v11 迁移：三轴独立开关 + 轨级绑定。旧 lineMode 单一/双线 → visibleAxes 数组；轨补 bindings。
       不自动新增情绪轨（尊重用户"可只有时间/只有空间"的意愿），由用户按需新建。 */
    if (!d.schemaVersion || d.schemaVersion < 11) {
      d.settings = d.settings || {};
      const m = d.settings.lineMode || 'both';
      d.settings.visibleAxes = (m === 'time') ? ['time'] : (m === 'space') ? ['space'] : ['time', 'space'];
      (d.tracks || []).forEach((t) => { t.bindings = t.bindings || []; });
      d.schemaVersion = 11;
    }
    /* v12 迁移：设定库单纯大库化（6 大类 + 独立）。所有设定按其小库重新归入新大类：
       主题→世界观总纲、语言风格/自定义→独立，其余按 LIB_GROUP 新映射。 */
    if (!d.schemaVersion || d.schemaVersion < 12) {
      (d.entities || []).forEach((e) => { e.group = groupOfLib(e.type); });
      d.schemaVersion = 12;
    }
    /* v13 迁移：章节状态改为 草稿/写作中/待修订/已定稿 四值（旧 0空白→0草稿、1草稿→1写作中、2修订中→2待修订、3已完成/4已定稿→3已定稿） */
    if (!d.schemaVersion || d.schemaVersion < 13) {
      Object.keys(d.chapters || {}).forEach((p) => {
        const m = d.chapters[p];
        if (m && m.status != null) m.status = Math.min(Number(m.status) || 0, 3);
      });
      d.schemaVersion = 13;
    }
    d.tracks = d.tracks || [];
    (d.lineNodes || []).forEach((n) => { if (!n.trackId) n.trackId = (n.line === 'space' ? 'trk_space' : 'trk_time'); });
    d.daily = d.daily || {};
    d.focusSessions = d.focusSessions || [];
    d.pomo = d.pomo || { started: 0, completed: 0 }; // v2.13 番茄钟完成率
    Object.keys(d.daily).forEach((k) => { const dd = d.daily[k]; if (dd && !Array.isArray(dd.hours)) dd.hours = Object.assign(Array(24).fill(0), dd.hours || {}); });
    Object.keys(d.chapters || {}).forEach((p) => {
      const m = d.chapters[p];
      if (m && m.target == null) m.target = 0; // 0 = 未单独设定，使用全局默认
      if (m) m.timing = Object.assign({ open: 0, active: 0, focus: 0, written: 0 }, m.timing || {}); // v2.5 每章计时
    });
    d.plots = d.plots || [];
    d.lineNodes = d.lineNodes || [];
    d.entities.forEach((e) => { e.bindings = e.bindings || []; e.aliases = e.aliases || []; e.group = e.group || groupOfLib(e.type); });
    d.outlines.forEach((o) => { o.bindings = o.bindings || []; o.color = o.color == null ? 3 : o.color; o.tags = o.tags || []; o.file = o.file || ''; });
    d.plots.forEach((p) => { p.stages = p.stages || {}; p.roles = p.roles || []; p.tags = p.tags || []; p.chapters = p.chapters || []; });
    d.lineNodes.forEach((n) => { n.bindings = n.bindings || []; });
    d.tracks.forEach((t) => { t.bindings = t.bindings || []; });
    d.settings.visibleAxes = Array.isArray(d.settings.visibleAxes) && d.settings.visibleAxes.length
      ? d.settings.visibleAxes : (d.settings.lineMode === 'time' ? ['time'] : d.settings.lineMode === 'space' ? ['space'] : ['time', 'space']);
    (d.notes || []).forEach((n) => { n.bindings = n.bindings || []; n.status = n.status || '待定'; });
    /* v2.7：批注数据（不改动原文，随章节保存） */
    d.annotations = Array.isArray(d.annotations) ? d.annotations : [];
    d.annotations.forEach((a) => { a.id = a.id || uid(); a.quote = a.quote || ''; a.note = a.note || ''; a.path = a.path || ''; a.from = a.from || 0; a.to = a.to || 0; a.created = a.created || Date.now(); });
    return d;
  }
  async saveNow() { this.data.settings = this.settings; await this.saveData(this.data); }
  scheduleSaveSoon() { this.scheduleSave(); }

  /* ---------- 目录结构 ---------- */
  async ensureFolder(path) {
    const parts = normalizePath(path).split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch (e) { /* 已存在 */ }
      }
    }
  }
  async ensureStructure() {
    await this.ensureFolder(this.settings.folderOutline);
    await this.ensureFolder(this.settings.folderSetting);
    await this.ensureFolder(this.settings.folderBody);
    await this.ensureFolder(this.inspirationRoot());
  }

  /* ========== 设定/大纲文件化引擎 ==========
     v1.5：设定改为扁平存放（设定/<名称>.md），库降级为 frontmatter 里的类型，
     不再铺 15 个物理子目录；旧的 设定/<库>/<名>.md 仍可读，编辑时自动迁移到扁平路径。 */
  libFolder(lib) { return normalizePath(this.settings.folderSetting || '设定'); }
  /* v2.11：按大类把设定分门别类放进 设定/<大类>/ 子文件夹 */
  entityFolder(e) { return normalizePath(this.libFolder() + '/' + groupFolderOf(e)); }
  allLibs() {
    const names = this.data.entityTypes.slice();
    LIBRARIES.forEach((l) => { if (names.indexOf(l.name) < 0) names.push(l.name); });
    return names.map((n) => LIB_BY_NAME[n] || { name: n, emoji: LIB_BY_NAME[n] ? LIB_BY_NAME[n].emoji : '🔹', color: (this.data.typeColors[n] == null ? 2 : this.data.typeColors[n]), fields: [] });
  }
  libDef(lib) { return LIB_BY_NAME[lib] || (this.data.entityTypes.indexOf(lib) >= 0 ? LIB_BY_NAME['自定义'] : null); }
  templateFieldsHint(lib, group) {
    const def = this.libDef(lib);
    const fields = (def && def.fields && def.fields.length) ? def.fields : (group ? groupFields(group) : ['说明']);
    return '模板字段：' + fields.join(' · ');
  }
  safeFileName(name) {
    return String(name || '未命名').replace(/[\\/:*?"<>|#\[\]^]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名';
  }
  /* 生成设定文件的 YAML frontmatter（文件为核心元数据载体） */
  entityFrontmatter(e) {
    const lines = [
      '---',
      'nws_id: ' + e.id,
      'nws_name: ' + JSON.stringify(String(e.name || '')),
      'nws_type: ' + String(e.type || '人物'),
      'nws_group: ' + JSON.stringify(String(e.group || groupOfLib(e.type))),
      'nws_aliases: [' + (e.aliases || []).map((a) => JSON.stringify(String(a))).join(', ') + ']',
      'nws_color: ' + (e.color == null ? -1 : e.color),
      'nws_bindings: ' + JSON.stringify(e.bindings || []),
      'nws_created: ' + (e.created || Date.now()),
      'nws_desc: ' + JSON.stringify(String(e.desc || '')),
      '---'
    ];
    return lines.join('\n');
  }
  /* 生成模板正文骨架（仅新建时） */
  entityTemplateBody(e) {
    const lib = this.libDef(e.type);
    const grp = e.group || groupOfLib(e.type);
    const fields = (lib && lib.fields && lib.fields.length) ? lib.fields : groupFields(grp);
    let body = '\n# ' + String(e.name || '') + '\n\n';
    fields.forEach((f) => { body += '## ' + f + '\n\n'; });
    return body;
  }
  /* 新建或更新设定文件；update 时保留用户手写正文，仅替换 frontmatter */
  async writeEntityFile(e, isNew) {
    const dir = this.entityFolder(e);
    await this.ensureFolder(dir);
    const fname = this.safeFileName(e.name) + '.md';
    let path = normalizePath(dir + '/' + fname);
    // 旧路径（换库/改名）需迁移
    if (e.file && e.file !== path) {
      const old = this.app.vault.getAbstractFileByPath(e.file);
      if (old instanceof TFile) {
        try { await this.app.vault.rename(old, path); } catch (err) { /* 目标冲突等，下面新建兜底 */ }
      }
    }
    let file = this.app.vault.getAbstractFileByPath(path);
    const fm = this.entityFrontmatter(e);
    if (file instanceof TFile) {
      let old = await this.app.vault.cachedRead(file);
      const body = old.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      const newContent = fm + '\n' + (body || this.entityTemplateBody(e));
      if (newContent !== old) await this.app.vault.modify(file, newContent);
    } else {
      file = await this.app.vault.create(path, fm + this.entityTemplateBody(e));
    }
    e.file = path;
    return file;
  }
  /* 从文件 frontmatter 解析元数据 */
  async readEntityMeta(file) {
    let t = '';
    try { t = await this.app.vault.cachedRead(file); } catch (e) { return null; }
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const fm = m[1];
    const get = (k) => { const r = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(fm); return r ? r[1].trim() : null; };
    const id = get('nws_id');
    if (!id) return null;
    const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch (e) { return fallback; } };
    return {
      id: id,
      type: get('nws_type') || '人物',
      group: parseJSON(get('nws_group') || '""', '') || groupOfLib(get('nws_type') || '人物'),
      aliases: parseJSON(get('nws_aliases') || '[]', []),
      color: parseInt(get('nws_color'), 10),
      bindings: parseJSON(get('nws_bindings') || '[]', []),
      created: parseInt(get('nws_created'), 10) || Date.now(),
      desc: parseJSON(get('nws_desc') || '""', ''),
      file: file.path,
      name: parseJSON(get('nws_name') || '""', '') || file.basename
    };
  }
  /* 文件 → 内存：扫描设定各库目录，新增未索引的文件、用文件元数据更新已索引实体 */
  async syncFilesToIndex() {
    const settingRoot = normalizePath(this.settings.folderSetting || '设定');
    const tracked = Object.create(null);
    this.data.entities.forEach((e) => { if (e.file) tracked[e.file] = e; });
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.indexOf(settingRoot + '/') === 0);
    let changed = false;
    for (const f of files) {
      const meta = await this.readEntityMeta(f);
      if (!meta) continue; // 非本插件管理的 md（如手写说明），跳过
      tracked[f.path] = true;
      let e = this.data.entities.find((x) => x.id === meta.id);
      if (!e) {
        e = { id: meta.id, name: meta.name, type: meta.type, group: meta.group, color: meta.color, aliases: meta.aliases, desc: meta.desc, bindings: meta.bindings, created: meta.created, file: f.path };
        this.data.entities.push(e);
        changed = true;
      } else {
        // 文件为准：用文件元数据覆盖（用户在 Obsidian 里直接改 frontmatter 即生效）
        const oldName = e.name;
        e.name = meta.name; e.type = meta.type; e.group = meta.group || groupOfLib(meta.type); e.color = isNaN(meta.color) ? e.color : meta.color;
        e.aliases = meta.aliases; e.desc = meta.desc; e.bindings = meta.bindings; e.file = f.path;
        if (oldName !== meta.name) changed = true;
      }
    }
    // 文件已被删除 → 从索引移除（仅移除由本插件创建、带 file 的条目）
    const livePaths = Object.create(null);
    files.forEach((f) => { livePaths[f.path] = 1; });
    const before = this.data.entities.length;
    this.data.entities = this.data.entities.filter((e) => !e.file || livePaths[e.file]);
    if (this.data.entities.length !== before) changed = true;
    if (changed) await this.saveNow();
  }
  /* 内存 → 文件：把尚未落地的旧设定写成 md（迁移用） */
  async ensureEntityFiles() {
    let changed = false;
    for (const e of this.data.entities) {
      if (!e.file || !this.app.vault.getAbstractFileByPath(e.file)) {
        await this.writeEntityFile(e, true);
        changed = true;
      }
    }
    if (changed) await this.saveNow();
  }
  /* v2.0：为旧设定文件补写 nws_group（大类），保留用户手写正文。
     只改 frontmatter，不覆盖正文；已含 nws_group 的跳过。 */
  async ensureGroupMeta() {
    let changed = false;
    for (const e of this.data.entities) {
      if (!e.file) continue;
      const f = this.app.vault.getAbstractFileByPath(e.file);
      if (!(f instanceof TFile)) continue;
      let old = '';
      try { old = await this.app.vault.cachedRead(f); } catch (err) { continue; }
      const fmBlock = (old.match(/^---\r?\n[\s\S]*?\r?\n---/) || [''])[0];
      if (fmBlock.indexOf('nws_group:') >= 0) continue; // 已有
      e.group = e.group || groupOfLib(e.type);
      await this.writeEntityFile(e, false);   // 仅替换 frontmatter，正文保留
      changed = true;
    }
    if (changed) await this.saveNow();
  }
  /* v2.11：把扁平/旧目录里的设定文件移动到 设定/<大类>/ 子文件夹（正文与 frontmatter 原样保留） */
  async migrateEntityFolders() {
    let changed = false;
    for (const e of this.data.entities) {
      if (!e.file) continue;
      const want = this.entityFolder(e) + '/' + this.safeFileName(e.name) + '.md';
      const normWant = normalizePath(want);
      if (normalizePath(e.file) === normWant) continue;
      const old = this.app.vault.getAbstractFileByPath(e.file);
      if (old instanceof TFile) {
        try { await this.app.vault.rename(old, normWant); e.file = normWant; changed = true; }
        catch (err) { console.error('[小说写作台] 设定分目录移动失败:', e.name, err); }
      } else {
        e.file = normWant; changed = true;
      }
    }
    if (changed) await this.saveNow();
  }
  /* v2.3：清理模板文件里那种"建立模板后的话"（可见提示语），只删插件自己写的行，保留用户正文 */
  async cleanTemplateHints() {
    const roots = [normalizePath(this.settings.folderSetting || '设定'), normalizePath(this.settings.folderOutline || '大纲')];
    const kill = /本文件由「?小说写作台」?管理|在正文里输入\s*【|内容会自动收集到这里|模板库[:：].*本文件由/;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!roots.some((r) => f.path.indexOf(r + '/') === 0)) continue;
      let text = '';
      try { text = await this.app.vault.cachedRead(f); } catch (e) { continue; }
      const lines = text.split('\n');
      const kept = lines.filter((ln) => !(kill.test(ln)));
      if (kept.length !== lines.length) {
        // 去掉因删除引用行而留下的连续多余空行（保留单个空行）
        const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n');
        try { await this.app.vault.modify(f, cleaned); } catch (e) { /* 忽略 */ }
      }
    }
  }
  /* v2.11：设定根目录下建 6 大类（+ 独立）子文件夹，分门别类 */
  async ensureLibFolders() {
    const root = normalizePath(this.settings.folderSetting || '设定');
    await this.ensureFolder(root);
    for (const g of ENTITY_GROUPS) {
      await this.ensureFolder(normalizePath(root + '/' + groupFolderName(g.name)));
    }
  }

  /* ========== v1.5 大纲文件化引擎 ==========
     每条大纲 = 大纲/<标题>.md；frontmatter 存绑定对象与参数，正文按类型模板生成骨架。 */
  outlineRoot() { return normalizePath(this.settings.folderOutline || '大纲'); }
  /* 大纲文件的 YAML frontmatter（含绑定了什么） */
  outlineFrontmatter(o) {
    return [
      '---',
      'nws_id: ' + o.id,
      'nws_title: ' + JSON.stringify(String(o.title || '')),
      'nws_type: ' + String(o.type || '章节'),
      'nws_tags: [' + (o.tags || []).map((t) => JSON.stringify(String(t))).join(', ') + ']',
      'nws_color: ' + ((o.color == null ? 3 : o.color) % 6),
      'nws_bindings: ' + JSON.stringify(o.bindings || []),
      'nws_created: ' + (o.created || Date.now()),
      'nws_desc: ' + JSON.stringify(String(o.desc || '')),
      '---'
    ].join('\n');
  }
  /* 大纲模板正文骨架（仅新建时生成，含绑定对象区） */
  outlineTemplateBody(o) {
    const fields = outlineTemplateFields(o.type);
    let body = '\n# ' + String(o.title || '') + '\n\n';
    body += '## 绑定对象\n\n';
    const binds = o.bindings || [];
    if (binds.length) binds.forEach((b) => { body += '- ' + (b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : '📋') + ' ' + String(b.name || b.id) + '\n'; });
    else body += '（未绑定 · 在写作台大纲面板点「🔗 绑定」关联章节/设定）\n';
    body += '\n## 内容\n\n';
    fields.forEach((f) => {
      const hint = OUTLINE_FIELD_HINTS[f];
      body += '### ' + f + '\n\n' + (hint ? '<!-- 填写引导：' + hint + ' -->\n\n' : '');
    });
    if (o.desc) body += '\n## 备注\n\n' + o.desc + '\n';
    return body;
  }
  /* 新建或更新大纲文件；update 时保留用户手写正文，仅替换 frontmatter */
  async writeOutlineFile(o, isNew) {
    await this.ensureFolder(this.outlineRoot());
    let fname = this.safeFileName(o.title) + '.md';
    let path = normalizePath(this.outlineRoot() + '/' + fname);
    // 新建时若同名文件已属于另一条大纲，加短 id 后缀，避免覆盖别人的正文
    if (isNew && !o.file) {
      const clash = this.app.vault.getAbstractFileByPath(path);
      if (clash instanceof TFile) {
        fname = this.safeFileName(o.title) + '-' + o.id.slice(-4) + '.md';
        path = normalizePath(this.outlineRoot() + '/' + fname);
      }
    }
    if (o.file && o.file !== path) {
      const old = this.app.vault.getAbstractFileByPath(o.file);
      if (old instanceof TFile) { try { await this.app.vault.rename(old, path); } catch (e) { /* 冲突兜底 */ } }
    }
    let file = this.app.vault.getAbstractFileByPath(path);
    const fm = this.outlineFrontmatter(o);
    if (file instanceof TFile) {
      const old = await this.app.vault.cachedRead(file);
      let body = old.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      body = this.syncOutlineSections(o, body, isNew);
      const next = fm + '\n' + body;
      if (next !== old) await this.app.vault.modify(file, next);
    } else {
      file = await this.app.vault.create(path, fm + this.outlineTemplateBody(o));
    }
    o.file = path;
    return file;
  }
  /* v2.6：把「绑定对象 / 备注」两个托管区段同步进大纲文件正文——
     面板里每次绑定/解绑、改备注都会自动写进对应 md；用户手写的其余内容（标题、模板字段等）原样保留。
     regenTpl=true（改类型时）还会按新类型重建「## 内容」模板骨架区。 */
  syncOutlineSections(o, body, regenTpl) {
    const secRe = (title) => new RegExp('\n## ' + title + '\n[\\s\\S]*?(?=\n## |\n# |$)');
    /* 绑定对象 */
    const bindLines = (o.bindings || []).map((b) => '- ' + (b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : '📋') + ' ' + String(b.name || b.id) + '\n').join('');
    const bindBlock = '\n## 绑定对象\n\n' + (bindLines || '（未绑定 · 在写作台大纲面板点「🔗 绑定」关联章节/设定）\n');
    if (secRe('绑定对象').test(body)) body = body.replace(secRe('绑定对象'), bindBlock);
    else body += bindBlock;
    /* 备注（= 面板里的描述） */
    const descBlock = (o.desc && String(o.desc).trim()) ? '\n## 备注\n\n' + String(o.desc).trim() + '\n' : '';
    if (secRe('备注').test(body)) body = body.replace(secRe('备注'), descBlock);
    else if (descBlock) body += descBlock;
    /* 改类型 → 重建模板内容区 */
    if (regenTpl) {
      let tpl = '\n## 内容\n\n';
      outlineTemplateFields(o.type).forEach((f) => {
        const hint = OUTLINE_FIELD_HINTS[f];
        tpl += '### ' + f + '\n\n' + (hint ? '<!-- 填写引导：' + hint + ' -->\n\n' : '');
      });
      if (secRe('内容').test(body)) body = body.replace(secRe('内容'), tpl);
      else body += tpl;
    }
    return body;
  }
  /* 从大纲文件 frontmatter 解析元数据 */
  async readOutlineMeta(file) {
    let t = '';
    try { t = await this.app.vault.cachedRead(file); } catch (e) { return null; }
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const fm = m[1];
    const get = (k) => { const r = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(fm); return r ? r[1].trim() : null; };
    const id = get('nws_id');
    if (!id) return null;
    const PJ = (s, fb) => { try { return JSON.parse(s); } catch (e) { return fb; } };
    return {
      id, type: get('nws_type') || '章节',
      tags: PJ(get('nws_tags') || '[]', []),
      color: parseInt(get('nws_color'), 10),
      bindings: PJ(get('nws_bindings') || '[]', []),
      created: parseInt(get('nws_created'), 10) || Date.now(),
      desc: PJ(get('nws_desc') || '""', ''),
      file: file.path,
      title: PJ(get('nws_title') || '""', '') || file.basename
    };
  }
  /* 大纲文件 → 内存索引 */
  async syncOutlineFiles() {
    const root = this.outlineRoot();
    const live = Object.create(null);
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.indexOf(root + '/') === 0);
    let changed = false;
    for (const f of files) {
      const meta = await this.readOutlineMeta(f);
      if (!meta) continue;
      live[f.path] = 1;
      let o = this.data.outlines.find((x) => x.id === meta.id);
      if (!o) {
        o = { id: meta.id, title: meta.title, type: meta.type, color: meta.color, tags: meta.tags, bindings: meta.bindings, created: meta.created, desc: meta.desc, file: f.path };
        this.data.outlines.push(o);
        changed = true;
      } else {
        const oldTitle = o.title;
        o.title = meta.title; o.type = meta.type; o.color = isNaN(meta.color) ? o.color : meta.color;
        o.tags = meta.tags; o.bindings = meta.bindings; o.desc = meta.desc; o.file = f.path;
        if (oldTitle !== meta.title) changed = true;
      }
    }
    const before = this.data.outlines.length;
    this.data.outlines = this.data.outlines.filter((o) => !o.file || live[o.file]);
    if (this.data.outlines.length !== before) changed = true;
    if (changed) await this.saveNow();
  }
  /* 内存 → 大纲文件：旧数据/新建落成 md */
  async ensureOutlineFiles() {
    let changed = false;
    for (const o of this.data.outlines) {
      if (!o.file || !this.app.vault.getAbstractFileByPath(o.file)) {
        await this.writeOutlineFile(o, true);
        changed = true;
      }
    }
    if (changed) await this.saveNow();
  }
  async openOutlineFile(id) {
    const o = this.outlineById(id);
    if (!o) return;
    await this.ensureOutlineFiles();
    const f = this.app.vault.getAbstractFileByPath(o.file);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
  }

  /* ---------- 扫描 + 统计 ---------- */
  async rescan(refresh) {
    await this.syncFilesToIndex(); // 用户在 Obsidian 直接改/删设定文件 → 同步回索引
    await this.syncOutlineFiles(); // 大纲文件 → 索引
    const body = normalizePath(this.settings.folderBody || '正文');
    const prefix = body + '/';
    const chapters = [];
    const wordCache = Object.create(null);
    const perEntity = Object.create(null);
    const perChapter = Object.create(null);
    this.data.entities.forEach((e) => { perEntity[e.id] = { entity: e, total: 0, chapters: Object.create(null), first: '', last: '' }; });

    for (const f of this.app.vault.getMarkdownFiles()) {
      let text = '';
      try { text = await this.app.vault.cachedRead(f); } catch (e) { text = ''; }
      wordCache[f.path] = countWords(text);
      if (f.path !== normalizePath(this.settings.inspirationFile) && f.path.indexOf(prefix) === 0) {
        const rel = f.path.slice(prefix.length);
        const parts = rel.split('/');
        const volume = parts.length > 1 ? parts[0] : '（未分卷）';
        const meta = this.data.chapters[f.path] || {};
        const ch = {
          path: f.path, file: f, title: f.basename, volume, words: wordCache[f.path],
          status: meta.status == null ? (wordCache[f.path] > 0 ? 1 : 0) : meta.status, order: meta.order || 0
        };
        chapters.push(ch);
        const chMap = Object.create(null);
        this.data.entities.forEach((e) => {
          const n = countTerms(text, [e.name].concat(e.aliases || []));
          if (n > 0) {
            chMap[e.id] = n;
            const pe = perEntity[e.id];
            pe.total += n;
            pe.chapters[f.path] = n;
            if (!pe.first) pe.first = ch.title;
            pe.last = ch.title;
          }
        });
        perChapter[f.path] = chMap;
      }
    }
    chapters.sort((a, b) => a.volume.localeCompare(b.volume, 'zh') || a.order - b.order || a.title.localeCompare(b.title, 'zh'));
    this.wordCache = wordCache;
    this.stats = { perEntity, perChapter, chapters, totalWords: chapters.reduce((s, c) => s + c.words, 0) };
    this.entityVersion++;
    /* v2.9.1：统计完成 → 自动刷新设定笔记里的「出场章节」表格 */
    this.scheduleAppearSync();
    if (refresh) this.refreshViews();
  }
  countFile(file) { return this.wordCache[file.path] || 0; }
  allChapters() { return this.stats.chapters.slice(); }
  aggregate() { return this.stats; }
  metaOf(path) { return this.data.chapters[path] || {}; }
  async setMeta(path, patch) {
    this.data.chapters[path] = Object.assign({}, this.metaOf(path), patch);
    await this.saveNow(); this.refreshViews();
  }
  /* ========== v2.5：本章统计 ========== */
  isChapterPath(path) {
    const body = normalizePath(this.settings.folderBody || '正文') + '/';
    return String(path).indexOf(body) === 0;
  }
  chapterTiming(path) {
    const m = this.metaOf(path);
    return Object.assign({ open: 0, active: 0, focus: 0, written: 0 }, (m && m.timing) || {});
  }
  /* 本章设定按分类统计：groups=按大类聚合，libs=按小库聚合，top=出现最多前 10 */
  chapterEntityStats(path) {
    const chMap = (this.stats && this.stats.perChapter && this.stats.perChapter[path]) || {};
    const groups = Object.create(null), libs = Object.create(null), list = [];
    Object.keys(chMap).forEach((id) => {
      const e = this.entityById(id); if (!e) return;
      const n = chMap[id];
      const g = e.group || groupOfLib(e.type) || '独立';
      const G = groups[g] || (groups[g] = { name: g, emoji: groupEmoji(g), total: 0, libs: Object.create(null) });
      G.total += n;
      const lib = e.type || '未分类';
      G.libs[lib] = (G.libs[lib] || 0) + n;
      libs[lib] = (libs[lib] || 0) + n;
      list.push({ e, n });
    });
    list.sort((a, b) => b.n - a.n);
    return {
      total: list.reduce((s, it) => s + it.n, 0),
      groups: Object.keys(groups).map((g) => {
        const G = groups[g];
        G.libArr = Object.keys(G.libs).map((k) => ({ name: k, total: G.libs[k] })).sort((a, b) => b.total - a.total);
        return G;
      }).sort((a, b) => b.total - a.total),
      libs: Object.keys(libs).map((k) => ({ name: k, emoji: typeEmoji(k), total: libs[k] })).sort((a, b) => b.total - a.total),
      top: list.slice(0, 10)
    };
  }

  /* ========== v2.1：码字数据 / 进度条 / 番茄钟 / 专注 ========== */
  /*  Chapters 目标字数：优先章节单独设定，否则用全局默认 */
  targetOf(path) {
    const m = this.metaOf(path);
    const t = Number(m && m.target);
    return (t && t > 0) ? t : (Number(this.settings.chapterTarget) || DEFAULT_CHAPTER_TARGET);
  }
  async setActiveChapterTarget() {
    const f = this.app.workspace.getActiveFile();
    if (!f) { new Notice('请先打开一个章节'); return; }
    new InputModal(this.app, '本章目标字数（填 0 则用全局默认 ' + (this.settings.chapterTarget || DEFAULT_CHAPTER_TARGET) + '）',
      String(this.targetOf(f.path)), async (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0) { new Notice('请输入有效数字'); return; }
        await this.setMeta(f.path, { target: n });
        await this.rescan(true);
        new Notice(n > 0 ? '本章目标：' + fmt(n) + ' 字' : '本章目标已跟随全局默认');
      }).open();
  }
  /* 记录码字增量（由 CM6 在正文变更时调用），按天累计；v2.13 另记小时分布/工作日周末 */
  recordTyping(path, deltaWords) {
    if (!deltaWords || deltaWords <= 0) return;
    const key = dateKey();
    const d = this.data.daily[key] || (this.data.daily[key] = { words: 0, secs: 0, focus: 0, sessions: 0 });
    d.words += deltaWords;
    /* v2.13：时间分布埋点——小时段 + 工作日/周末 */
    const now0 = new Date();
    if (!Array.isArray(d.hours) || d.hours.length !== 24) d.hours = Object.assign(Array(24).fill(0), d.hours || {});
    d.hours[now0.getHours()] += deltaWords;
    const dow = now0.getDay();
    if (dow === 0 || dow === 6) d.we = (d.we || 0) + deltaWords; else d.wk = (d.wk || 0) + deltaWords;
    /* v2.5：本章累计输入（用于每章码字速度） */
    const cm = this.data.chapters[path] = this.data.chapters[path] || {};
    const tm = cm.timing = Object.assign({ open: 0, active: 0, focus: 0, written: 0 }, cm.timing || {});
    tm.written += deltaWords;
    this._lastTypePath = path;
    /* 码字时长：距上次敲字 <60s 视为连续码字，累加间隔 */
    const now = Date.now();
    if (this._lastTypeAt && now - this._lastTypeAt < 60000) d.secs += Math.min(60, (now - this._lastTypeAt) / 1000);
    this._lastTypeAt = now;
    /* 实时速度样本 */
    this.paceSamples.push({ t: now, w: deltaWords });
    if (this.paceSamples.length > 400) this.paceSamples.splice(0, this.paceSamples.length - 400);
    this.scheduleSave();
    this.refreshProgressBar();
    this.refreshFocusHUD();
    if (this.statsViewOpen()) this.scheduleStatsRefresh();
  }
  /* v2.13：删除字数记录（效率：删除修改比例） */
  recordDeletion(n) {
    if (!n || n <= 0) return;
    const key = dateKey();
    const d = this.data.daily[key] || (this.data.daily[key] = { words: 0, secs: 0, focus: 0, sessions: 0 });
    d.del = (d.del || 0) + n;
    this.scheduleSave();
  }
  /* 实时码字速度：最近 N 秒的字数 / 秒 → 字/分钟 */
  pacePerMinute() {
    const win = (Number(this.settings.paceWindow) || 60) * 1000;
    const now = Date.now();
    const recent = this.paceSamples.filter((s) => now - s.t <= win);
    const words = recent.reduce((a, s) => a + s.w, 0);
    return Math.round(words / ((Number(this.settings.paceWindow) || 60) / 60));
  }
  statsViewOpen() { return this.app.workspace.getLeavesOfType(VIEW_STATS).length > 0; }
  scheduleStatsRefresh() {
    if (this._statsTimer) return;
    this._statsTimer = setTimeout(() => { this._statsTimer = null; this.refreshViews(); }, 1500);
  }
  /* 当日数据（含专注计时中的实时累加） */
  todayData() {
    const k = dateKey();
    /* 专注时长由每秒 tick 直接写入 daily[k].focus，这里直接读取，避免重复累加 */
    return Object.assign({ words: 0, secs: 0, focus: 0, sessions: 0 }, this.data.daily[k] || {});
  }
  focusElapsed() {
    const s = this.focusState;
    if (!s.active) return 0;
    return s.seconds || 0; // 由 1 秒定时器累加，暂停时不增加
  }
  /* 每秒 tick：刷新进度条上的实时速度 + 专注计时落盘 + v2.5 每章计时 */
  tickLive() {
    this.refreshProgressBar();
    this.refreshFocusHUD();
    /* v2.5：当前激活文件若是章节 → 累计该章打开时长；60 秒内有敲字算码字时长；专注计时中算专注时长。
       偷懒时间 = 打开时长 − 码字时长（展示时计算，不重复记）。 */
    try {
      const f = this.app.workspace.getActiveFile();
      if (f && this.isChapterPath(f.path)) {
        const cm = this.data.chapters[f.path] = this.data.chapters[f.path] || {};
        const tm = cm.timing = Object.assign({ open: 0, active: 0, focus: 0, written: 0 }, cm.timing || {});
        const now = Date.now();
        tm.open += 1;
        if (this._lastTypeAt && now - this._lastTypeAt < 60000 && this._lastTypePath === f.path) tm.active += 1;
        if (this.focusState.active && this.focusState.mode === 'focus') tm.focus += 1;
        if (!this._timingSavedAt || now - this._timingSavedAt > 15000) { this._timingSavedAt = now; this.scheduleSave(); }
      }
    } catch (e) { /* 忽略 */ }
    if (this.focusState.active && this.focusState.mode === 'focus' && this.statsViewOpen()) this.scheduleStatsRefresh();
  }

  /* ---------- 顶部悬浮渐变进度条 ---------- */
  buildProgressBar() {
    let b = document.getElementById('nws-progress');
    if (!b) { b = el('div'); b.id = 'nws-progress'; document.body.appendChild(b); }
    this.barEl = b;
    b.innerHTML = '<div class="nws-bar-track"><div class="nws-bar-fill"></div></div>' +
      '<div class="nws-bar-meta"><span class="nws-bar-name"></span><span class="nws-bar-nums"></span></div>';
  }
  refreshProgressBar() {
    const b = this.barEl;
    if (!b) return;
    const f = this.app.workspace.getActiveFile();
    const bodyDir = normalizePath(this.settings.folderBody || '正文');
    if (!f || f.extension !== 'md' || f.path.indexOf(bodyDir + '/') !== 0 || !this.settings.showProgressBar) {
      b.style.display = 'none'; return;
    }
    let current;
    if (this.liveText != null && this._livePath === f.path) {
      current = countWords(this.liveText);
    } else if (this.wordCache[f.path] != null) {
      current = this.wordCache[f.path];
    } else {
      /* 首次打开、尚无缓存：异步读取一次再刷新 */
      this.app.vault.cachedRead(f).then((t) => { this.wordCache[f.path] = countWords(t); this.refreshProgressBar(); }).catch(() => {});
      current = 0;
    }
    const target = this.targetOf(f.path);
    const pct = Math.min(100, target > 0 ? Math.round(current / target * 100) : 0);
    const left = Math.max(0, target - current);
    const pace = this.pacePerMinute();
    b.style.display = '';
    b.dataset.pct = String(pct);
    b.querySelector('.nws-bar-fill').style.width = pct + '%';
    b.querySelector('.nws-bar-name').textContent = '✍️ ' + f.basename;
    b.querySelector('.nws-bar-nums').textContent = fmt(current) + ' / ' + fmt(target) + ' 字 · ' + pct + '% · 还差 ' + fmt(left) +
      ' · 速度 ' + pace + ' 字/分' + (this.focusState.active ? ' · ⏱ ' + fmtDur(this.focusElapsed()) : '');
  }

  /* ---------- v2.11：专注模式右下角实时统计 HUD ---------- */
  buildFocusHUD() {
    let h = document.getElementById('nws-focus-hud');
    if (!h) { h = el('div'); h.id = 'nws-focus-hud'; document.body.appendChild(h); }
    this.hudEl = h;
    h.innerHTML =
      '<div class="nws-hud-hd">写作实况</div>' +
      '<div class="nws-hud-row"><span>打字速度</span><b data-k="pace">0</b></div>' +
      '<div class="nws-hud-row"><span>码字时长</span><b data-k="type">0秒</b></div>' +
      '<div class="nws-hud-row"><span>偷懒时长</span><b data-k="idle">0秒</b></div>' +
      '<div class="nws-hud-row"><span>专注时长</span><b data-k="focus">0秒</b></div>' +
      '<div class="nws-hud-row"><span>已码字数</span><b data-k="words">0 字</b></div>' +
      '<div class="nws-hud-row"><span>完成度</span><b data-k="pct">0%</b></div>';
    h.style.display = 'none';
  }
  /* 每秒 / 打字时刷新；仅在专注模式（focus）激活时显示 */
  refreshFocusHUD() {
    const h = this.hudEl;
    if (!h) return;
    const s = this.focusState;
    if (!s || !s.active || s.mode !== 'focus') { h.style.display = 'none'; return; }
    h.style.display = '';
    const f = this.app.workspace.getActiveFile();
    /* 本章字数（优先实时文本 → 缓存 → 异步读） */
    let words = 0;
    if (f && f.extension === 'md') {
      if (this.liveText != null && this._livePath === f.path) words = countWords(this.liveText);
      else if (this.wordCache[f.path] != null) words = this.wordCache[f.path];
      else {
        this.app.vault.cachedRead(f).then((t) => { this.wordCache[f.path] = countWords(t); this.refreshFocusHUD(); }).catch(() => {});
      }
    }
    const target = f ? this.targetOf(f.path) : 0;
    const pct = Math.min(100, target > 0 ? Math.round(words / target * 100) : 0);
    /* 打字/摸鱼时长来自本章计时：active=码字时长，open-active=摸鱼 */
    const tm = f ? this.chapterTiming(f.path) : { open: 0, active: 0 };
    const idle = Math.max(0, (tm.open || 0) - (tm.active || 0));
    const set = (k, v) => { const n = h.querySelector('[data-k="' + k + '"]'); if (n) n.textContent = v; };
    set('pace', this.pacePerMinute() + ' 字/分');
    set('type', fmtDur(tm.active || 0));
    set('idle', fmtDur(idle));
    set('focus', fmtDur(this.focusElapsed() || 0));
    set('words', fmt(words) + ' 字');
    set('pct', pct + '%');
  }

  /* ---------- 专注壁纸 ---------- */
  clearFocusWallpaper() {
    document.body.classList.remove('nws-focus-on');
    document.body.style.removeProperty('--nws-focus-bg');
    const m = document.getElementById('nws-focus-mask'); if (m) m.remove();
  }
  applyFocusWallpaper(wallpaperId) {
    this.clearFocusWallpaper();
    const wp = FOCUS_WALLPAPERS.find((w) => w.id === wallpaperId) || FOCUS_WALLPAPERS[0];
    if (!wp.css) return;
    document.body.classList.add('nws-focus-on');
    document.body.style.setProperty('--nws-focus-bg', wp.css);
    let mask = document.getElementById('nws-focus-mask');
    if (!mask) { mask = el('div'); mask.id = 'nws-focus-mask'; document.body.appendChild(mask); }
    /* v2.8：遮罩变暗程度可调，越暗越能压住界面杂讯 */
    const dim = clamp(Number(this.settings.focusDim) || 0, 0, 0.9);
    mask.style.opacity = String(dim || 0.001);
  }

  /* ---------- v2.8 禅模式：全屏 + 隐藏侧边栏 + 收窄版心 ---------- */
  enterFocusZen() {
    try {
      const ws = this.app.workspace;
      this._zenSaved = {
        left: !!(ws.leftSplit && ws.leftSplit.collapsed),
        right: !!(ws.rightSplit && ws.rightSplit.collapsed),
      };
      try { if (ws.leftSplit && !ws.leftSplit.collapsed) ws.leftSplit.collapse(); } catch (e) {}
      try { if (ws.rightSplit && !ws.rightSplit.collapsed) ws.rightSplit.collapse(); } catch (e) {}
    } catch (e) {}
    document.body.classList.add('nws-focus-zen');
    try {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    } catch (e) {}
  }
  exitFocusZen() {
    document.body.classList.remove('nws-focus-zen');
    try {
      const ws = this.app.workspace;
      const sv = this._zenSaved || {};
      try { if (ws.leftSplit && sv.left === false && ws.leftSplit.collapsed) ws.leftSplit.expand(); } catch (e) {}
      try { if (ws.rightSplit && sv.right === false && ws.rightSplit.collapsed) ws.rightSplit.expand(); } catch (e) {}
      this._zenSaved = null;
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } catch (e) {}
  }

  /* ---------- v2.8 打字音效：每次敲键响一下（节流 25ms 防连响）
       v2.11：默认静音 + 仅在专注/番茄钟会话中才响；force=true 供设置里试听 ---------- */
  playTypeSound(force) {
    if (!force && !(this.focusState && this.focusState.active)) return; // 非专注会话：一律静音
    const id = this.settings.typeSound;
    if (!id || id === 'off') return;
    const now = Date.now();
    if (now - (this._lastTypeSnd || 0) < 25) return;
    this._lastTypeSnd = now;
    try {
      const ctx = this.ensureAudio(); if (!ctx) return;
      const vol = clamp(Number(this.settings.typeSoundVolume) || 0.35, 0, 1);
      const t = ctx.currentTime;
      if (id === 'type') {
        /* 打字机：短噪声脆响 */
        const len = Math.floor(ctx.sampleRate * 0.02);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
        const src = ctx.createBufferSource(); src.buffer = buf;
        const g = ctx.createGain(); g.gain.value = 0.5 * vol;
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500;
        src.connect(f); f.connect(g); g.connect(ctx.destination);
        src.start(t);
      } else {
        const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
        if (id === 'key') { o.type = 'square'; o.frequency.value = 180 + Math.random() * 140; f.type = 'highpass'; f.frequency.value = 700; }
        else { o.type = 'sine'; o.frequency.value = 480 + Math.random() * 320; f.type = 'lowpass'; f.frequency.value = 1200; }
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.22 * vol, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
        o.connect(f); f.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.05);
      }
    } catch (e) {}
  }

  /* ---------- 程序化音效（Web Audio 合成） ---------- */
  ensureAudio() {
    if (!this._audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this._audioCtx = new AC();
      this._audioNodes = [];
    }
    if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
    return this._audioCtx;
  }
  stopSound() {
    if (this._audioNodes) { this._audioNodes.forEach((n) => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} }); this._audioNodes = []; }
    if (this._soundTimer) { clearInterval(this._soundTimer); this._soundTimer = null; }
    if (this._audioCtx && this._audioCtx.state === 'running') { /* 保留 ctx 复用 */ }
  }
  startSound(soundId) {
    this.stopSound();
    if (!soundId || soundId === 'off') return;
    const ctx = this.ensureAudio(); if (!ctx) return;
    const vol = Number(this.settings.focusSoundVolume) == null ? 0.3 : Number(this.settings.focusSoundVolume);
    const master = ctx.createGain(); master.gain.value = vol; master.connect(ctx.destination);
    this._audioNodes.push(master);
    const blip = (freq, dur, type, gain) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.value = 0; o.connect(g); g.connect(master);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain || 0.5, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    };
    if (soundId === 'rain' || soundId === 'noise') {
      /* 循环白噪音 + 低通，模拟雨声 */
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (soundId === 'rain' ? 0.6 : 0.35);
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const filt = ctx.createBiquadFilter(); filt.type = 'lowpass';
      filt.frequency.value = soundId === 'rain' ? 1800 : 900;
      src.connect(filt); filt.connect(master); src.start();
      this._audioNodes.push(src, filt);
      if (soundId === 'rain') this._soundTimer = setInterval(() => blip(600 + Math.random() * 400, 0.08, 'sine', 0.15), 700 + Math.random() * 500);
    } else if (soundId === 'drip') {
      this._soundTimer = setInterval(() => { blip(900 + Math.random() * 300, 0.12, 'sine', 0.5); setTimeout(() => blip(700, 0.09, 'sine', 0.3), 140); }, 1600);
    } else if (soundId === 'bubble') {
      this._soundTimer = setInterval(() => {
        const base = 200 + Math.random() * 120;
        for (let i = 0; i < 3; i++) setTimeout(() => blip(base + i * 40, 0.18, 'sine', 0.4), i * 130);
      }, 2200);
    }
    /* v2.8：键盘声移入打字音效（playTypeSound），背景音不再包含 */
  }

  /* ---------- 专注会话（专注模式 / 番茄钟共用计时） ---------- */
  startFocusSession(mode, seconds) {
    this.stopFocusSession(true);
    /* v2.13：番茄钟开始计数（完成率统计） */
    if (mode === 'work') {
      const pm = this.data.pomo = this.data.pomo || { started: 0, completed: 0 };
      pm.started++;
    }
    this.focusState = {
      active: true, mode, seconds: 0, paused: false, left: seconds, startedAt: Date.now(),
      wallpaper: this.settings.focusWallpaper, sound: this.settings.focusSound,
    };
    this.applyFocusWallpaper(this.settings.focusWallpaper);
    if (mode === 'focus') {
      /* v2.8：专注模式进入禅状态（全屏+隐藏侧边栏）；番茄钟计时不动界面 */
      if (this.settings.focusFullscreen !== false) this.enterFocusZen();
      this.startSound(this.settings.focusSound);
      this.refreshFocusHUD();
    }
    this.focusState.timer = setInterval(() => {
      const s = this.focusState;
      if (!s.active || s.paused) return;
      s.seconds++; s.left--;
      /* 每秒落盘，防止中途退出丢失 */
      const k = dateKey();
      const d = this.data.daily[k] || (this.data.daily[k] = { words: 0, secs: 0, focus: 0, sessions: 0 });
      if (mode === 'focus') d.focus++;
      this.scheduleSave();
      if (s.left <= 0) { this.finishFocusSession(); return; }
      this.refreshProgressBar();
    }, 1000);
    new Notice('已开始' + (mode === 'focus' ? '专注' : '计时') + '：' + fmtDur(seconds));
  }
  pauseFocusSession() {
    const s = this.focusState;
    if (!s.active) return;
    if (!s.paused) { s.paused = true; this.stopSound(); }
    else { s.paused = false; if (s.mode === 'focus') this.startSound(s.sound); }
  }
  finishFocusSession() {
    const s = this.focusState;
    const mode = s.mode;
    /* v2.13：番茄钟完成计数 */
    if (mode === 'work') {
      const pm = this.data.pomo = this.data.pomo || { started: 0, completed: 0 };
      pm.completed++;
    }
    this.data.focusSessions.push({ ts: Date.now(), mode, seconds: s.seconds || 0 });
    if (this.data.focusSessions.length > 500) this.data.focusSessions.splice(0, this.data.focusSessions.length - 500);
    this.stopFocusSession(false);
    new Notice('⏰ 时间到！本次' + (mode === 'focus' ? '专注' : '计时') + '结束');
    try { const a = this.ensureAudio(); if (a) { const o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.3; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.5); } } catch (e) {}
  }
  stopFocusSession(silent) {
    const s = this.focusState;
    if (s && s.timer) clearInterval(s.timer);
    /* 专注时长由每秒 tick 累加到 daily[k].focus，这里不再重复计时 */
    this.stopSound();
    this.exitFocusZen();
    this.clearFocusWallpaper();
    this.focusState = { active: false, wallpaper: '', sound: null, timer: null, endAt: 0, seconds: 0, paused: false, left: 0, mode: '' };
    if (this.hudEl) this.hudEl.style.display = 'none';
    this.scheduleSave();
    if (!silent) new Notice('专注已结束');
    this.refreshProgressBar();
    this.refreshViews();
  }

  /* ---------- 卷 / 章 ---------- */
  async newChapter(volume) {
    const body = normalizePath(this.settings.folderBody || '正文');
    const inRoot = !volume || volume === '（未分卷）';
    const dir = inRoot ? body : normalizePath(body + '/' + volume);
    try {
      await this.ensureFolder(dir);
      let name = '未命名章节', i = 1, path = normalizePath(dir + '/' + name + '.md');
      while (this.app.vault.getAbstractFileByPath(path)) { name = '未命名章节 ' + (++i); path = normalizePath(dir + '/' + name + '.md'); }
      const f = await this.app.vault.create(path, '');
      await this.setMeta(path, { status: 0 });
      new Notice('已创建空章：' + name);
      await this.app.workspace.getLeaf('tab').openFile(f);
    } catch (e) { new Notice('创建失败：' + ((e && e.message) || e)); }
  }
  async newVolume() {
    const body = normalizePath(this.settings.folderBody || '正文');
    let name = '新卷', i = 1;
    while (this.app.vault.getAbstractFileByPath(normalizePath(body + '/' + name))) { name = '新卷 ' + (++i); }
    try { await this.ensureFolder(normalizePath(body + '/' + name)); await this.newChapter(name); }
    catch (e) { new Notice('创建失败：' + e.message); }
  }
  async renameVolume(volume, newName) {
    if (!newName || !newName.trim()) return;
    newName = newName.trim();
    if (newName === volume || newName === '（未分卷）') return;
    const body = normalizePath(this.settings.folderBody || '正文');
    /* 未分卷 → 新建卷文件夹，把正文根目录下所有 md 章节移入 */
    if (volume === '（未分卷）') {
      const to = normalizePath(body + '/' + newName);
      if (this.app.vault.getAbstractFileByPath(to)) { new Notice('目标卷名已存在'); return; }
      try {
        await this.ensureFolder(to);
        const migrated = Object.create(null);
        const roots = this.app.vault.getMarkdownFiles().filter((f) => {
          const rel = f.path.slice((body + '/').length);
          return f.path.indexOf(body + '/') === 0 && rel.indexOf('/') < 0;
        });
        for (const f of roots) {
          const np = normalizePath(to + '/' + f.name);
          await this.app.vault.rename(f, np);
          if (this.data.chapters[f.path]) { migrated[np] = this.data.chapters[f.path]; delete this.data.chapters[f.path]; }
        }
        Object.assign(this.data.chapters, migrated);
        await this.saveNow();
        await this.rescan(true);
        new Notice('已将 ' + roots.length + ' 章移入新卷：' + newName);
      } catch (e) { new Notice('操作失败：' + (e && e.message || e)); }
      return;
    }
    const from = normalizePath(body + '/' + volume);
    const to = normalizePath(body + '/' + newName);
    const folder = this.app.vault.getAbstractFileByPath(from);
    if (!(folder instanceof TFolder)) { new Notice('未找到卷文件夹：' + volume); return; }
    if (this.app.vault.getAbstractFileByPath(to)) { new Notice('目标卷名已存在'); return; }
    try {
      await this.app.vault.rename(folder, to);
      const migrated = Object.create(null);
      Object.keys(this.data.chapters).forEach((p) => { migrated[p.indexOf(from + '/') === 0 ? to + p.slice(from.length) : p] = this.data.chapters[p]; });
      this.data.chapters = migrated;
      const fixPath = (p) => (p && p.indexOf(from + '/') === 0 ? to + p.slice(from.length) : p);
      this.data.outlines.forEach((o) => (o.bindings || []).forEach((b) => { if (b.kind === 'chapter') b.id = fixPath(b.id); }));
      this.data.entities.forEach((e) => (e.bindings || []).forEach((b) => { if (b.kind === 'chapter') b.id = fixPath(b.id); }));
      await this.saveNow();
      await this.rescan(true);
      new Notice('卷已重命名为：' + newName);
    } catch (e) { new Notice('重命名失败：' + e.message); }
  }
  /* 把一章移动到另一卷（newVolume 为卷名；'（未分卷）' 表示移回正文根目录） */
  async moveChapter(path, newVolume) {
    const body = normalizePath(this.settings.folderBody || '正文');
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) { new Notice('未找到章节文件'); return; }
    const curVolume = this.volumeOfPath(path);
    if (curVolume === newVolume) { new Notice('已在该卷中'); return; }
    const np = newVolume === '（未分卷）'
      ? normalizePath(body + '/' + f.name)
      : normalizePath(body + '/' + newVolume + '/' + f.name);
    if (newVolume !== '（未分卷）') {
      const dir = this.app.vault.getAbstractFileByPath(normalizePath(body + '/' + newVolume));
      if (!(dir instanceof TFolder)) { new Notice('未找到卷：' + newVolume); return; }
    }
    if (this.app.vault.getAbstractFileByPath(np)) { new Notice('目标卷已有同名文件：' + f.name); return; }
    try {
      await this.app.vault.rename(f, np);
      /* 迁移章节数据（状态/目标/计时）与各处绑定引用 */
      if (this.data.chapters[path]) { this.data.chapters[np] = this.data.chapters[path]; delete this.data.chapters[path]; }
      const fix = (p) => (p === path ? np : p);
      this.data.outlines.forEach((o) => (o.bindings || []).forEach((b) => { if (b.kind === 'chapter') b.id = fix(b.id); }));
      this.data.entities.forEach((e) => (e.bindings || []).forEach((b) => { if (b.kind === 'chapter') b.id = fix(b.id); }));
      await this.saveNow();
      await this.rescan(true);
      new Notice('已移动「' + f.name.replace(/\.md$/, '') + '」→ ' + newVolume);
    } catch (e) { new Notice('移动失败：' + (e && e.message || e)); }
  }
  volumeOfPath(path) {
    const body = (this.settings.folderBody || '正文') + '/';
    if (path.indexOf(body) !== 0) return '—';
    const rel = path.slice(body.length);
    const i = rel.indexOf('/');
    return i < 0 ? '（未分卷）' : rel.slice(0, i);
  }
  async openPath(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
    else if (f instanceof TFolder) {
      // 在左侧文件树中揭示文件夹（Obsidian 1.5+ 支持 revealInFolder）
      try {
        const fileExpl = this.app.workspace.getLeavesOfType('file-explorer')[0];
        if (fileExpl && fileExpl.view && fileExpl.view.revealInFolder) fileExpl.view.revealInFolder(f);
        else new Notice('文件夹：' + path);
      } catch (e) { new Notice('文件夹：' + path); }
    } else new Notice('路径不存在：' + path);
  }
  async openChapterByPath(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
  }

  /* ---------- 设定（实体） ---------- */
  typeColor(t) { const c = this.data.typeColors[t]; return Number.isInteger(c) ? c : 2; }
  entityById(id) { return this.data.entities.find((e) => e.id === id); }
  entityByName(name) { return this.data.entities.find((e) => e.name === name || (e.aliases || []).indexOf(name) >= 0); }
  async addEntity(name, type, group) {
    if (!name || !name.trim()) return null;
    const t = type || this.data.entityTypes[0] || '人物';
    const g = group || groupOfLib(t);
    const e = { id: uid(), name: name.trim(), type: t, group: g, color: this.typeColor(t), aliases: [], desc: '', bindings: [], created: Date.now() };
    this.data.entities.push(e);
    await this.writeEntityFile(e, true);
    await this.saveNow(); await this.rescan(true);
    return e;
  }
  async classifySelection(text, type, group) {
    let e = this.entityByName(text);
    if (!e) e = await this.addEntity(text, type, group);
    if (e) {
      e.type = type; e.group = group || groupOfLib(type); e.color = this.typeColor(type);
      await this.writeEntityFile(e, false);
      await this.saveNow(); await this.rescan(true);
    }
    new Notice('已归类「' + text + '」→ ' + (group || groupOfLib(type)) + ' / ' + type + '（设定目录已同步）');
  }
  async recolorSelection(text, color) {
    let e = this.entityByName(text);
    if (!e) e = await this.addEntity(text, this.data.entityTypes[0] || '人物');
    if (e) { e.color = color; await this.writeEntityFile(e, false); await this.saveNow(); this.entityVersion++; this.refreshViews(); }
    new Notice('「' + text + '」' + (color === -1 ? '已设为无颜色（加粗+下划线）' : '高亮已改为' + PALETTE_NAMES[color] + '色'));
  }
  async updateEntity(id, patch) {
    const e = this.entityById(id); if (!e) return;
    Object.assign(e, patch);
    await this.writeEntityFile(e, false);
    await this.saveNow(); await this.rescan(true);
  }
  async deleteEntity(id) {
    const e = this.entityById(id);
    if (e && e.file) {
      const f = this.app.vault.getAbstractFileByPath(e.file);
      if (f instanceof TFile) { try { await this.app.vault.delete(f); } catch (err) { /* 忽略 */ } }
    }
    this.data.entities = this.data.entities.filter((x) => x.id !== id);
    await this.saveNow(); await this.rescan(true);
  }
  /* 打开设定源文件 */
  async openEntityFile(id) {
    const e = this.entityById(id); if (!e) return;
    if (!e.file || !this.app.vault.getAbstractFileByPath(e.file)) { await this.writeEntityFile(e, true); await this.saveNow(); }
    const f = this.app.vault.getAbstractFileByPath(e.file);
    if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
  }

  /* ========== v1.3 情节 CRUD ========== */
  plotById(id) { return this.data.plots.find((p) => p.id === id); }
  async addPlot(fields) {
    const p = {
      id: uid(),
      name: (fields.name || '未命名情节').trim(),
      stages: fields.stages || {},
      roles: fields.roles || [],
      chapters: fields.chapters || [],
      tags: fields.tags || [],
      color: fields.color == null ? 3 : fields.color,
      note: fields.note || '',
      created: Date.now()
    };
    this.data.plots.push(p);
    await this.saveNow(); this.refreshViews();
    return p;
  }
  async updatePlot(id, patch) {
    const p = this.plotById(id); if (!p) return;
    Object.assign(p, patch);
    await this.saveNow(); this.refreshViews();
  }
  async deletePlot(id) {
    this.data.plots = this.data.plots.filter((p) => p.id !== id);
    // 清理双线中指向该情节的绑定
    this.data.lineNodes.forEach((n) => { n.bindings = (n.bindings || []).filter((b) => !(b.kind === 'plot' && b.id === id)); });
    await this.saveNow(); this.refreshViews();
  }
  /* 情节阶段完成度（已填阶段数） */
  plotStageDone(plot) { return PLOT_STAGES.filter((s) => (plot.stages && plot.stages[s.key] || '').trim()).length; }

  /* ========== 时间/空间/情绪多轨 CRUD（v2.4） ==========
     track（轨）: { id, name, axis:'time'|'space'|'emotion', view, bindings, order, created }
     节点 node: { id, trackId, line(兼容旧), view, label, at, order, bindings, content, created }
     显示轴 settings.visibleAxes = ['time','space','emotion'] 任意组合。 */
  trackById(id) { return (this.data.tracks || []).find((t) => t.id === id); }
  tracksOfAxis(axis) {
    return (this.data.tracks || []).filter((t) => t.axis === axis).sort((a, b) => (a.order - b.order) || (a.created - b.created));
  }
  /* 当前显示的轴集合（三轴独立开关；兼容旧 lineMode） */
  visibleAxes() {
    const va = this.settings.visibleAxes;
    if (Array.isArray(va) && va.length) return va;
    const m = this.settings.lineMode || 'both';
    return m === 'time' ? ['time'] : m === 'space' ? ['space'] : ['time', 'space'];
  }
  axisOn(axis) { return this.visibleAxes().indexOf(axis) >= 0; }
  toggleAxis(axis) {
    const cur = this.visibleAxes().slice();
    const i = cur.indexOf(axis);
    if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); }   // 至少保留一条轴显示，避免全空
    else cur.push(axis);
    this.settings.visibleAxes = cur;
    // 按 TRACK_AXES 顺序排列，渲染稳定
    this.settings.visibleAxes = TRACK_AXES.map((a) => a.key).filter((k) => cur.indexOf(k) >= 0);
  }
  visibleTracks() {
    const axes = this.visibleAxes();
    return (this.data.tracks || []).filter((t) => axes.indexOf(t.axis) >= 0)
      .sort((a, b) => (a.axis === b.axis ? (a.order - b.order) : (TRACK_AXES.findIndex((x) => x.key === a.axis) - TRACK_AXES.findIndex((x) => x.key === b.axis))) || (a.created - b.created));
  }
  async addTrack(fields) {
    const peers = this.tracksOfAxis(fields.axis);
    const t = {
      id: uid(), name: (fields.name || trackAxisDef(fields.axis).name).trim(),
      axis: fields.axis, view: fields.view || 'event',
      bindings: fields.bindings || [],
      order: peers.length ? Math.max.apply(null, peers.map((x) => x.order)) + 1 : 0,
      created: Date.now()
    };
    this.data.tracks.push(t);
    await this.saveNow(); this.refreshViews();
    return t;
  }
  async updateTrack(id, patch) {
    const t = this.trackById(id); if (!t) return;
    Object.assign(t, patch);
    /* 改视角时，同步该轨所有节点的 view */
    if (patch.view) (this.data.lineNodes || []).forEach((n) => { if (n.trackId === id) n.view = patch.view; });
    await this.saveNow(); this.refreshViews();
  }
  async deleteTrack(id) {
    this.data.tracks = (this.data.tracks || []).filter((t) => t.id !== id);
    this.data.lineNodes = (this.data.lineNodes || []).filter((n) => n.trackId !== id);
    await this.saveNow(); this.refreshViews();
  }
  async moveTrack(id, dir) {
    const t = this.trackById(id); if (!t) return;
    const list = this.tracksOfAxis(t.axis);
    const i = list.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = t.order, b = list[j].order; t.order = b; list[j].order = a;
    await this.saveNow(); this.refreshViews();
  }

  lineNodeById(id) { return (this.data.lineNodes || []).find((n) => n.id === id); }
  nodesOfLine(line) {
    /* 兼容：line 既可为 trackId，也可为旧 'time'/'space' */
    let trackId = line;
    if (line === 'time') trackId = 'trk_time';
    else if (line === 'space') trackId = 'trk_space';
    return (this.data.lineNodes || []).filter((n) => (n.trackId || (n.line === 'space' ? 'trk_space' : 'trk_time')) === trackId)
      .sort((a, b) => (a.order - b.order) || (a.created - b.created));
  }
  async addLineNode(line, fields) {
    const peers = this.nodesOfLine(line);
    let trackId = line;
    if (line === 'time') trackId = 'trk_time';
    else if (line === 'space') trackId = 'trk_space';
    const track = this.trackById(trackId);
    const vd = trackViewDef(fields.view || (track && track.view) || 'event');
    const n = {
      id: uid(), trackId, line: track ? track.axis : (line === 'space' ? 'space' : 'time'),
      view: fields.view || (track && track.view) || 'event',
      label: (fields.label || vd.node).trim(),
      at: fields.at || '',
      order: fields.order == null ? (peers.length ? Math.max.apply(null, peers.map((x) => x.order)) + 1 : 0) : fields.order,
      bindings: fields.bindings || [], content: fields.content || '', created: Date.now()
    };
    this.data.lineNodes.push(n);
    await this.saveNow(); this.refreshViews();
    return n;
  }
  async updateLineNode(id, patch) {
    const n = this.lineNodeById(id); if (!n) return;
    Object.assign(n, patch);
    await this.saveNow(); this.refreshViews();
  }
  async deleteLineNode(id) {
    this.data.lineNodes = (this.data.lineNodes || []).filter((n) => n.id !== id);
    await this.saveNow(); this.refreshViews();
  }
  async moveLineNode(id, dir) {
    const n = this.lineNodeById(id); if (!n) return;
    const list = this.nodesOfLine(n.trackId || n.line);
    const i = list.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = n.order, b = list[j].order; n.order = b; list[j].order = a;
    await this.saveNow(); this.refreshViews();
  }
  /* 根据节点的绑定生成内容占位文本（供"根据绑定来写"） */
  lineNodeContentHint(n) {
    const vd = trackViewDef(n.view || 'event');
    const parts = (n.bindings || []).map((b) => b.name || b.id);
    return parts.length ? '围绕' + vd.node + '：' + parts.join('、') : '（未绑定对象，点「绑定」关联人物/情节/线索/伏笔；视角：' + vd.name + '）';
  }

  /* ---------- 大纲 ---------- */
  outlineById(id) { return this.data.outlines.find((o) => o.id === id); }
  async addOutline(title, type) {
    if (!title || !title.trim()) return null;
    const o = { id: uid(), title: title.trim(), type: type || '章节', desc: '', bindings: [], tags: [], color: 3, file: '', created: Date.now() };
    this.data.outlines.push(o);
    await this.writeOutlineFile(o, true);
    await this.saveNow(); this.refreshViews();
    return o;
  }
  async updateOutline(id, patch) {
    const o = this.outlineById(id); if (!o) return;
    const oldType = o.type;
    Object.assign(o, patch);
    await this.writeOutlineFile(o, oldType !== o.type); // 改类型时重建模板骨架区
    await this.saveNow(); this.refreshViews();
  }
  async deleteOutline(id) {
    const o = this.outlineById(id);
    if (o && o.file) {
      const f = this.app.vault.getAbstractFileByPath(o.file);
      if (f instanceof TFile) { try { await this.app.vault.delete(f); } catch (e) { /* 忽略 */ } }
    }
    this.data.outlines = this.data.outlines.filter((x) => x.id !== id);
    await this.saveNow(); this.refreshViews();
  }
  /* 绑定：ownerKind='outline'|'entity'；target={kind:'chapter'|'entity'|'outline', id, name} */
  async toggleBinding(ownerKind, ownerId, target) {
    const owner = ownerKind === 'outline' ? this.outlineById(ownerId) : this.entityById(ownerId);
    if (!owner) return;
    owner.bindings = owner.bindings || [];
    const idx = owner.bindings.findIndex((b) => b.kind === target.kind && b.id === target.id);
    if (idx >= 0) owner.bindings.splice(idx, 1);
    else owner.bindings.push({ kind: target.kind, id: target.id, name: target.name || '' });
    // 绑定参数落地到对应 md 文件
    if (ownerKind === 'outline') await this.writeOutlineFile(owner, false);
    else await this.writeEntityFile(owner, false);
    await this.saveNow(); this.refreshViews();
  }

  /* 正文中实体命中范围 */
  mentionRanges(text) {
    const res = [], seen = Object.create(null);
    const push = (from, to, entity) => { const k = from + ':' + to; if (seen[k]) return; seen[k] = 1; res.push({ from, to, entity }); };
    const findAll = (term, entity) => {
      if (!term) return;
      let idx = text.indexOf(term);
      while (idx >= 0) { push(idx, idx + term.length, entity); idx = text.indexOf(term, idx + term.length); }
    };
    if (this.settings.entityAliasMatch) this.data.entities.forEach((e) => (e.aliases || []).forEach((a) => findAll(a, e)));
    if (this.settings.entityNameMatch) this.data.entities.forEach((e) => findAll(e.name, e));
    return res;
  }

  /* ---------- 灵感文件化引擎（v10）：每条灵感 = 灵感/<标题>.md ----------
     frontmatter 存 id/状态/绑定/来源，正文就是灵感内容本身（无引导语）。 */
  inspirationRoot() { return normalizePath(this.settings.folderInspiration || '灵感'); }
  noteFrontmatter(n) {
    return [
      '---',
      'nws_id: ' + n.id,
      'nws_kind: idea',
      'nws_status: ' + String(n.status || '待定'),
      'nws_source: ' + JSON.stringify(String(n.sourcePath || '')),
      'nws_bindings: ' + JSON.stringify(n.bindings || []),
      'nws_created: ' + (n.created || Date.now()),
      '---'
    ].join('\n');
  }
  noteBody(n) { return '\n' + String(n.content || '') + '\n'; }
  /* 用灵感内容截取一个稳定文件名 */
  noteFileName(n) {
    const raw = String(n.content || '灵感').replace(/\s+/g, ' ').trim();
    return this.safeFileName(raw.slice(0, 24) || '灵感');
  }
  /* 新建或更新灵感笔记；update 时保留用户正文（状态/绑定仍写 frontmatter） */
  async writeNoteFile(n, isNew) {
    await this.ensureFolder(this.inspirationRoot());
    let path = n.file && this.app.vault.getAbstractFileByPath(n.file)
      ? n.file
      : normalizePath(this.inspirationRoot() + '/' + this.noteFileName(n) + '.md');
    // 文件名冲突（不同灵感内容前 24 字相同）→ 加短 id 后缀
    const exists = this.app.vault.getAbstractFileByPath(path);
    if (exists instanceof TFile) {
      const other = (this.data.notes || []).find((x) => x.file === path && x.id !== n.id);
      if (other) path = normalizePath(this.inspirationRoot() + '/' + this.noteFileName(n) + '-' + n.id.slice(-4) + '.md');
    }
    let file = this.app.vault.getAbstractFileByPath(path);
    const fm = this.noteFrontmatter(n);
    if (file instanceof TFile) {
      const old = await this.app.vault.cachedRead(file);
      const body = old.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      const newContent = fm + (body || this.noteBody(n));
      if (newContent !== old) await this.app.vault.modify(file, newContent);
    } else {
      file = await this.app.vault.create(path, fm + this.noteBody(n));
    }
    n.file = path;
    return file;
  }
  async readNoteMeta(file) {
    let t = '';
    try { t = await this.app.vault.cachedRead(file); } catch (e) { return null; }
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const get = (k) => { const r = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(m[1]); return r ? r[1].trim() : null; };
    const id = get('nws_id');
    if (!id || get('nws_kind') !== 'idea') return null;
    const PJ = (s, fb) => { try { return JSON.parse(s); } catch (e) { return fb; } };
    const body = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    return {
      id, file: file.path,
      content: body || PJ(get('nws_content') || '""', ''),
      status: get('nws_status') || '待定',
      sourcePath: PJ(get('nws_source') || '""', ''),
      bindings: PJ(get('nws_bindings') || '[]', []),
      created: parseInt(get('nws_created'), 10) || Date.now()
    };
  }
  /* 文件 → 内存：扫描灵感目录 */
  async syncNoteFiles() {
    const root = this.inspirationRoot();
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.indexOf(root + '/') === 0);
    let changed = false;
    for (const f of files) {
      const meta = await this.readNoteMeta(f);
      if (!meta) continue;
      const n = (this.data.notes || []).find((x) => x.id === meta.id);
      if (n) {
        const before = JSON.stringify([n.content, n.status, n.bindings, n.sourcePath]);
        n.content = meta.content; n.status = meta.status; n.bindings = meta.bindings;
        n.sourcePath = meta.sourcePath; n.file = meta.file;
        if (before !== JSON.stringify([n.content, n.status, n.bindings, n.sourcePath])) changed = true;
      } else {
        this.data.notes.push(meta);
        changed = true;
      }
    }
    // 灵感文件被删除 → 从索引移除（仅移除位于灵感目录内的笔记）
    const before = (this.data.notes || []).length;
    this.data.notes = (this.data.notes || []).filter((n) => {
      if (!n.file || n.file.indexOf(root + '/') !== 0) return true;      // 非本目录条目保留
      return !!this.app.vault.getAbstractFileByPath(n.file);            // 文件还在才保留
    });
    if ((this.data.notes || []).length !== before) changed = true;
    if (changed) await this.saveNow();
  }
  /* 内存 → 文件：旧灵感（无 file）落成 md */
  async ensureNoteFiles() {
    let changed = false;
    for (const n of (this.data.notes || [])) {
      if (!n.file || !this.app.vault.getAbstractFileByPath(n.file)) {
        await this.writeNoteFile(n, true);
        changed = true;
      }
    }
    if (changed) await this.saveNow();
  }
  /* 旧 灵感.md：把其中的 "- xxx" 行转成灵感笔记，然后删除该文件 */
  async retireOldInspirationFile() {
    const f = normalizePath(this.settings.inspirationFile || '灵感.md');
    const old = this.app.vault.getAbstractFileByPath(f);
    if (!(old instanceof TFile)) return;
    let text = '';
    try { text = await this.app.vault.cachedRead(old); } catch (e) { return; }
    const lines = text.split('\n').map((s) => s.trim()).filter((s) => /^-\s+/.test(s) && !/自动收集|在正文里输入/.test(s));
    for (const line of lines) {
      const content = line.replace(/^-\s+/, '').split(/\s+·\s+(来源|待定|采用)/)[0].trim();
      if (content && !this.data.notes.some((n) => n.content === content)) {
        const note = { id: uid(), content, sourcePath: '', created: Date.now(), status: '待定', bindings: [], file: '' };
        this.data.notes.push(note);
        await this.writeNoteFile(note, true);
      }
    }
    try { await this.app.vault.delete(old); } catch (e) { /* 忽略 */ }
    await this.saveNow();
  }

  /* ---------- 灵感收集（右键选中 / 【】自动，统一入口） ---------- */
  async captureInspiration(content, sourcePath, opts) {
    opts = opts || {};
    const clean = String(content).replace(/\s+/g, ' ').trim();
    const note = { id: uid(), content: clean, sourcePath: sourcePath || '', created: Date.now(), status: opts.status || '待定', bindings: opts.bindings || [], file: '' };
    await this.writeNoteFile(note, true);
    this.data.notes.unshift(note);
    await this.saveNow(); this.refreshViews();
    new Notice('已收集到灵感笔记：' + clean.slice(0, 18) + (clean.length > 18 ? '…' : ''));
    return note;
  }
  noteById(id) { return (this.data.notes || []).find((n) => n.id === id); }
  async updateNote(id, patch) {
    const n = this.noteById(id); if (!n) return;
    Object.assign(n, patch);
    await this.writeNoteFile(n, false);
    await this.saveNow(); this.refreshViews();
  }
  async deleteNote(id) {
    const n = this.noteById(id);
    if (n && n.file) {
      const f = this.app.vault.getAbstractFileByPath(n.file);
      if (f instanceof TFile) { try { await this.app.vault.delete(f); } catch (e) { /* 忽略 */ } }
    }
    this.data.notes = (this.data.notes || []).filter((x) => x.id !== id);
    await this.saveNow(); this.refreshViews();
  }
  /* 灵感状态：待定 → 采用 / 放弃 */
  async setNoteStatus(id, status) { await this.updateNote(id, { status }); new Notice('灵感状态：' + status); }

  /* ---------- 视图与命令 ---------- */
  async activateView(type) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view && leaf.view.render) leaf.view.render();
  }
  refreshViews() {
    [VIEW_CATALOG, VIEW_OUTLINE, VIEW_ENTITIES, VIEW_NOTES, VIEW_PLOTS, VIEW_LINES, VIEW_STATS].forEach((vt) => {
      this.app.workspace.getLeavesOfType(vt).forEach((leaf) => { if (leaf.view && leaf.view.render) leaf.view.render(); });
    });
  }
  registerCommands() {
    const reg = (id, name, fn) => this.addCommand({ id, name, callback: () => fn() });
    reg('open-catalog', '打开目录（分卷与章节）', () => this.activateView(VIEW_CATALOG));
    reg('open-body-catalog', '打开正文目录', () => this.activateView(VIEW_CATALOG));
    reg('open-outline', '打开大纲', () => this.activateView(VIEW_OUTLINE));
    reg('open-entities', '打开设定库', () => this.activateView(VIEW_ENTITIES));
    reg('open-plots', '打开情节', () => this.activateView(VIEW_PLOTS));
    reg('open-lines', '打开时间/空间/情绪线', () => this.activateView(VIEW_LINES));
    reg('new-plot', '新建情节', () => { new PlotModal(this.app, this, null).open(); });
    reg('find-replace', '查找替换（当前文档）', () => new FindReplaceModal(this.app, this).open());
    reg('open-notes', '打开灵感', () => this.activateView(VIEW_NOTES));
    reg('new-chapter', '新建章节（空章）', () => this.newChapter('（未分卷）'));
    reg('new-volume', '新建卷', () => this.newVolume());
    reg('open-inspiration', '打开灵感目录', () => this.openPath(this.inspirationRoot()));
    reg('sync-setting-files', '同步设定库文件（从 md 重建索引）', async () => { await this.syncFilesToIndex(); await this.ensureEntityFiles(); await this.rescan(true); new Notice('设定库文件已同步'); });
    reg('sync-outline-files', '同步大纲文件（从 md 重建索引）', async () => { await this.syncOutlineFiles(); await this.ensureOutlineFiles(); await this.refreshViews(); new Notice('大纲文件已同步'); });
    reg('sync-all-files', '同步全部文件（设定 + 大纲）', async () => {
      await this.syncFilesToIndex(); await this.syncOutlineFiles();
      await this.ensureEntityFiles(); await this.ensureOutlineFiles();
      await this.rescan(true); new Notice('设定库与大纲文件均已同步');
    });
    reg('open-setting-root', '打开设定库文件夹', () => this.openPath(normalizePath(this.settings.folderSetting)));
    reg('open-outline-root', '打开大纲文件夹', () => this.openPath(normalizePath(this.settings.folderOutline)));
    /* v2.1 */
    reg('open-stats', '打开数据中心（热力图/码字统计）', () => this.activateView(VIEW_STATS));
    reg('focus-mode', '专注模式（壁纸+音效+实时速度）', () => new FocusModal(this.app, this, 'focus').open());
    reg('pomodoro', '番茄钟', () => new FocusModal(this.app, this, 'pomodoro').open());
    reg('set-chapter-target', '设定本章目标字数', () => this.setActiveChapterTarget());
    reg('chapter-stats', '本章数据统计（目标/速度/专注/设定分布/Top10）', () => {
      const f = this.app.workspace.getActiveFile();
      if (!f || !this.isChapterPath(f.path)) { new Notice('请先打开正文目录下的一个章节'); return; }
      new ChapterStatsModal(this.app, this, f.path).open();
    });
    reg('move-chapter', '移动当前章节到其他分卷', () => {
      const f = this.app.workspace.getActiveFile();
      if (!f || !this.isChapterPath(f.path)) { new Notice('请先打开正文目录下的一个章节'); return; }
      new ChapterMoveModal(this.app, this, f.path).open();
    });
    reg('open-annots', '打开批注列表', () => this.activateView(VIEW_ANNOT));
    reg('add-annotation', '给选中文字添加批注', () => {
      const md = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!md || !md.editor) { new Notice('请先在正文中选中一段文字'); return; }
      const ed = md.editor;
      const sel = ed.getSelection();
      if (!sel || !sel.trim()) { new Notice('请先选中一段文字'); return; }
      let from = 0, to = 0;
      try { from = ed.posToOffset(ed.getCursor('from')); to = ed.posToOffset(ed.getCursor('to')); } catch (e) { /* 忽略 */ }
      new AnnotationModal(this.app, this, this.app.workspace.getActiveFile().path, sel.trim(), from, to).open();
    });
    reg('focus-toggle', '开始/结束专注', () => this.focusState.active ? this.stopFocusSession() : (new FocusModal(this.app, this, 'focus').open()));
    reg('sync-appearances', '立即刷新设定笔记的出场章节统计', async () => { await this.syncEntityAppearances(); new Notice('出场章节统计已更新'); });
    /* v2.2：选字操作的命令面板兜底（右键菜单失效时可用，也可绑快捷键） */
    const selCmd = (id, name, fn) => this.addCommand({
      id, name,
      editorCallback: (editor) => {
        const s = editor.getSelection ? editor.getSelection() : '';
        if (!s || !s.trim()) { new Notice('请先在正文选中文字'); return; }
        fn(s.trim());
      }
    });
    selCmd('sel-to-inspiration', '【选中文字】保存为灵感', async (text) => {
      const file = this.app.workspace.getActiveFile();
      const note = await this.captureInspiration(text, file ? file.path : '');
      if (note) new InspirationEditModal(this.app, this, note).open();
    });
    QUICK_CLASSIFY.forEach((q) => selCmd('sel-to-' + q.type, '【选中文字】设为' + q.type,
      (text) => this.classifySelection(text, q.type, q.group)));
    selCmd('sel-to-entity', '【选中文字】设为设定（自选大类）', (text) => {
      new EntityCreateModal(this.app, this, null, null, text).open();
    });
  }

  /* ---------- 右键选字归类 ---------- */
  registerContextMenu() {
    /* v2.7：事件名修正——Obsidian API 是 'editor-menu'（旧版误写为 'editor-context-menu' 导致菜单从不出现） */
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      const sel = editor && editor.getSelection ? editor.getSelection() : '';
      if (!sel || !sel.trim()) return;
      const text = sel.trim();
      const p = this;
      menu.addSeparator();
      menu.addItem((item) => item.setTitle('💡 保存为灵感').setIcon('lightbulb')
        .onClick(async () => {
          const file = p.app.workspace.getActiveFile();
          const note = await p.captureInspiration(text, file ? file.path : '');
          if (note) new InspirationEditModal(p.app, p, note).open();
        }));
      menu.addSeparator();
      /* v2.7：选中文字批注（不改原文，悬浮显示，目录表格管理） */
      menu.addItem((item) => item.setTitle('📝 添加批注').setIcon('sticky-note')
        .onClick(() => {
          const file = p.app.workspace.getActiveFile();
          let from = 0, to = 0;
          try {
            from = editor.posToOffset(editor.getCursor('from'));
            to = editor.posToOffset(editor.getCursor('to'));
          } catch (e) { /* 忽略 */ }
          new AnnotationModal(p.app, p, file ? file.path : '', text, from, to).open();
        }));
      menu.addSeparator();
      QUICK_CLASSIFY.forEach((q) => {
        menu.addItem((item) => item.setTitle(q.emoji + ' 设为' + q.type).setIcon('tag')
          .onClick(async () => { await p.classifySelection(text, q.type, q.group); }));
      });
      menu.addSeparator();
      /* 按大类 → 小库 两级归类（覆盖全部类型；无法归类归入「独立」） */
      ENTITY_GROUPS.forEach((g) => {
        menu.addItem((item) => {
          item.setTitle(g.emoji + ' 设为设定 · ' + g.name + ' ▸').setIcon('tag');
          const sub = item.setSubmenu();
          libsOfGroup(g.name).forEach((l) => {
            const def = LIB_BY_NAME[l];
            sub.addItem((si) => si.setTitle((def ? def.emoji + ' ' : '') + l).onClick(async () => { await p.classifySelection(text, l, g.name); }));
          });
        });
      });
      menu.addItem((item) => item.setTitle('🖋️ 设为设定（自选大类…）').setIcon('plus')
        .onClick(() => new EntityCreateModal(p.app, p, null, null, text).open()));
      try {
        menu.addItem((item) => {
          item.setTitle('🎨 更换高亮颜色').setIcon('palette');
          const sub = item.setSubmenu();
          PALETTE_NAMES.forEach((cn, ci) => sub.addItem((si) => si.setTitle(cn + '色').onClick(async () => { await p.recolorSelection(text, ci); })));
        });
      } catch (e) {
        PALETTE_NAMES.forEach((cn, ci) => menu.addItem((item) => item.setTitle('🎨 高亮为' + cn + '色').onClick(async () => { await p.recolorSelection(text, ci); })));
      }
    }));
  }

  /* ---------- 悬浮卡 ---------- */
  buildHover() {
    let h = document.getElementById('nws-hover');
    if (!h) { h = el('div'); h.id = 'nws-hover'; document.body.appendChild(h); }
    this.hoverEl = h;
    h.addEventListener('mouseenter', () => { clearTimeout(this.hoverTimer); clearTimeout(this.hoverHideTimer); });
    h.addEventListener('mouseleave', () => this.hideHover());
    h.addEventListener('click', (e) => {
      if (!this.hoverEntity) return;
      e.preventDefault(); e.stopPropagation();
      const ent = this.hoverEntity; this.hideHover();
      this.openEntityFile(ent.id);   // 点击直接打开该设定的具体内容
    });
  }
  /* 从缓存读取设定文件内容预览（去掉 frontmatter/标题/空模板字段后填充） */
  entityContentPreview(entity) {
    if (!this._hoverCache) return '';
    return this._hoverCache[entity.id] || '';
  }
  async cacheEntityContent(entity) {
    if (!entity || !entity.file) return;
    if (!this._hoverCache) this._hoverCache = Object.create(null);
    if (!this._hoverCacheAt) this._hoverCacheAt = Object.create(null);
    const now = Date.now();
    if (this._hoverCache[entity.id] !== undefined && now - (this._hoverCacheAt[entity.id] || 0) < 3000) return;
    const f = this.app.vault.getAbstractFileByPath(entity.file);
    if (!(f instanceof TFile)) return;
    try {
      let t = fileBody(await this.app.vault.cachedRead(f));
      t = t.split('\n').filter((line) => {
        const s = line.trim();
        if (!s) return false;
        if (/^#\s/.test(s)) return false;                 // 主标题
        if (/^>\s/.test(s)) return false;                 // 模板说明引用行
        if (/^##\s+/.test(s)) return false;                // 空/字段名占位（下面有内容才显示）
        return true;
      }).join(' ').replace(/[ \t]+/g, ' ').trim();
      this._hoverCache[entity.id] = t.slice(0, 280);
      this._hoverCacheAt[entity.id] = now;
    } catch (e) { this._hoverCache[entity.id] = ''; this._hoverCacheAt[entity.id] = now; }
  }
  showHover(entity, x, y) {
    if (!this.hoverEl) return;
    clearTimeout(this.hoverTimer); clearTimeout(this.hoverHideTimer);
    this.hoverEntity = entity;
    const h = this.hoverEl;
    const pe = this.stats.perEntity[entity.id] || { total: 0, first: '—' };
    const grp = entity.group || groupOfLib(entity.type);
    const render = (content) => {
      h.innerHTML =
        '<div class="h"><span>' + groupEmoji(grp) + '</span><span class="n">' + escapeHtml(entity.name) + '</span>' +
        '<span class="t">' + escapeHtml(grp) + ' · ' + escapeHtml(entity.type || '') + '</span></div>' +
        '<div class="d nws-hover-content">' + escapeHtml(content || entity.desc || '（尚未填写具体内容）') + '</div>' +
        '<div class="f"><span>别名：' + escapeHtml((entity.aliases || []).join('、') || '无') + '</span><span>出现 ' + pe.total + ' 次</span></div>' +
        '<div class="f" style="border:none;padding-top:3px"><span>首次：' + escapeHtml(pe.first || '—') + '</span><span class="nws-lnk">点击打开 · 正文单击设定词即可跳转 →</span></div>';
    };
    render(this.entityContentPreview(entity));
    /* 异步补充文件内容预览（若已缓存则立即刷新） */
    this.cacheEntityContent(entity).then(() => {
      if (this.hoverEntity && this.hoverEntity.id === entity.id) render(this.entityContentPreview(entity));
    });
    const fire = () => {
      h.style.display = 'block';
      const top = Math.min(y + 14, window.innerHeight - 210);
      h.style.left = Math.min(x + 12, window.innerWidth - 272) + 'px';
      h.style.top = Math.max(8, top) + 'px';
    };
    if (this.settings.hoverDelay) this.hoverTimer = setTimeout(fire, this.settings.hoverDelay);
    else fire();
  }
  hideHover() {
    clearTimeout(this.hoverTimer); clearTimeout(this.hoverHideTimer);
    this.hoverHideTimer = setTimeout(() => { if (this.hoverEl) this.hoverEl.style.display = 'none'; }, 220);
  }

  /* ---------- v2.7 批注：选中文字做批注，不改原文，悬浮显示 ---------- */
  buildAnnotHover() {
    let h = document.getElementById('nws-annot-hover');
    if (!h) { h = el('div'); h.id = 'nws-annot-hover'; document.body.appendChild(h); }
    this.annotHoverEl = h;
    h.addEventListener('mouseenter', () => clearTimeout(this.annotHideTimer));
    h.addEventListener('mouseleave', () => this.hideAnnotHover());
    h.addEventListener('click', (e) => {
      const del = e.target.closest('[data-adel]');
      if (del) { this.deleteAnnotation(del.dataset.adel); this.hideAnnotHover(); }
    });
  }
  showAnnotHover(a, x, y) {
    if (!this.annotHoverEl) return;
    clearTimeout(this.annotHideTimer);
    const h = this.annotHoverEl;
    const chap = (this.allChapters().find((c) => c.path === a.path) || {}).title || a.path.split('/').pop().replace(/\.md$/, '');
    h.innerHTML =
      '<div class="h">📝 批注 · <span class="t">' + escapeHtml(chap) + '</span></div>' +
      '<div class="q">「' + escapeHtml(String(a.quote || '').slice(0, 60)) + (String(a.quote || '').length > 60 ? '…' : '') + '」</div>' +
      '<div class="d">' + escapeHtml(a.note || '（无内容）') + '</div>' +
      '<div class="f"><span>' + new Date(a.created).toLocaleString() + '</span><span class="nws-lnk" data-adel="' + a.id + '">删除批注</span></div>';
    h.style.display = 'block';
    h.style.left = Math.min(x + 12, window.innerWidth - 280) + 'px';
    h.style.top = Math.min(y + 14, window.innerHeight - 200) + 'px';
  }
  hideAnnotHover() {
    clearTimeout(this.annotHideTimer);
    this.annotHideTimer = setTimeout(() => { if (this.annotHoverEl) this.annotHoverEl.style.display = 'none'; }, 220);
  }
  annotById(id) { return (this.data.annotations || []).find((a) => a.id === id); }
  async addAnnotation(path, quote, note, from, to) {
    const a = { id: uid(), path, quote, note: note || '', from: from || 0, to: to || 0, created: Date.now() };
    this.data.annotations.push(a);
    await this.saveNow();
    this.entityVersion++;   // 触发装饰层重建
    this.refreshViews();
    new Notice('已添加批注');
    return a;
  }
  async updateAnnotation(id, patch) { const a = this.annotById(id); if (!a) return; Object.assign(a, patch); await this.saveNow(); this.entityVersion++; this.refreshViews(); }
  async deleteAnnotation(id) {
    this.data.annotations = (this.data.annotations || []).filter((a) => a.id !== id);
    await this.saveNow(); this.entityVersion++; this.refreshViews();
    new Notice('批注已删除');
  }
  /* 从目录/面板跳回原文批注位置：打开文件后滚动并选中该段 */
  async jumpToAnnotation(a) {
    await this.openChapterByPath(a.path);
    setTimeout(() => {
      try {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!md || !md.editor) return;
        const ed = md.editor, doc = ed.getValue();
        let idx = doc.indexOf(a.quote, Math.max(0, Math.min(a.from || 0, doc.length)));
        if (idx < 0) idx = doc.indexOf(a.quote);
        if (idx < 0) { new Notice('原文已修改，找不到该批注的原文位置'); return; }
        const from = ed.offsetToPos(idx), to = ed.offsetToPos(idx + a.quote.length);
        ed.setSelection(from, to);
        ed.scrollIntoView({ from: { line: from.line, ch: 0 }, to: { line: from.line, ch: 0 } }, true);
      } catch (e) { /* 忽略 */ }
    }, 350);
  }

  /* ---------- v2.9.1：设定笔记「出场章节」自动统计 ---------- */
  /* 生成某设定的出场章节表格（章节按分卷/顺序排序，链接可点击跳转） */
  appearSection(entityId) {
    const stats = this.stats || {};
    const pe = stats.perEntity ? stats.perEntity[entityId] : null;
    const e = pe ? pe.entity : this.entityById(entityId);
    if (!e) return '';
    const counts = pe ? pe.chapters : {};
    let total = 0, rows = [];
    for (const ch of (stats.chapters || [])) {
      const n = counts[ch.path];
      if (!n) continue;
      total += n;
      rows.push('| [[' + String(ch.path).replace(/\.md$/, '') + '\\|' + ch.title + ']] | ' + n + ' |');
    }
    const head = '## 📍 出场章节（自动统计 · 共 ' + total + ' 次 · ' + rows.length + ' 章 · 点击章节名可跳转）\n\n'
      + '| 章节 | 出场次数 |\n| --- | --- |\n';
    return NWS_APPEAR_MARK + '\n' + head + (rows.length ? rows.join('\n') : '| — | 暂无出场记录 |') + '\n';
  }
  /* 把出场章节表写进每个设定笔记（有标记则替换标记后内容；无则追加文末） */
  async syncEntityAppearances() {
    if (this.settings.appearSync === false) return;
    try {
      if (!this.stats || !this.stats.chapters) return;
      for (const e of this.data.entities) {
        if (!e.file) continue;
        const f = this.app.vault.getAbstractFileByPath(e.file);
        if (!(f instanceof TFile)) continue;
        let text = '';
        try { text = await this.app.vault.cachedRead(f); } catch (err) { continue; }
        const sec = this.appearSection(e.id);
        if (!sec) continue;
        const idx = text.indexOf(NWS_APPEAR_MARK);
        const base = idx >= 0 ? text.slice(0, idx).replace(/\s+$/, '') : text.replace(/\s+$/, '');
        const newContent = base + '\n\n' + sec;
        if (newContent !== text) await this.app.vault.modify(f, newContent);
      }
    } catch (err) { console.error('[小说写作台] 出场章节同步失败:', err); }
  }

  /* ---------- CM6 正文装饰层 ---------- */
  buildMarkExtension() {
    const plugin = this;
    const nwsMark = ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        this.version = -1;
        this.mentions = [];
        this.decorations = this.build();
        this._move = (e) => this.onMove(e);
        this._leave = () => plugin.hideHover();
        this._down = (e) => { this._downX = e.clientX; this._downY = e.clientY; };
        this._click = (e) => this.onClick(e);
        view.dom.addEventListener('mousemove', this._move);
        view.dom.addEventListener('mouseleave', this._leave);
        view.dom.addEventListener('mousedown', this._down);
        view.dom.addEventListener('click', this._click);
      }
      /* v3.0：点击正文设定词 → 直接打开该设定笔记
         默认单击即跳；拖动选字（mousedown→click 位移>4px）不触发，避免打断编辑。
         设置 entityClickJump=false 时退回仅 Ctrl/Cmd+点击。*/
      onClick(e) {
        const moved = Math.abs(e.clientX - (this._downX ?? e.clientX)) + Math.abs(e.clientY - (this._downY ?? e.clientY));
        if (moved > 4) return; // 拖动选字，不跳
        const singleClick = plugin.settings.entityClickJump !== false;
        if (!singleClick && !(e.ctrlKey || e.metaKey)) return;
        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return;
        const m = (this.mentions || []).find((x) => pos >= x.from && pos < x.to);
        if (m) { e.preventDefault(); plugin.openEntityFile(m.entity.id); plugin.hideHover(); }
      }
      update(u) {
        if (u.docChanged) {
          /* v2.8：打字音效——真实敲键才响一下 */
          plugin.playTypeSound();
          if (plugin.settings.autoCollectBracket && !plugin.capturing) this.detectCapture(u);
          /* v2.1 码字统计：只统计正文目录下文件，按字数增量记账 */
          const f = plugin.app.workspace.getActiveFile();
          const bodyDir = normalizePath(plugin.settings.folderBody || '正文');
          if (f && f.extension === 'md' && f.path.indexOf(bodyDir + '/') === 0) {
            const text = u.state.doc.toString();
            const now = countWords(text);
            const before = (plugin.liveCounts[f.path] != null) ? plugin.liveCounts[f.path] : (plugin.wordCache[f.path] || 0);
            const delta = now - before;
            plugin.liveCounts[f.path] = now;
            plugin.liveText = text; plugin._livePath = f.path;
            if (delta > 0) plugin.recordTyping(f.path, delta);
            else if (delta < 0) plugin.recordDeletion(-delta);
            else plugin.refreshProgressBar();
          }
        }
        if (u.docChanged || u.selectionSet || u.viewportChanged || this.version !== plugin.entityVersion) this.decorations = this.build();
      }
      detectCapture(u) {
        let closePos = -1;
        u.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          const s = inserted.toString();
          const idx = s.lastIndexOf('】');
          if (idx >= 0) closePos = fromB + idx;
        });
        if (closePos < 0) return;
        const text = u.state.doc.toString();
        const re = /【[^【】]{0,300}】/g;
        let m, hit = null;
        while ((m = re.exec(text)) !== null) { if (m.index + m[0].length - 1 === closePos) { hit = m; break; } }
        if (!hit) return;
        const open = hit.index, content = hit[0].slice(1, -1);
        const file = plugin.app.workspace.getActiveFile();
        const path = file ? file.path : '';
        plugin.capturing = true;
        const view = u.view;
        setTimeout(() => {
          try {
            const len = view.state.doc.length;
            if (closePos + 1 <= len && view.state.doc.sliceString(open, open + 1) === '【' && view.state.doc.sliceString(closePos, closePos + 1) === '】') {
              view.dispatch({ changes: { from: open, to: closePos + 1 }, selection: { anchor: open } });
            }
          } catch (e) { /* 忽略 */ }
          plugin.capturing = false;
        }, 0);
        if (content.trim()) plugin.captureInspiration(content, path);
      }
      onMove(e) {
        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) { plugin.hideHover(); plugin.hideAnnotHover(); return; }
        /* 批注优先：悬浮在批注底纹上显示批注内容 */
        const ann = (this.annotRanges || []).find((x) => pos >= x.from && pos < x.to);
        if (ann) { plugin.hideHover(); plugin.showAnnotHover(ann.annot, e.clientX, e.clientY); return; }
        plugin.hideAnnotHover();
        const m = this.mentions.find((x) => pos >= x.from && pos < x.to);
        if (m) plugin.showHover(m.entity, e.clientX, e.clientY);
        else plugin.hideHover();
      }
      build() {
        const state = this.view.state;
        const text = state.doc.toString();
        this.version = plugin.entityVersion;
        const ranges = [];
        if (plugin.settings.dialogueHighlight) {
          const re = plugin.settings.dialogueEnglish ? /[“"][^”"]*[”"]/g : /“[^”]*”/g;
          let m;
          while ((m = re.exec(text)) !== null) ranges.push({ kind: 'dialogue', from: m.index, to: m.index + m[0].length, deco: Decoration.mark({ class: 'nws-dialogue' }) });
        }
        if (plugin.settings.noteChip) {
          const re2 = /【[^【】]{0,300}】/g; let m2;
          while ((m2 = re2.exec(text)) !== null) ranges.push({ kind: 'note', from: m2.index, to: m2.index + m2[0].length, deco: Decoration.mark({ class: 'nws-note-chip' }) });
        }
        this.mentions = [];
        if (plugin.settings.entityHighlight) {
          this.mentions = plugin.mentionRanges(text);
          for (const r of this.mentions) {
            const e = r.entity;
            /* v2.11：正文纯净无 emoji——不在装饰属性里写入任何类型图标 */
            const colorClass = hasEntityColor(e) ? ('nws-colored nws-c' + (e.color % 6)) : 'nws-nocolor';
            ranges.push({
              from: r.from, to: r.to, kind: 'entity',
              deco: Decoration.mark({
                class: 'nws-entity ' + colorClass,
                attributes: { 'title': String(e.name || '') + (e.type ? ' · ' + e.type : '') }
              })
            });
          }
        }
        if (plugin.settings.currentPara || plugin.settings.typingMode) {
          const head = state.selection.main.head;
          const line = state.doc.lineAt(head);
          const empty = (n) => state.doc.line(n).text.trim() === '';
          /* 当前段范围（以空行分段） */
          let s = line.number, e = line.number;
          while (s > 1 && !empty(s - 1)) s--;
          while (e < state.doc.lines && !empty(e + 1)) e++;
          if (plugin.settings.typingMode) {
            /* 打字模式：当前段高亮；前后段按距离逐级减淡 */
            const radius = Math.max(1, Number(plugin.settings.typingRadius) || 2);
            for (let n = s; n <= e; n++) {
              const ln = state.doc.line(n);
              ranges.push({ from: ln.from, to: ln.from, line: true, deco: Decoration.line({ class: 'nws-tp-cur' }) });
            }
            /* 向前找 radius 段 */
            let ps = s - 1, dist = 1;
            while (ps >= 1 && dist <= radius) {
              let pe = ps;
              while (pe >= 1 && !empty(pe)) pe--;
              const start = pe + 1, end = ps;
              for (let n = start; n <= end; n++) { const ln = state.doc.line(n); ranges.push({ from: ln.from, to: ln.from, line: true, deco: Decoration.line({ class: 'nws-tp-fade f' + dist }) }); }
              ps = pe - 1; dist++;
              while (ps >= 1 && empty(ps)) ps--;
            }
            /* 向后找 radius 段 */
            let ne = e + 1; dist = 1;
            while (ne <= state.doc.lines && dist <= radius) {
              let ns = ne;
              while (ns <= state.doc.lines && !empty(ns)) ns++;
              const start = ne, end = ns - 1;
              for (let n = start; n <= end; n++) { const ln = state.doc.line(n); ranges.push({ from: ln.from, to: ln.from, line: true, deco: Decoration.line({ class: 'nws-tp-fade f' + dist }) }); }
              ne = ns + 1; dist++;
              while (ne <= state.doc.lines && empty(ne)) ne++;
            }
          } else {
            for (let n = s; n <= e; n++) { const ln = state.doc.line(n); ranges.push({ from: ln.from, to: ln.from, line: true, deco: Decoration.line({ class: 'nws-curpara' }) }); }
          }
        }
        /* v2.7：批注底纹（选中文字做批注，不改原文） */
        this.annotRanges = [];
        const cf = plugin.app.workspace.getActiveFile();
        if (cf && plugin.settings.annotShow !== false) {
          const anns = (plugin.data.annotations || []).filter((a) => a.path === cf.path && a.quote);
          for (const a of anns) {
            let idx = text.indexOf(a.quote, Math.max(0, Math.min(a.from || 0, Math.max(0, text.length - 1))));
            if (idx < 0) idx = text.indexOf(a.quote);
            if (idx < 0) continue;
            ranges.push({ from: idx, to: idx + a.quote.length, kind: 'annot', deco: Decoration.mark({ class: 'nws-annot' }) });
            this.annotRanges.push({ from: idx, to: idx + a.quote.length, annot: a });
          }
        }
        /* 码字里程碑——每满 300 字，在该行右侧标注（300/600/900…） */
        if (plugin.settings.milestoneMark !== false) {
          const stepSize = Math.max(100, Number(plugin.settings.milestoneStep) || 300);
          let cum = 0, next = stepSize;
          for (let n = 1; n <= state.doc.lines; n++) {
            const ln = state.doc.line(n);
            cum += countWords(ln.text);
            if (cum >= next) {
              const reached = Math.floor(cum / stepSize) * stepSize;
              ranges.push({ from: ln.from, to: ln.from, line: true, kind: 'mile', deco: Decoration.line({ class: 'nws-milestone', attributes: { 'data-m': String(reached) } }) });
              next = (Math.floor(cum / stepSize) + 1) * stepSize;
            }
          }
        }
        /* 排序 + 去重：交给 Decoration.set(sort=true)，由 CM6 保证合法顺序 */
        const decos = [];
        const seen = Object.create(null);
        for (const r of ranges) {
          if (!r.line && r.to <= r.from) continue;
          const key = r.from + ':' + r.to + ':' + ((r.deco.spec && r.deco.spec.class) || '');
          if (seen[key]) continue;
          seen[key] = 1;
          decos.push(r.line ? r.deco.range(r.from, r.from) : r.deco.range(r.from, r.to));
        }
        return Decoration.set(decos, true);
      }
      destroy() {
        this.view.dom.removeEventListener('mousemove', this._move);
        this.view.dom.removeEventListener('mouseleave', this._leave);
        this.view.dom.removeEventListener('mousedown', this._down);
        this.view.dom.removeEventListener('click', this._click);
        plugin.hideHover(); plugin.hideAnnotHover();
      }
    }, { decorations: (v) => v.decorations });
    return [nwsMark];
  }
}

/* 主类结束，视图/弹窗/设置页面将在下方追加 */

/* ================= 面板视图 ================= */
function setViewRoot(view, html) {
  view.contentEl.empty();
  const root = el('div', 'nws-root nws-view');
  root.innerHTML = html;
  view.contentEl.appendChild(root);
  return root;
}

/* ---------- 目录（分卷 + 章节） ---------- */
class CatalogView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_CATALOG; }
  getDisplayText() { return '写作台 · 目录'; }
  getIcon() { return 'folder-tree'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const chapters = p.allChapters();
    const total = chapters.reduce((s, c) => s + c.words, 0);
    const vols = Object.create(null);
    chapters.forEach((c) => { (vols[c.volume] = vols[c.volume] || []).push(c); });
    let body = '';
    Object.keys(vols).forEach((v) => {
      const list = vols[v];
      const vw = list.reduce((s, c) => s + c.words, 0);
      const renameBtn = '<button class="nws-btn sm nws-vol-ren" data-ren="' + escapeHtml(v) + '" title="重命名卷">✎</button>';
      const vstatBtn = '<button class="nws-btn sm nws-chbtn" data-vstat="' + escapeHtml(v) + '" title="本卷数据分析：字数/状态/速度/设定出现">📊</button>';
      body += '<div class="nws-vol" data-vol="' + escapeHtml(v) + '"><div class="nws-vol-h">' +
        '<span class="nws-vol-name" data-ren="' + escapeHtml(v) + '" title="点击重命名卷">📁 ' + escapeHtml(v) + '</span>' +
        '<span class="nws-vol-tools"><span class="wc">' + fmt(vw) + ' 字</span>' + vstatBtn + renameBtn + '</span></div>';
      list.forEach((c) => {
        const st = c.status == null ? (c.words > 0 ? 1 : 0) : c.status;
        const target = p.targetOf(c.path);
        // 每章设定统计摘要
        const chMap = p.stats.perChapter[c.path] || {};
        const topEnts = Object.keys(chMap).sort((a, b) => chMap[b] - chMap[a]).slice(0, 3)
          .map((id) => { const e = p.entityById(id); return e ? escapeHtml(e.name) + '×' + chMap[id] : ''; }).filter(Boolean).join(' · ');
        const stOpts = CH_STATUS.map((s, i) => '<option value="' + i + '"' + (i === st ? ' selected' : '') + '>' + s + '</option>').join('');
        body += '<div class="nws-chap" data-path="' + escapeHtml(c.path) + '" draggable="true">' +
          '<span class="nws-st s' + st + '"></span>' +
          '<span class="t">' + escapeHtml(c.title) + '</span>' +
          (topEnts ? '<span class="nws-chents" title="本章设定出现">' + topEnts + '</span>' : '') +
          '<select class="nws-status-sel s' + st + '" data-status="' + escapeHtml(c.path) + '" title="章节状态">' + stOpts + '</select>' +
          '<span class="w" data-target="' + escapeHtml(c.path) + '" title="目标 ' + fmt(target) + ' 字 · 点击修改">' + fmt(c.words) + '</span>' +
          '<button class="nws-btn sm nws-chbtn" data-cmove="' + escapeHtml(c.path) + '" title="移动到其他分卷">📁</button>' +
          '<button class="nws-btn sm nws-chbtn" data-cstat="' + escapeHtml(c.path) + '" title="本章统计：目标/速度/专注/设定分类/Top10">📊</button>' +
          '</div>';
      });
      body += '<button class="nws-btn sm nws-vol-add" data-act="newchap" data-vol="' + escapeHtml(v) + '">＋ 在本卷新建章</button>';
      body += '</div>';
    });
    if (!body) body = '<div class="nws-empty">正文目录暂无章节。<br>点击「＋ 新建卷」或「＋ 新建章节」开始。</div>';

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">目录 <span class="nws-tag g">' + escapeHtml((function(){ try { return p.app.vault.getName(); } catch (e) { return ''; } })()) + '</span></div>' +
      '<div class="nws-sp"></div><button class="nws-btn" data-act="newvol">＋ 新建卷</button><button class="nws-btn pri" data-act="newchap-top">＋ 新建章</button></div>' +
      '<div class="nws-psub">' + chapters.length + ' 章 · ' + fmt(total) + ' 字 · 拖动章节可移入其他卷 · 点卷名/✎ 重命名 · 点字数设目标</div>' +
      '<div class="nws-folders">' +
      '<button class="nws-fold" data-view="outline">📋 大纲</button>' +
      '<button class="nws-fold" data-view="entities">⚙️ 设定</button>' +
      '<button class="nws-fold" data-view="plots">🧩 情节</button>' +
      '<button class="nws-fold" data-view="lines">⏳🗺️ 双线</button>' +
      '<button class="nws-fold on" data-view="catalog">📖 正文</button>' +
      '<button class="nws-fold" data-view="notes">💡 灵感</button>' +
      '<button class="nws-fold" data-view="annots">📝 批注</button>' +
      '<button class="nws-fold" data-view="stats">📊 数据</button>' +
      '</div></div>' +
      '<div class="nws-catalog">' + body + '</div>');

    /* 拖拽：章节行可拖入其他卷 */
    let dragPath = null;
    root.querySelectorAll('.nws-chap').forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        dragPath = row.dataset.path;
        try { e.dataTransfer.setData('text/plain', row.dataset.path); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* 忽略 */ }
        row.classList.add('nws-dragging');
      });
      row.addEventListener('dragend', () => {
        dragPath = null;
        row.classList.remove('nws-dragging');
        root.querySelectorAll('.nws-droptarget').forEach((x) => x.classList.remove('nws-droptarget'));
      });
    });
    root.querySelectorAll('.nws-vol').forEach((vol) => {
      vol.addEventListener('dragover', (e) => { if (dragPath) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* 忽略 */ } vol.classList.add('nws-droptarget'); } });
      vol.addEventListener('dragleave', (e) => { if (!vol.contains(e.relatedTarget)) vol.classList.remove('nws-droptarget'); });
      vol.addEventListener('drop', (e) => {
        e.preventDefault();
        vol.classList.remove('nws-droptarget');
        const path = dragPath || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
        if (path && vol.dataset.vol) p.moveChapter(path, vol.dataset.vol);
        dragPath = null;
      });
    });

    root.querySelectorAll('.nws-chap').forEach((row) => row.addEventListener('click', (e) => {
      if (e.target.closest('[data-status]') || e.target.closest('[data-target]') || e.target.closest('[data-cstat]') || e.target.closest('[data-cmove]')) return; // 状态/目标/统计/移动点击单独处理
      p.openChapterByPath(row.dataset.path);
    }));
    /* 📁 移动章节到其他分卷 */
    root.querySelectorAll('[data-cmove]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      new ChapterMoveModal(this.app, p, b.dataset.cmove).open();
    }));
    /* 📊 本章统计 */
    root.querySelectorAll('[data-cstat]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      new ChapterStatsModal(this.app, p, b.dataset.cstat).open();
    }));
    /* 📊 本卷数据分析 */
    root.querySelectorAll('[data-vstat]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      new VolumeStatsModal(this.app, p, b.dataset.vstat).open();
    }));
    /* 状态：下拉选择（草稿/写作中/待修订/已定稿） */
    root.querySelectorAll('select[data-status]').forEach((sel) => sel.addEventListener('change', async () => {
      const path = sel.dataset.status;
      const st = parseInt(sel.value, 10);
      await p.setMeta(path, { status: st });
      new Notice('状态 → ' + CH_STATUS[st]);
      this.render();
    }));
    /* 字数标签：点击设目标 */
    root.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const path = b.dataset.target;
      new InputModal(this.app, '本章目标字数（0=跟随全局）', String(p.targetOf(path)), async (v) => {
        const n = parseInt(v, 10); if (isNaN(n) || n < 0) return;
        await p.setMeta(path, { target: n }); await p.rescan(true);
        new Notice(n > 0 ? '目标已设为 ' + fmt(n) + ' 字' : '已跟随全局目标');
      }).open();
    }));
    root.querySelectorAll('[data-act="newchap"]').forEach((b) => b.addEventListener('click', () => p.newChapter(b.dataset.vol)));
    root.querySelector('[data-act="newvol"]').addEventListener('click', () => p.newVolume());
    root.querySelector('[data-act="newchap-top"]').addEventListener('click', () => p.newChapter('（未分卷）'));
    root.querySelectorAll('[data-ren]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const old = b.dataset.ren;
      new InputModal(this.app, old === '（未分卷）' ? '重命名未分卷（会新建卷文件夹并移入全部未分卷章节）' : '重命名卷', old, (v) => {
        if (v && v.trim()) p.renameVolume(old, v.trim());
      }).open();
    }));
    root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => p.openPath(b.dataset.open)));
    const vmap = { outline: VIEW_OUTLINE, entities: VIEW_ENTITIES, plots: VIEW_PLOTS, lines: VIEW_LINES, catalog: VIEW_CATALOG, notes: VIEW_NOTES, annots: VIEW_ANNOT, stats: VIEW_STATS };
    root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { if (vmap[b.dataset.view]) p.activateView(vmap[b.dataset.view]); }));
  }
}

/* ---------- 大纲 ---------- */
class OutlineView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.type = '全部'; }
  getViewType() { return VIEW_OUTLINE; }
  getDisplayText() { return '写作台 · 大纲'; }
  getIcon() { return 'list-tree'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const types = ['全部'].concat(p.data.outlineTypes);
    const list = p.data.outlines.filter((o) => this.type === '全部' || o.type === this.type);
    const typeBtns = types.map((t) => {
      const n = t === '全部' ? p.data.outlines.length : p.data.outlines.filter((o) => o.type === t).length;
      return '<button class="nws-fbtn ' + (this.type === t ? 'on' : '') + '" data-t="' + escapeHtml(t) + '">' +
        (t === '全部' ? '全部' : typeEmoji(t, true) + ' ' + escapeHtml(t)) + '<span class="nws-cnt">' + n + '</span></button>';
    }).join('');
    const cards = list.map((o) => {
      const binds = (o.bindings || []).map((b) => {
        const icon = b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : '📋';
        return '<span class="nws-bind" data-bind-kind="' + b.kind + '" data-bind-id="' + escapeHtml(b.id) + '">' + icon + ' ' + escapeHtml(b.name || b.id) + '</span>';
      }).join('');
      const c = (o.color == null ? 3 : o.color) % 6;
      return '<div class="nws-oc" data-id="' + o.id + '">' +
        '<div class="nws-oc-h"><span class="nws-cdot" style="background:' + PALETTE[c] + '"></span>' +
        '<span class="nws-otype">' + outlineEmoji(o.type) + ' ' + escapeHtml(o.type) + '</span>' +
        '<span class="nws-otitle">' + escapeHtml(o.title) + '</span>' +
        '<span class="nws-sp"></span>' +
        '<button class="nws-btn sm" data-act="file" title="打开大纲文件">📄 文件</button>' +
        '<button class="nws-btn sm" data-act="bind">🔗 绑定</button>' +
        '<button class="nws-btn sm" data-act="edit">✎</button>' +
        '<button class="nws-btn sm" data-act="del">删</button></div>' +
        (o.desc ? '<div class="nws-odesc">' + escapeHtml(o.desc) + '</div>' : '') +
        '<div class="nws-otpl">📝 模板：' + outlineTemplateFields(o.type).slice(0, 5).map(escapeHtml).join(' · ') + (outlineTemplateFields(o.type).length > 5 ? ' …' : '') + '</div>' +
        (binds ? '<div class="nws-obinds"><span class="nws-clabel">绑定了：</span>' + binds + '</div>' : '<div class="nws-obindhint">未绑定 · 点「绑定」关联章节/设定/其它大纲</div>') +
        '</div>';
    }).join('') || '<div class="nws-empty">暂无大纲条目。<br>点「＋ 新建大纲」按类型模板创建，并生成同名 md 笔记。</div>';

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">大纲 <span class="nws-tag">' + p.data.outlines.length + ' 条</span></div>' +
      '<div class="nws-sp"></div><button class="nws-btn" data-act="newtype">＋ 类型</button><button class="nws-btn pri" data-act="add">＋ 新建大纲</button></div>' +
      '<div class="nws-psub">按类型模板组织 · 每条可绑定对象 · 每建一条即在 大纲/ 生成同名笔记（含绑定参数与模板骨架）</div>' +
      '<div class="nws-filters">' + typeBtns + '</div></div>' +
      '<div class="nws-ocards">' + cards + '</div>');

    root.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { this.type = b.dataset.t; this.render(); }));
    root.querySelector('[data-act="add"]').addEventListener('click', () => {
      new OutlineCreateModal(this.app, p, this.type === '全部' ? null : this.type).open();
    });
    root.querySelector('[data-act="newtype"]').addEventListener('click', () => {
      new InputModal(this.app, '新建大纲类型', '类型名', (name) => {
        if (!name || !name.trim()) return;
        if (p.data.outlineTypes.indexOf(name.trim()) >= 0) { new Notice('类型已存在'); return; }
        p.data.outlineTypes.push(name.trim()); p.saveNow(); this.render();
      }).open();
    });
    root.querySelectorAll('.nws-oc').forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'del') { p.deleteOutline(id); }
        else if (act === 'file') { p.openOutlineFile(id); }
        else if (act === 'edit') { new OutlineEditModal(this.app, p, p.outlineById(id)).open(); }
        else if (act === 'bind') { new BindModal(this.app, p, 'outline', id).open(); }
      }));
      card.querySelectorAll('[data-bind-kind]').forEach((tag) => tag.addEventListener('click', () => {
        const kind = tag.dataset.bindKind, bid = tag.dataset.bindId;
        if (kind === 'chapter') p.openChapterByPath(bid);
        else if (kind === 'entity') new EntityDetailModal(this.app, p, p.entityById(bid)).open();
        else if (kind === 'outline') p.activateView(VIEW_OUTLINE);
      }));
    });
  }
}

/* ---------- 设定库（v2.6 单纯大库版：6 大类 + 独立，文件化） ---------- */
class EntitiesView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.color = -1; this.q = ''; this.group = '全部'; }
  getViewType() { return VIEW_ENTITIES; }
  getDisplayText() { return '写作台 · 设定库'; }
  getIcon() { return 'shapes'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin, ag = p.aggregate();
    const match = (e) => {
      const grp = e.group || groupOfLib(e.type);
      return (this.group === '全部' || grp === this.group) &&
        (this.color === -1 || (hasEntityColor(e) && (e.color % 6) === this.color) || (!hasEntityColor(e) && this.color === -2)) &&
        (!this.q || e.name.indexOf(this.q) >= 0 || (e.aliases || []).join('').indexOf(this.q) >= 0);
    };
    const list = p.data.entities.filter(match);

    /* 一级：6 大类 + 独立（v2.6 单纯大库版，无二级小库） */
    const groupBtns = ['全部'].concat(ENTITY_GROUPS.map((g) => g.name)).map((g) => {
      const n = g === '全部' ? p.data.entities.length : p.data.entities.filter((e) => (e.group || groupOfLib(e.type)) === g).length;
      const emo = g === '全部' ? '🗂️' : groupEmoji(g);
      return '<button class="nws-fbtn nws-gbtn ' + (this.group === g ? 'on' : '') + '" data-g="' + escapeHtml(g) + '">' +
        emo + ' ' + escapeHtml(g) + '<span class="nws-cnt">' + n + '</span></button>';
    }).join('');

    const cardHtml = (e) => {
      const c = hasEntityColor(e) ? e.color % 6 : -1;
      const pe = ag.perEntity[e.id] || { total: 0, chapters: {} };
      const bindCount = (e.bindings || []).length;
      const lib = LIB_BY_NAME[e.type];
      const binds = (e.bindings || []).map((b) => '<span class="nws-bind" title="' + escapeHtml(b.kind) + '">' +
        (b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : b.kind === 'outline' ? '📋' : '🔖') + ' ' + escapeHtml(b.name || b.id) + '</span>').join('');
      const grp = e.group || groupOfLib(e.type);
      const dotColor = c < 0 ? 'transparent' : PALETTE[c];
      const dotBorder = c < 0 ? '1px dashed var(--nws-ink2)' : 'none';
      return '<div class="nws-ecard" data-id="' + e.id + '">' +
        '<span class="nws-cdot" style="background:' + dotColor + ';border:' + dotBorder + '"></span>' +
        '<span class="nws-ename">' + (lib ? lib.emoji + ' ' : '') + escapeHtml(e.name) + '</span>' +
        '<span class="nws-tag nws-tag-grp">' + groupEmoji(grp) + ' ' + escapeHtml(grp) + '</span>' +
        '<span class="nws-tag">' + escapeHtml(e.type || '人物') + '</span>' +
        '<span class="nws-tag nws-tag-stat">' + pe.total + ' 次 · ' + Object.keys(pe.chapters).length + ' 章</span>' +
        (bindCount ? '<span class="nws-tag nws-tag-bind">🔗' + bindCount + '</span>' : '') +
        '<span class="nws-sp"></span>' +
        '<button class="nws-btn sm" data-ed="open" title="打开设定文件">📄 文件</button>' +
        '<button class="nws-btn sm" data-ed="detail">详情</button>' +
        '<button class="nws-btn sm" data-ed="bind">🔗</button>' +
        '<button class="nws-btn sm" data-ed="color">🎨</button>' +
        (e.desc ? '<div class="nws-edesc">' + escapeHtml(e.desc) + '</div>' : '') +
        (binds ? '<div class="nws-obinds">' + binds + '</div>' : '') +
        '</div>';
    };

    const colorBtns = '<button class="nws-cbtn ' + (this.color === -1 ? 'on' : '') + '" data-c="-1">全部</button>' +
      PALETTE.map((c, i) => '<button class="nws-cbtn ' + (this.color === i ? 'on' : '') + '" data-c="' + i + '" style="--dot:' + c + '"><i></i></button>').join('') +
      '<button class="nws-cbtn ' + (this.color === -2 ? 'on' : '') + '" data-c="-2" title="无颜色（加粗+下划线）">无颜色</button>';
    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">设定库 <span class="nws-tag">' + p.data.entities.length + ' 条</span></div>' +
      '<div class="nws-sp"></div>' +
      '<button class="nws-btn" data-act="openroot" title="打开设定文件夹">📁 设定目录</button>' +
      '<button class="nws-btn pri" data-act="add">🖋️ 新建设定（选大类模板）</button></div>' +
      '<div class="nws-psub">6 大类：世界观总纲 · 人物库 · 角色关系库 · 地理/势力库 · 力量或规则库 · 剧情大纲+伏笔库，另设「独立」收纳语言风格与自定义 · 每条设定按大类存入 设定/&lt;大类&gt;/ 下的同名 md 笔记（含模板/绑定）</div>' +
      '<input class="nws-search" placeholder="搜索设定…" value="' + escapeHtml(this.q) + '">' +
      '<div class="nws-filters nws-groupbar">' + groupBtns + '</div>' +
      '<div class="nws-filters nws-colorbar"><span class="nws-clabel">颜色</span>' + colorBtns + '</div></div>' +
      '<div class="nws-ecards">' +
        (list.map(cardHtml).join('') || '<div class="nws-empty">没有符合条件的设定。<br>点「🖋️ 新建设定」，选一个大类即套用模板创建笔记。</div>') +
      '</div>');

    root.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => { this.group = b.dataset.g; this.render(); }));
    root.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => { this.color = +b.dataset.c; this.render(); }));
    root.querySelector('.nws-search').addEventListener('input', debounce((e) => { this.q = e.target.value.trim(); this.render(); }, 200));
    root.querySelector('[data-act="add"]').addEventListener('click', () => { new EntityCreateModal(this.app, p, null, this.group === '全部' ? null : this.group).open(); });
    root.querySelector('[data-act="openroot"]').addEventListener('click', () => p.openPath(p.libFolder()));
    root.querySelectorAll('.nws-ecard').forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-ed]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.ed;
        if (act === 'open') p.openEntityFile(id);
        else if (act === 'detail') new EntityDetailModal(this.app, p, p.entityById(id)).open();
        else if (act === 'bind') new BindModal(this.app, p, 'entity', id).open();
        else if (act === 'color') { const e = p.entityById(id); new ColorModal(this.app, e, (ci) => p.updateEntity(id, { color: ci })).open(); }
      }));
    });
  }
}

/* ---------- 灵感 ---------- */
class NotesView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.status = '全部'; }
  getViewType() { return VIEW_NOTES; }
  getDisplayText() { return '写作台 · 灵感'; }
  getIcon() { return 'lightbulb'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const notes = (p.data.notes || []).slice().sort((a, b) => {
      const order = { '待定': 0, '采用': 1, '放弃': 2 };
      return (order[a.status] == null ? 0 : order[a.status]) - (order[b.status] == null ? 0 : order[b.status]) || (b.created - a.created);
    });
    const statusChip = (s) => {
      const k = (s === '采用' ? 'ok' : s === '放弃' ? 'no' : 'todo');
      return '<span class="nws-nstatus ' + k + '">' + (k === 'ok' ? '✓ ' : k === 'no' ? '✕ ' : '◌ ') + escapeHtml(s || '待定') + '</span>';
    };
    const filterBtns = ['全部', '待定', '采用', '放弃'].map((s) => {
      const n = s === '全部' ? notes.length : notes.filter((x) => x.status === s).length;
      return '<button class="nws-fbtn ' + ((this.status || '全部') === s ? 'on' : '') + '" data-ns="' + s + '">' + s + '<span class="nws-cnt">' + n + '</span></button>';
    }).join('');
    const shown = notes.filter((n) => !this.status || this.status === '全部' || n.status === this.status);
    const cards = shown.map((n) => {
      const binds = (n.bindings || []).map((b) => '<span class="nws-bind">' + (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + escapeHtml(b.name || b.id) + '</span>').join('');
      return '<div class="nws-ncard" data-nid="' + n.id + '"><div class="nws-nrow">' + statusChip(n.status) + '<span class="nws-sp"></span>' +
        (n.file ? '<button class="nws-btn sm" data-na="open">打开笔记</button>' : '') +
        '<button class="nws-btn sm" data-na="edit">✎ 处理</button><button class="nws-btn sm" data-na="del">删</button></div>' +
        '<div class="txt">' + escapeHtml(n.content) + '</div>' +
        (binds ? '<div class="nws-nbinds">' + binds + '</div>' : '') +
        '<div class="meta"><span>来源：' + escapeHtml(n.sourcePath ? String(n.sourcePath).split('/').pop().replace(/\.md$/, '') : '手动') + '</span><span>·</span><span>' + escapeHtml(stampFrom(n.created)) + '</span></div></div>';
    }).join('') || '<div class="nws-empty">该状态下暂无灵感。<br>在正文选中文字右键「保存为灵感」，或输入 【想法】 打完 】 自动收集。</div>';
    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">灵感 <span class="nws-tag">' + notes.length + ' 条</span></div>' +
      '<div class="nws-sp"></div><button class="nws-btn pri" data-act="new">＋ 新建灵感</button><button class="nws-btn" data-act="open">打开灵感目录</button></div>' +
      '<div class="nws-psub">选中正文右键保存 · 每条可绑定设定（情节/人物等）并标记状态（待定/采用/放弃）· 每条灵感独立存为一个 md 笔记</div>' +
      '<div class="nws-filters">' + filterBtns + '</div></div>' +
      '<div class="nws-notes-grid">' + cards + '</div>');
    root.querySelector('[data-act="open"]').addEventListener('click', () => p.openPath(p.inspirationRoot()));
    root.querySelector('[data-act="new"]').addEventListener('click', () => new InspirationEditModal(this.app, p, null).open());
    root.querySelectorAll('[data-ns]').forEach((b) => b.addEventListener('click', () => { this.status = b.dataset.ns; this.render(); }));
    root.querySelectorAll('.nws-ncard').forEach((card) => {
      const id = card.dataset.nid;
      card.querySelectorAll('[data-na]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.na === 'edit') new InspirationEditModal(this.app, p, p.noteById(id)).open();
        else if (b.dataset.na === 'del') p.deleteNote(id);
        else if (b.dataset.na === 'open') { const n = p.noteById(id); if (n && n.file) p.app.workspace.getLeaf('tab').openFile(p.app.vault.getAbstractFileByPath(n.file)); }
      }));
    });
  }
}

/* ================= v1.3 情节视图 ================= */
class PlotsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.q = ''; }
  getViewType() { return VIEW_PLOTS; }
  getDisplayText() { return '写作台 · 情节'; }
  getIcon() { return 'git-branch'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const list = p.data.plots.filter((pl) => !this.q || pl.name.indexOf(this.q) >= 0 || (pl.tags || []).join('').indexOf(this.q) >= 0);
    const cards = list.map((pl) => {
      const c = pl.color == null ? 3 : pl.color;
      const done = p.plotStageDone(pl);
      const stageBtns = PLOT_STAGES.map((s) => {
        const filled = (pl.stages && pl.stages[s.key] || '').trim();
        return '<div class="nws-stage ' + (filled ? 'done' : '') + '"><span class="nws-stage-ic">' + s.emoji + '</span>' +
          '<span class="nws-stage-label">' + s.label + '</span>' +
          '<span class="nws-stage-txt">' + (filled ? escapeHtml(filled) : '未填写') + '</span></div>';
      }).join('');
      const roles = (pl.roles || []).map((r) => '<span class="nws-bind">👤 ' + escapeHtml(r.name || r.id) + '</span>').join('');
      const chs = (pl.chapters || []).map((c) => '<span class="nws-bind">📄 ' + escapeHtml(c.name || c.id) + '</span>').join('');
      const tags = (pl.tags || []).map((t) => '<span class="nws-tag">#' + escapeHtml(t) + '</span>').join('');
      return '<div class="nws-plot" data-id="' + pl.id + '">' +
        '<div class="nws-plot-h">' +
        '<span class="nws-cdot" style="background:' + PALETTE[c % 6] + '"></span>' +
        '<span class="nws-plot-name">🧩 ' + escapeHtml(pl.name) + '</span>' +
        '<span class="nws-tag nws-tag-stat">' + done + '/4 阶段</span>' +
        '<span class="nws-sp"></span>' +
        '<button class="nws-btn sm" data-pa="edit">✎ 编辑</button>' +
        '<button class="nws-btn sm" data-pa="del">删</button></div>' +
        '<div class="nws-stages">' + stageBtns + '</div>' +
        (roles || chs || tags ? '<div class="nws-plot-meta">' + roles + chs + tags + '</div>' : '') +
        (pl.note ? '<div class="nws-plot-note">📝 ' + escapeHtml(pl.note) + '</div>' : '') +
        '</div>';
    }).join('') || '<div class="nws-empty">暂无情节。<br>点「＋ 新建情节」，按开端/发展/高潮/结局四阶段编排。</div>';

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">情节 <span class="nws-tag">' + p.data.plots.length + ' 条</span></div>' +
      '<div class="nws-sp"></div><button class="nws-btn pri" data-act="new">＋ 新建情节</button></div>' +
      '<div class="nws-psub">四阶段（开端·发展·高潮·结局）编排 · 绑定角色与章节范围 · 标签/颜色/备注</div>' +
      '<input class="nws-search" placeholder="搜索情节…" value="' + escapeHtml(this.q) + '">' +
      '<div class="nws-folders"><button class="nws-fold" data-view="lines">⏳🗺️💗 打开时间/空间/情绪线</button></div></div>' +
      '<div class="nws-plots">' + cards + '</div>');

    root.querySelector('[data-act="new"]').addEventListener('click', () => new PlotModal(this.app, p, null).open());
    root.querySelector('[data-view="lines"]').addEventListener('click', () => p.activateView(VIEW_LINES));
    root.querySelector('.nws-search').addEventListener('input', debounce((e) => { this.q = e.target.value.trim(); this.render(); }, 200));
    root.querySelectorAll('.nws-plot').forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll('[data-pa]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.pa;
        if (act === 'edit') new PlotModal(this.app, p, p.plotById(id)).open();
        else if (act === 'del') p.deletePlot(id);
      }));
    });
  }
}

/* ================= v2.4 时间/空间/情绪多线视图 ================= */
class LinesView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_LINES; }
  getDisplayText() { return '写作台 · 时间/空间/情绪线'; }
  getIcon() { return 'git-merge'; }
  async onOpen() { this.render(); }
  nodeHtml(n) {
    const p = this.plugin;
    const binds = (n.bindings || []).map((b) => {
      const em = b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind);
      return '<span class="nws-lbind" data-nb="' + escapeHtml(b.kind) + '" data-nbid="' + escapeHtml(b.id) + '">' + em + ' ' + escapeHtml(b.name || b.id) + '</span>';
    }).join('');
    return '<div class="nws-node" data-nid="' + n.id + '">' +
      '<div class="nws-node-at">' + escapeHtml(n.at || '') + '</div>' +
      '<div class="nws-node-label">' + escapeHtml(n.label) + '</div>' +
      '<div class="nws-node-content">' + escapeHtml(n.content || p.lineNodeContentHint(n)) + '</div>' +
      (binds ? '<div class="nws-node-binds">' + binds + '</div>' : '') +
      '<div class="nws-node-tools">' +
      '<button class="nws-btn sm" data-na="edit" title="编辑节点">✎</button>' +
      '<button class="nws-btn sm" data-na="up" title="上移">↑</button>' +
      '<button class="nws-btn sm" data-na="down" title="下移">↓</button>' +
      '<button class="nws-btn sm" data-na="del" title="删除">删</button></div>' +
      '</div>';
  }
  /* 单条轨 = 一列 */
  trackColumn(t) {
    const p = this.plugin;
    const nodes = p.nodesOfLine(t.id);
    const vd = trackViewDef(t.view), ad = trackAxisDef(t.axis);
    const body = nodes.map((n) => this.nodeHtml(n)).join('') || '<div class="nws-line-empty">该轨暂无节点。<br>点「＋ 添加' + escapeHtml(vd.node) + '」开始。</div>';
    /* 轨级绑定（整条线围绕谁/什么） */
    const binds = (t.bindings || []).map((b) =>
      '<span class="nws-track-bind" data-tb="' + escapeHtml(b.kind) + '" data-tbid="' + escapeHtml(b.id) + '">' +
      (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + escapeHtml(b.name || b.id) + '</span>').join('');
    return '<div class="nws-linecol nws-line-' + t.axis + '" data-tid="' + t.id + '">' +
      '<div class="nws-linecol-h"><span class="nws-track-h"><span class="nws-track-emoji">' + ad.emoji + vd.emoji + '</span>' +
      '<span class="nws-track-name" data-ta="rename" title="点击重命名">' + escapeHtml(t.name) + ' <span class="nws-rename-ic">✎</span></span>' +
      '<span class="nws-track-vtag">' + vd.name + '</span></span>' +
      '<span class="nws-track-tools">' +
      '<button class="nws-btn sm" data-ta="bind" title="绑定对象（整条线围绕谁/什么）">🔗</button>' +
      '<button class="nws-btn sm" data-ta="up" title="同组内前移">‹</button>' +
      '<button class="nws-btn sm" data-ta="down" title="同组内后移">›</button>' +
      '<button class="nws-btn sm" data-ta="edit" title="编辑线（名称/轴/视角/绑定）">✎</button>' +
      '<button class="nws-btn sm" data-ta="del" title="删除线">✕</button></span></div>' +
      (binds || '' ? '<div class="nws-track-binds">' + binds + '</div>' : '') +
      '<div class="nws-track-add"><button class="nws-btn sm pri" data-act="addline" data-line="' + t.id + '">＋ 添加' + escapeHtml(vd.node) + '</button></div>' +
      '<div class="nws-linetrack">' + body + '</div></div>';
  }
  render() {
    const p = this.plugin;
    const tracks = p.visibleTracks();
    const totalNodes = (p.data.lineNodes || []).length;
    /* 三轴独立开关：任意组合（可只有时间 / 只有空间 / 只有情绪 / 多条对照） */
    const axisBtns = TRACK_AXES.map((a) => {
      const on = p.axisOn(a.key);
      const n = (p.data.tracks || []).filter((t) => t.axis === a.key).length;
      return '<button class="nws-fbtn ' + (on ? 'on' : '') + '" data-axis="' + a.key + '">' + a.emoji + ' ' + a.name + ' <span class="nws-cnt">' + n + '</span></button>';
    }).join('');
    /* 按三轴分组渲染，组间分隔；只渲染开启的轴 */
    const groups = TRACK_AXES.filter((a) => p.axisOn(a.key)).map((a) => {
      const list = tracks.filter((t) => t.axis === a.key);
      if (!list.length) return '';
      return '<div class="nws-axis-group" data-group="' + a.key + '">' +
        list.map((t) => this.trackColumn(t)).join('') + '</div>';
    }).filter(Boolean);
    let cols = groups.join('<div class="nws-line-divider"></div>');
    if (!tracks.length) cols = '<div class="nws-empty">当前显示的轴里还没有线。<br>点「＋ 新建线」创建一条，或开启上方任一轴。</div>';

    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">时间 / 空间 / 情绪线 <span class="nws-tag">' +
      tracks.length + ' 条轨 · ' + totalNodes + ' 节点</span></div>' +
      '<div class="nws-sp"></div>' +
      '<button class="nws-fold" data-view="plots">🧩 情节</button>' +
      '<button class="nws-btn pri" data-act="newtrack">＋ 新建线</button></div>' +
      '<div class="nws-psub">三类线可单独存在、可多条对照；点名称即重命名。每条线可绑定人物/设定/情节，视角决定节点称呼</div>' +
      '<div class="nws-filters">' + axisBtns + '</div></div>' +
      '<div class="nws-lines">' + cols + '</div>');
    root.querySelector('[data-view="plots"]').addEventListener('click', () => p.activateView(VIEW_PLOTS));
    root.querySelectorAll('[data-axis]').forEach((b) => b.addEventListener('click', async () => { p.toggleAxis(b.dataset.axis); await p.saveNow(); this.render(); }));
    root.querySelector('[data-act="newtrack"]').addEventListener('click', () => new TrackModal(this.app, p, null).open());
    /* 轨工具（含点名称重命名、绑定） */
    root.querySelectorAll('[data-ta]').forEach((b) => b.addEventListener('click', () => {
      const tid = b.closest('.nws-linecol').dataset.tid, t = p.trackById(tid), ta = b.dataset.ta;
      if (ta === 'edit') new TrackModal(this.app, p, t).open();
      else if (ta === 'rename') new InputModal(this.app, '重命名线', '如：张三的行动轨迹 / 京城地理线 / 主角情绪曲线', async (v) => { if (v.trim()) await p.updateTrack(tid, { name: v.trim() }); }, t.name).open();
      else if (ta === 'bind') new TrackBindModal(this.app, p, t).open();
      else if (ta === 'del') { if (confirm('删除线「' + t.name + '」及其全部节点？')) p.deleteTrack(tid); }
      else if (ta === 'up') p.moveTrack(tid, -1);
      else if (ta === 'down') p.moveTrack(tid, 1);
    }));
    /* 轨绑定 chip 点击跳转 */
    root.querySelectorAll('[data-tb]').forEach((tag) => tag.addEventListener('click', () => {
      const kind = tag.dataset.tb, bid = tag.dataset.tbid;
      if (kind === 'plot') p.activateView(VIEW_PLOTS);
      else { const e = p.entityById(bid); if (e) new EntityDetailModal(this.app, p, e).open(); }
    }));
    root.querySelectorAll('[data-act="addline"]').forEach((b) => b.addEventListener('click', () => new LineNodeModal(this.app, p, b.dataset.line, null).open()));
    root.querySelectorAll('.nws-node').forEach((el) => {
      const id = el.dataset.nid;
      el.querySelectorAll('[data-na]').forEach((b) => b.addEventListener('click', () => {
        const act = b.dataset.na, n = p.lineNodeById(id);
        if (act === 'edit') new LineNodeModal(this.app, p, n.trackId || n.line, n).open();
        else if (act === 'del') p.deleteLineNode(id);
        else if (act === 'up') p.moveLineNode(id, -1);
        else if (act === 'down') p.moveLineNode(id, 1);
      }));
      el.querySelectorAll('[data-nb]').forEach((tag) => tag.addEventListener('click', () => {
        const kind = tag.dataset.nb, bid = tag.dataset.nbid;
        if (kind === 'plot') p.activateView(VIEW_PLOTS);
        else { const e = p.entityById(bid); if (e) new EntityDetailModal(this.app, p, e).open(); }
      }));
    });
  }
}

/* 新建/编辑一条线（轨）：名称 + 轴（时间/空间/情绪）+ 视角 + 整体绑定 */
class TrackModal extends Modal {
  constructor(app, plugin, track) { super(app); this.p = plugin; this.t = track; this.binds = track ? (track.bindings || []).slice() : []; }
  onOpen() {
    const { contentEl } = this, p = this.p, t = this.t, isNew = !t;
    contentEl.createEl('h3', { text: (isNew ? '新建' : '编辑') + '线（时间 / 空间 / 情绪）' });
    const name = contentEl.createEl('input'); name.type = 'text'; name.placeholder = '线名称（可重命名，如：张三的行动轨迹 / 京城地理线 / 主角情绪曲线）'; name.style.width = '100%';
    if (t) name.value = t.name;

    contentEl.createEl('p', { text: '① 线的类型（可只建一种，也可多条对照）' }).style.cssText = 'font-weight:600;margin:12px 0 5px';
    let axis = t ? t.axis : 'time';
    const axisBtns = contentEl.createDiv(); axisBtns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    const axisBtnsArr = [];
    const namePresets = contentEl.createDiv(); namePresets.style.cssText = 'margin-top:6px;display:flex;gap:5px;flex-wrap:wrap';
    const renderPresets = () => {
      namePresets.empty();
      namePresets.createSpan({ text: '快捷命名：' }).style.cssText = 'font-size:10px;color:var(--text-muted)';
      (TRACK_NAME_PRESETS[axis] || []).forEach((s) => {
        const b = namePresets.createEl('button', { text: s }); b.className = 'nws-btn sm';
        b.addEventListener('click', () => { name.value = s; });
        namePresets.appendChild(b);
      });
    };
    TRACK_AXES.forEach((a) => {
      const b = axisBtns.createEl('button', { text: a.emoji + ' ' + a.name });
      b.className = 'nws-fbtn' + (a.key === axis ? ' on' : ''); axisBtnsArr.push(b);
      b.addEventListener('click', () => {
        axis = a.key; axisBtnsArr.forEach((x) => x.removeClass('on')); b.addClass('on');
        if (isNew && !name.value.trim()) name.value = a.name;
        if (axis === 'emotion' && view === 'event') { view = 'emotion'; viewBtnsArr.forEach((x, i) => x.removeClass('on')); const vb = viewBtnsArr[TRACK_VIEWS.findIndex((v) => v.key === 'emotion')]; if (vb) vb.addClass('on'); hint.textContent = trackViewDef('emotion').hint; }
        renderPresets();
      });
    });

    contentEl.createEl('p', { text: '② 视角（决定节点称呼与内容提示）' }).style.cssText = 'font-weight:600;margin:12px 0 5px';
    let view = t ? t.view : 'event';
    const viewBtns = contentEl.createDiv(); viewBtns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    const viewBtnsArr = [];
    TRACK_VIEWS.forEach((v) => {
      const b = viewBtns.createEl('button', { text: v.emoji + ' ' + v.name });
      b.className = 'nws-fbtn' + (v.key === view ? ' on' : ''); viewBtnsArr.push(b);
      b.addEventListener('click', () => { view = v.key; viewBtnsArr.forEach((x) => x.removeClass('on')); b.addClass('on'); hint.textContent = v.hint; });
    });
    const hint = contentEl.createDiv('nws-tpl-hint'); hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:8px;line-height:1.6';
    hint.textContent = trackViewDef(view).hint;
    renderPresets();

    /* ③ 整体绑定：整条线围绕谁/什么 */
    contentEl.createEl('p', { text: '③ 绑定对象（整条线围绕谁/什么，可选）' }).style.cssText = 'font-weight:600;margin:12px 0 5px';
    const bindBox = contentEl.createDiv('nws-selbox');
    const renderBinds = () => {
      bindBox.empty();
      this.binds.forEach((b) => {
        const chip = bindBox.createEl('span', { text: (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + (b.name || b.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { this.binds = this.binds.filter((x) => !(x.id === b.id && x.kind === b.kind)); renderBinds(); });
      });
      const add = bindBox.createEl('button', { text: '＋ 绑定人物/情节/设定' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new LineBindModal(this.app, p, (pick) => {
        if (!this.binds.some((x) => x.id === pick.id && x.kind === pick.kind)) { this.binds.push(pick); renderBinds(); }
      }).open());
    };
    renderBinds();

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: isNew ? '创建线' : '保存' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const fields = { name: name.value.trim() || trackAxisDef(axis).name, axis, view, bindings: this.binds };
      if (isNew) await p.addTrack(fields); else await p.updateTrack(t.id, fields);
      this.close();
    });
    setTimeout(() => name.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* 轨级绑定选择的独立入口（列表里点 🔗 时打开） */
class TrackBindModal extends Modal {
  constructor(app, plugin, track) { super(app); this.p = plugin; this.t = track; this.binds = (track.bindings || []).slice(); }
  onOpen() {
    const p = this.p, { contentEl } = this;
    contentEl.createEl('h3', { text: '绑定对象 · ' + this.t.name });
    contentEl.createEl('div', { text: '整条线围绕这些对象展开（如把时间线绑定到某个人物＝此人的行动轨迹）。节点仍可各自再绑定。' }).style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px;line-height:1.6';
    const bindBox = contentEl.createDiv('nws-selbox');
    const render = () => {
      bindBox.empty();
      this.binds.forEach((b) => {
        const chip = bindBox.createEl('span', { text: (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + (b.name || b.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { this.binds = this.binds.filter((x) => !(x.id === b.id && x.kind === b.kind)); render(); });
      });
      const add = bindBox.createEl('button', { text: '＋ 绑定' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new LineBindModal(this.app, p, (pick) => {
        if (!this.binds.some((x) => x.id === pick.id && x.kind === pick.kind)) { this.binds.push(pick); render(); }
      }).open());
    };
    render();
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: '保存绑定' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => { await p.updateTrack(this.t.id, { bindings: this.binds }); this.close(); });
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= 弹窗 ================= */
class InputModal extends Modal {
  constructor(app, title, placeholder, onSubmit, initVal) { super(app); this.titleText = title; this.ph = placeholder; this.onSubmit = onSubmit; this.initVal = initVal; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.titleText });
    const inp = contentEl.createEl('input');
    inp.type = 'text'; inp.placeholder = this.ph || ''; inp.style.width = '100%';
    if (this.initVal != null) inp.value = this.initVal;
    else if (this.ph) inp.value = this.ph;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.onSubmit(inp.value); this.close(); } });
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const ok = row.createEl('button', { text: '确定' }); ok.className = 'mod-cta';
    ok.addEventListener('click', () => { this.onSubmit(inp.value); this.close(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  }
  onClose() { this.contentEl.empty(); }
}

class ColorModal extends Modal {
  constructor(app, entity, onPick) { super(app); this.e = entity; this.onPick = onPick; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '为「' + (this.e ? this.e.name : '') + '」选高亮色' });
    contentEl.createEl('div', { text: '选颜色＝正文彩色加粗；选「无颜色」＝正文加粗+下划线。' }).style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px';
    PALETTE.forEach((c, i) => {
      const b = contentEl.createEl('button');
      b.style.cssText = 'width:30px;height:30px;border-radius:50%;border:2px solid ' + c + ';background:' + c + ';margin:6px;';
      b.title = PALETTE_NAMES[i];
      b.addEventListener('click', () => { this.onPick(i); this.close(); });
    });
    const none = contentEl.createEl('button', { text: '无颜色（加粗+下划线）' });
    none.className = 'nws-btn'; none.style.cssText = 'display:block;margin-top:8px';
    none.addEventListener('click', () => { this.onPick(-1); this.close(); });
  }
  onClose() { this.contentEl.empty(); }
}

class TypePickModal extends Modal {
  constructor(app, types, isOutline, onPick) { super(app); this.types = types; this.isOutline = isOutline; this.onPick = onPick; }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '选择类型' });
    this.types.forEach((t) => {
      const b = contentEl.createEl('button', { text: typeEmoji(t, this.isOutline) + ' ' + t });
      b.style.cssText = 'margin:4px 6px 4px 0;padding:6px 12px;';
      b.addEventListener('click', () => { this.onPick(t); this.close(); });
    });
  }
  onClose() { this.contentEl.empty(); }
}

class OutlineCreateModal extends Modal {
  constructor(app, plugin, presetType) { super(app); this.p = plugin; this.preset = presetType; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: '新建大纲 · 第一步选类型' });
    const desc = contentEl.createEl('div', { text: '① 先选大纲类型（每类有专属模板）→ ② 填标题 → ③ 创建。创建即在 大纲/ 生成同名 md 笔记，笔记内已含模板内容，按项补充即可，并可绑定对象。' });
    desc.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';

    /* ① 先选类型 */
    contentEl.createEl('p', { text: '① 选择大纲类型' }).style.cssText = 'font-weight:600;margin:0 0 5px';
    const typeBtns = contentEl.createDiv(); typeBtns.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap';
    let chosen = (this.preset && p.data.outlineTypes.indexOf(this.preset) >= 0) ? this.preset : null;
    let activeBtn = null;
    const hint = contentEl.createDiv('nws-otpl-hint');
    hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin:8px 0;line-height:1.7;padding:8px;border-radius:6px;background:var(--background-secondary)';
    hint.textContent = '选中类型后显示该类型模板字段。';
    const syncHint = () => {
      if (!chosen) { hint.textContent = '请先选择一个大纲类型。'; return; }
      hint.innerHTML = '<b>' + outlineEmoji(chosen) + ' ' + escapeHtml(chosen) + ' 模板</b><br>' +
        outlineTemplateFields(chosen).map((f) => '· ' + escapeHtml(f)).join('<br>');
    };
    p.data.outlineTypes.forEach((t) => {
      const b = typeBtns.createEl('button', { text: outlineEmoji(t) + ' ' + t });
      b.className = 'nws-fbtn';
      b.addEventListener('click', () => {
        if (activeBtn) activeBtn.removeClass('on'); b.addClass('on'); activeBtn = b;
        chosen = t; syncHint();
        if (inpWrap.style.display === 'none') inpWrap.style.display = '';
        inp.focus();
      });
      if (chosen === t) { b.addClass('on'); activeBtn = b; }
    });

    /* ② 标题（选类型后才显示，强调顺序） */
    const inpWrap = contentEl.createDiv(); inpWrap.style.cssText = chosen ? '' : 'display:none';
    inpWrap.createEl('p', { text: '② 大纲标题（将作为文件名）' }).style.cssText = 'font-weight:600;margin:10px 0 5px';
    const inp = inpWrap.createEl('input'); inp.type = 'text'; inp.placeholder = '例如：第一章 雨夜来客'; inp.style.width = '100%';
    syncHint();

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const ok = row.createEl('button', { text: '③ 创建并生成模板笔记' }); ok.className = 'mod-cta';
    const submit = async () => {
      if (!chosen) { new Notice('请先选择大纲类型'); return; }
      if (!inp.value.trim()) { new Notice('请填写大纲标题'); return; }
      const o = await p.addOutline(inp.value.trim(), chosen);
      this.close();
      if (o) { new Notice('已创建大纲：' + o.title + '（' + chosen + ' 模板）'); p.openOutlineFile(o.id); }
    };
    ok.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    if (chosen) setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

class OutlineEditModal extends Modal {
  constructor(app, plugin, outline) { super(app); this.p = plugin; this.o = outline; }
  onOpen() {
    const { contentEl } = this, p = this.p, o = this.o;
    if (!o) { this.close(); return; }
    contentEl.createEl('h3', { text: '编辑大纲 · ' + o.title });
    const title = contentEl.createEl('input'); title.type = 'text'; title.value = o.title; title.style.width = '100%';

    const typeRow = contentEl.createDiv(); typeRow.style.cssText = 'margin-top:10px';
    const typeSpan = typeRow.createSpan({ text: '类型：' + outlineEmoji(o.type) + ' ' + o.type });
    const typeBtn = typeRow.createEl('button', { text: '更改类型' }); typeBtn.className = 'nws-btn sm'; typeBtn.style.marginLeft = '8px';
    let chosen = o.type;
    const tplHint = contentEl.createDiv('nws-otpl-hint'); tplHint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:6px;line-height:1.6';
    tplHint.textContent = '模板字段：' + outlineTemplateFields(chosen).join(' · ');
    typeBtn.addEventListener('click', () => new TypePickModal(this.app, p.data.outlineTypes, true, (t) => {
      chosen = t; typeSpan.textContent = '类型：' + outlineEmoji(t) + ' ' + t; tplHint.textContent = '模板字段：' + outlineTemplateFields(t).join(' · ');
    }).open());

    /* 标签 */
    contentEl.createEl('p', { text: '标签（逗号分隔）' }).style.cssText = 'font-weight:600;margin-top:10px;margin-bottom:5px';
    const tags = contentEl.createEl('input'); tags.type = 'text'; tags.value = (o.tags || []).join('、'); tags.style.width = '100%';
    /* 颜色 */
    contentEl.createEl('p', { text: '颜色' }).style.cssText = 'font-weight:600;margin-top:10px;margin-bottom:5px';
    let color = o.color == null ? 3 : o.color;
    const colorRow = contentEl.createDiv(); colorRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    let cbtn = [];
    PALETTE.forEach((c, i) => {
      const b = colorRow.createEl('button');
      b.style.cssText = 'width:24px;height:24px;border-radius:50%;border:' + (i === color ? '3px solid var(--text-normal)' : '2px solid ' + c) + ';background:' + c + ';cursor:pointer';
      b.addEventListener('click', () => { color = i; cbtn.forEach((x, j) => x.style.border = (j === i ? '3px solid var(--text-normal)' : '2px solid ' + PALETTE[j])); });
      cbtn.push(b);
    });

    contentEl.createEl('p', { text: '描述 / 要点' }).style.cssText = 'font-weight:600;margin-top:10px;margin-bottom:5px';
    const desc = contentEl.createEl('textarea'); desc.value = o.desc || ''; desc.style.cssText = 'width:100%;height:80px';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const openFile = row.createEl('button', { text: '📄 打开文件' }); openFile.className = 'nws-btn'; openFile.style.marginRight = '8px';
    openFile.addEventListener('click', () => { this.close(); p.openOutlineFile(o.id); });
    const ok = row.createEl('button', { text: '保存' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const tg = tags.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
      await p.updateOutline(o.id, { title: title.value.trim() || o.title, type: chosen, tags: tg, color, desc: desc.value });
      new Notice('大纲已保存并同步到文件'); this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* 情节编辑弹窗：名称 / 四阶段 / 绑定角色 / 章节范围 / 标签颜色备注 */
class PlotModal extends Modal {
  constructor(app, plugin, plot) { super(app); this.p = plugin; this.plot = plot; }
  onOpen() {
    const p = this.p, pl = this.plot, { contentEl } = this;
    const isNew = !pl;
    contentEl.createEl('h3', { text: isNew ? '新建情节' : '编辑情节 · ' + pl.name });
    const name = contentEl.createEl('input'); name.type = 'text'; name.placeholder = '情节名称'; name.style.width = '100%';
    if (pl) name.value = pl.name;

    contentEl.createEl('p', { text: '① 情节过程（开端 / 发展 / 高潮 / 结局）' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const stageInputs = {};
    PLOT_STAGES.forEach((s) => {
      const row = contentEl.createDiv(); row.style.cssText = 'margin-bottom:6px';
      row.createSpan({ text: s.emoji + ' ' + s.label + '：' }).style.cssText = 'display:inline-block;width:64px;font-size:11px';
      const ta = row.createEl('textarea'); ta.style.cssText = 'width:calc(100% - 70px);height:38px;vertical-align:top';
      ta.placeholder = s.label + '要点…';
      if (pl && pl.stages) ta.value = pl.stages[s.key] || '';
      stageInputs[s.key] = ta;
    });

    contentEl.createEl('p', { text: '② 绑定角色' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    let selRoles = pl ? (pl.roles || []).slice() : [];
    const roleBox = contentEl.createDiv('nws-selbox');
    const renderRoles = () => {
      roleBox.empty();
      selRoles.forEach((r) => {
        const chip = roleBox.createEl('span', { text: '👤 ' + (r.name || r.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { selRoles = selRoles.filter((x) => x.id !== r.id); renderRoles(); });
      });
      const add = roleBox.createEl('button', { text: '＋ 绑定角色' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new PlotBindPickModal(this.app, p, 'role', (pick) => {
        if (!selRoles.some((x) => x.id === pick.id)) { selRoles.push(pick); renderRoles(); }
      }).open());
    };
    renderRoles();

    contentEl.createEl('p', { text: '③ 章节 / 章节范围' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    let selChs = pl ? (pl.chapters || []).slice() : [];
    const chBox = contentEl.createDiv('nws-selbox');
    const renderChs = () => {
      chBox.empty();
      selChs.forEach((c) => {
        const chip = chBox.createEl('span', { text: '📄 ' + (c.name || c.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { selChs = selChs.filter((x) => x.id !== c.id); renderChs(); });
      });
      const add = chBox.createEl('button', { text: '＋ 绑定章节' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new PlotBindPickModal(this.app, p, 'chapter', (pick) => {
        if (!selChs.some((x) => x.id === pick.id)) { selChs.push(pick); renderChs(); }
      }).open());
    };
    renderChs();

    contentEl.createEl('p', { text: '④ 标签 / 颜色 / 备注' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const tags = contentEl.createEl('input'); tags.type = 'text'; tags.placeholder = '标签，用逗号分隔'; tags.style.width = '100%';
    if (pl) tags.value = (pl.tags || []).join(', ');
    let chosenColor = pl ? pl.color : 3;
    const colorRow = contentEl.createDiv(); colorRow.style.cssText = 'margin-top:8px';
    colorRow.createSpan({ text: '颜色：' }).style.cssText = 'font-size:11px';
    const colorBtns = [];
    PALETTE.forEach((c, i) => {
      const b = colorRow.createEl('button');
      b.style.cssText = 'width:22px;height:22px;border-radius:50%;border:2px solid ' + (i === chosenColor ? 'var(--text-normal)' : 'transparent') + ';background:' + c + ';margin-right:5px;cursor:pointer';
      b.title = PALETTE_NAMES[i];
      b.addEventListener('click', () => { chosenColor = i; colorBtns.forEach((x, j) => x.style.borderColor = j === i ? 'var(--text-normal)' : 'transparent'); });
      colorBtns.push(b);
    });
    contentEl.createEl('p', { text: '备注' }).style.cssText = 'margin-top:8px';
    const note = contentEl.createEl('textarea'); note.style.cssText = 'width:100%;height:52px'; note.placeholder = '补充备注…';
    if (pl) note.value = pl.note || '';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: isNew ? '创建' : '保存' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const fields = {
        name: name.value.trim() || '未命名情节',
        stages: {}, roles: selRoles, chapters: selChs,
        tags: tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        color: chosenColor, note: note.value
      };
      PLOT_STAGES.forEach((s) => { fields.stages[s.key] = stageInputs[s.key].value; });
      if (isNew) { await p.addPlot(fields); new Notice('情节已创建'); }
      else { await p.updatePlot(pl.id, fields); new Notice('情节已保存'); }
      this.close();
    });
    setTimeout(() => name.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* 情节/双线的角色或章节选择器 */
class PlotBindPickModal extends Modal {
  constructor(app, plugin, kind, onPick) { super(app); this.p = plugin; this.kind = kind; this.onPick = onPick; this.q = ''; }
  onOpen() {
    const { contentEl } = this, p = this.p, kind = this.kind;
    contentEl.createEl('h3', { text: kind === 'role' ? '选择角色' : '选择章节' });
    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = '搜索…'; inp.style.width = '100%';
    const list = contentEl.createDiv(); list.style.cssText = 'max-height:320px;overflow:auto;margin-top:8px';
    const render = () => {
      list.empty();
      const q = this.q.trim().toLowerCase();
      const items = kind === 'role'
        ? p.data.entities.filter((e) => (e.type === '人物' || e.type === '角色' || typeEmoji(e.type) === '👤')).map((e) => ({ id: e.id, name: '👤 ' + e.name, kind: 'role', type: e.type }))
        : p.allChapters().map((c) => ({ id: c.path, name: '📄 ' + c.volume + ' / ' + c.title, kind: 'chapter' }));
      items.filter((x) => !q || x.name.toLowerCase().indexOf(q) >= 0).forEach((it) => {
        const row = list.createDiv({ text: it.name });
        row.style.cssText = 'padding:7px 9px;border-radius:5px;cursor:pointer';
        row.addEventListener('click', () => { this.onPick(it); this.close(); });
        row.addEventListener('mouseenter', () => row.style.background = 'var(--background-modifier-hover)');
        row.addEventListener('mouseleave', () => row.style.background = '');
      });
      if (!list.children.length) list.createEl('div', { text: kind === 'role' ? '（设定库中还没有人物，请先在设定库创建）' : '（正文中还没有章节）' }).style.cssText = 'font-size:11px;color:var(--text-muted);padding:8px';
    };
    inp.addEventListener('input', (e) => { this.q = e.target.value; render(); });
    render();
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* 双线节点编辑弹窗 */
class LineNodeModal extends Modal {
  constructor(app, plugin, line, node) { super(app); this.p = plugin; this.line = line; this.node = node; this.binds = node ? (node.bindings || []).slice() : []; }
  onOpen() {
    const p = this.p, n = this.node, { contentEl } = this, isNew = !n;
    const track = p.trackById(this.line);
    const vd = trackViewDef((n && n.view) || (track && track.view) || 'event');
    contentEl.createEl('h3', { text: (isNew ? '添加' : '编辑') + vd.node + (track ? '（' + track.name + '）' : '') });
    const label = contentEl.createEl('input'); label.type = 'text'; label.placeholder = vd.node + '名称'; label.style.width = '100%';
    if (n) label.value = n.label;
    const atEx = track && track.axis === 'emotion' ? '事件发展 / 城东渡口 / 第2章 / 暴雨夜（外部条件）'
      : track && track.axis === 'space' ? '城东渡口' : '第 2 章 / 公元 1024 年';
    const at = contentEl.createEl('input'); at.type = 'text'; at.placeholder = vd.at + '（如：' + atEx + '）'; at.style.width = '100%'; at.style.marginTop = '6px';
    if (n) at.value = n.at || '';

    contentEl.createEl('p', { text: (track && track.axis === 'emotion' ? '触发源（事件 / 地点 / 时间段 / 外部条件 / 人物）' : '绑定对象（人物 / 情节 / 线索 / 伏笔 等）') }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const bindBox = contentEl.createDiv('nws-selbox');
    const renderBinds = () => {
      bindBox.empty();
      this.binds.forEach((b) => {
        const em = b.kind === 'plot' ? '🧩' : (b.type ? typeEmoji(b.type) : '🔹');
        const chip = bindBox.createEl('span', { text: em + ' ' + (b.name || b.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { this.binds = this.binds.filter((x) => !(x.id === b.id && x.kind === b.kind)); renderBinds(); });
      });
      const add = bindBox.createEl('button', { text: '＋ 绑定' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new LineBindModal(this.app, p, (pick) => {
        if (!this.binds.some((x) => x.id === pick.id && x.kind === pick.kind)) { this.binds.push(pick); renderBinds(); }
      }).open());
    };
    renderBinds();

    contentEl.createEl('p', { text: '内容（根据绑定对象撰写；留空则显示绑定提示）' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const contentTa = contentEl.createEl('textarea'); contentTa.style.cssText = 'width:100%;height:90px';
    contentTa.placeholder = '此处撰写该' + vd.node + '发生的事…';
    if (n) contentTa.value = n.content || '';

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: isNew ? '添加' : '保存' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const fields = { label: label.value.trim() || vd.node, at: at.value.trim(), bindings: this.binds, content: contentTa.value };
      if (isNew) { fields.view = (track && track.view) || 'event'; await p.addLineNode(this.line, fields); }
      else await p.updateLineNode(n.id, fields);
      this.close();
    });
    setTimeout(() => label.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* 双线节点：通用绑定选择器（设定库实体 + 情节） */
class LineBindModal extends Modal {
  constructor(app, plugin, onPick) { super(app); this.p = plugin; this.onPick = onPick; this.q = ''; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: '绑定对象' });
    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = '搜索…'; inp.style.width = '100%';
    const list = contentEl.createDiv(); list.style.cssText = 'max-height:340px;overflow:auto;margin-top:8px';
    const render = () => {
      list.empty();
      const q = this.q.trim().toLowerCase();
      const section = (title, items) => {
        const arr = items.filter((x) => !q || x.name.toLowerCase().indexOf(q) >= 0);
        if (!arr.length) return;
        list.createEl('div', { text: title }).style.cssText = 'font-size:10px;color:var(--text-muted);margin:10px 0 4px;font-weight:600';
        arr.forEach((it) => {
          const row = list.createDiv();
          row.style.cssText = 'display:flex;gap:8px;padding:6px 8px;border-radius:5px;cursor:pointer';
          row.createSpan({ text: typeEmoji(it.type || it.kind) + ' ' + it.name });
          row.addEventListener('click', () => { this.onPick(it); this.close(); });
          row.addEventListener('mouseenter', () => row.style.background = 'var(--background-modifier-hover)');
          row.addEventListener('mouseleave', () => row.style.background = '');
        });
      };
      section('🧩 情节', p.data.plots.map((pl) => ({ kind: 'plot', id: pl.id, name: pl.name, type: '剧情' })));
      LINE_BIND_KINDS.filter((k) => k !== '情节').forEach((k) => {
        const arr = p.data.entities.filter((e) => e.type === k);
        if (arr.length) section(typeEmoji(k) + ' ' + k, arr.map((e) => ({ kind: 'entity', id: e.id, name: e.name, type: e.type })));
      });
    };
    inp.addEventListener('input', (e) => { this.q = e.target.value; render(); });
    render();
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* 查找替换（当前活动文档） */
class FindReplaceModal extends Modal {
  constructor(app, plugin) { super(app); this.p = plugin; this.caseSensitive = false; this.matches = []; this.idx = -1; }
  onOpen() {
    const { contentEl } = this, self = this;
    contentEl.createEl('h3', { text: '查找替换 · 当前文档' });
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    this.editor = view && view.editor ? view.editor : null;
    if (!this.editor) { contentEl.createEl('p', { text: '请先打开一篇 Markdown 文档。' }).style.color = 'var(--text-muted)'; return; }

    const findRow = contentEl.createDiv(); findRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
    const find = findRow.createEl('input'); find.type = 'text'; find.placeholder = '查找…'; find.style.cssText = 'flex:1';
    const findNext = findRow.createEl('button', { text: '下一个' }); findNext.className = 'nws-btn';
    const prevBtn = findRow.createEl('button', { text: '上一个' }); prevBtn.className = 'nws-btn';

    const replRow = contentEl.createDiv(); replRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
    const repl = replRow.createEl('input'); repl.type = 'text'; repl.placeholder = '替换为…'; repl.style.cssText = 'flex:1';
    const replOne = replRow.createEl('button', { text: '替换' }); replOne.className = 'nws-btn';
    const replAll = replRow.createEl('button', { text: '全部替换' }); replAll.className = 'nws-btn pri';

    const optRow = contentEl.createDiv(); optRow.style.cssText = 'margin-bottom:6px';
    const caseBtn = optRow.createEl('button', { text: 'Aa 区分大小写：关' }); caseBtn.className = 'nws-btn sm';
    caseBtn.addEventListener('click', () => { self.caseSensitive = !self.caseSensitive; caseBtn.textContent = 'Aa 区分大小写：' + (self.caseSensitive ? '开' : '关'); self.scan(find.value); });
    const info = contentEl.createDiv('nws-fr-info'); info.style.cssText = 'font-size:11px;color:var(--text-muted);min-height:18px';

    const scan = () => { self.scan(find.value, info); };
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    find.addEventListener('input', scan);
    findNext.addEventListener('click', () => self.gotoMatch(1, info));
    prevBtn.addEventListener('click', () => self.gotoMatch(-1, info));
    replOne.addEventListener('click', () => {
      if (self.idx < 0) { self.scan(find.value, info); }
      if (self.idx >= 0 && self.matches[self.idx]) {
        const m = self.matches[self.idx];
        self.editor.replaceRange(repl.value, self.editor.offsetToPos(m.from), self.editor.offsetToPos(m.to));
        self.scan(find.value, info); self.gotoMatch(0, info);
      }
    });
    replAll.addEventListener('click', () => {
      const q = find.value; if (!q) return;
      const text = self.editor.getValue();
      const flags = self.caseSensitive ? 'g' : 'gi';
      const re = new RegExp(esc(q), flags);
      const newText = text.replace(re, repl.value);
      const count = (text.match(re) || []).length;
      if (count) { self.editor.setValue(newText); new Notice('已替换 ' + count + ' 处'); }
      else new Notice('未找到匹配');
      self.scan(find.value, info);
    });
    this.findInput = find;
    setTimeout(() => find.focus(), 30);
  }
  scan(q, info) {
    this.matches = []; this.idx = -1;
    if (!this.editor || !q) { if (info) info.textContent = ''; return; }
    const text = this.editor.getValue();
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc(q), this.caseSensitive ? 'g' : 'gi');
    let m;
    while ((m = re.exec(text)) !== null) { this.matches.push({ from: m.index, to: m.index + m[0].length }); if (m[0].length === 0) re.lastIndex++; }
    if (info) info.textContent = this.matches.length ? ('共 ' + this.matches.length + ' 处匹配') : '未找到匹配';
  }
  gotoMatch(dir, info) {
    if (!this.matches.length) { if (info) info.textContent = '未找到匹配'; return; }
    this.idx = (this.idx + dir + this.matches.length) % this.matches.length;
    const m = this.matches[this.idx];
    const from = this.editor.offsetToPos(m.from), to = this.editor.offsetToPos(m.to);
    this.editor.setSelection(from, to);
    this.editor.scrollIntoView(from, true);
    if (info) info.textContent = (this.idx + 1) + ' / ' + this.matches.length + ' 处';
  }
  onClose() { this.contentEl.empty(); }
}

/* 设定库快速搜索选择器（输入「、、」唤起，选中后插入设定名） */
class SettingPickModal extends Modal {
  constructor(app, plugin, onPick, onCancel) { super(app); this.p = plugin; this.onPick = onPick; this.onCancel = onCancel; this.q = ''; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: '插入设定 / 情节' });
    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = '搜索设定库…（名称/别名）'; inp.style.width = '100%';
    const list = contentEl.createDiv('nws-suggest-list');
    const render = () => {
      list.empty();
      const q = this.q.trim().toLowerCase();
      const all = [];
      p.data.plots.forEach((pl) => all.push({ kind: 'plot', type: '剧情', name: pl.name }));
      p.data.entities.forEach((e) => all.push({ kind: 'entity', type: e.type, name: e.name, aliases: e.aliases || [] }));
      const arr = all.filter((x) => !q || x.name.toLowerCase().indexOf(q) >= 0 || (x.aliases || []).some((a) => a.toLowerCase().indexOf(q) >= 0));
      arr.slice(0, 80).forEach((it) => {
        const row = list.createDiv('nws-suggest-row');
        row.createSpan({ text: (it.kind === 'plot' ? '🧩' : typeEmoji(it.type)) + ' ' + it.name });
        const t = row.createSpan({ text: it.kind === 'plot' ? '情节' : it.type }); t.style.cssText = 'margin-left:auto;font-size:10px;color:var(--text-muted)';
        row.addEventListener('click', () => { this.picked = true; this.onPick(it); this.close(); });
      });
      if (!list.children.length) list.createEl('div', { text: '无匹配，可直接关闭继续输入' }).style.cssText = 'font-size:11px;color:var(--text-muted);padding:8px';
    };
    inp.addEventListener('input', (e) => { this.q = e.target.value; render(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.close(); }
      else if (e.key === 'Enter') { const first = list.querySelector('.nws-suggest-row'); if (first) first.click(); }
    });
    render();
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); if (!this.picked && this.onCancel) this.onCancel(); }
}

/* 灵感处理弹窗：内容 / 状态 / 绑定设定（情节、人物等） */
class InspirationEditModal extends Modal {
  constructor(app, plugin, note) { super(app); this.p = plugin; this.note = note; this.binds = note ? (note.bindings || []).slice() : []; }
  onOpen() {
    const p = this.p, n = this.note, { contentEl } = this, isNew = !n;
    contentEl.createEl('h3', { text: isNew ? '新建灵感' : '处理灵感' });
    const contentTa = contentEl.createEl('textarea'); contentTa.style.cssText = 'width:100%;height:70px'; contentTa.placeholder = '灵感内容…';
    if (n) contentTa.value = n.content;

    contentEl.createEl('p', { text: '① 处理状态' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    let status = n ? (n.status || '待定') : '待定';
    const statusRow = contentEl.createDiv(); statusRow.style.cssText = 'display:inline-flex;gap:6px';
    const sBtns = [];
    ['待定', '采用', '放弃'].forEach((s) => {
      const b = statusRow.createEl('button', { text: s });
      b.className = 'nws-fbtn' + (s === status ? ' on' : '');
      b.addEventListener('click', () => { status = s; sBtns.forEach((x) => x.removeClass('on')); b.addClass('on'); });
      sBtns.push(b);
    });

    contentEl.createEl('p', { text: '② 绑定到设定 / 情节（可选，说明这条灵感属于谁）' }).style.cssText = 'font-weight:600;margin-top:12px;margin-bottom:6px';
    const bindBox = contentEl.createDiv('nws-selbox');
    const renderBinds = () => {
      bindBox.empty();
      this.binds.forEach((b) => {
        const chip = bindBox.createEl('span', { text: (b.kind === 'plot' ? '🧩' : typeEmoji(b.type || b.kind)) + ' ' + (b.name || b.id) + ' ×' });
        chip.className = 'nws-bind'; chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => { this.binds = this.binds.filter((x) => !(x.id === b.id && x.kind === b.kind)); renderBinds(); });
      });
      const add = bindBox.createEl('button', { text: '＋ 绑定（情节/人物/线索…）' }); add.className = 'nws-btn sm';
      add.addEventListener('click', () => new LineBindModal(this.app, p, (pick) => {
        if (!this.binds.some((x) => x.id === pick.id && x.kind === pick.kind)) { this.binds.push(pick); renderBinds(); }
      }).open());
    };
    renderBinds();

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:14px;text-align:right';
    const ok = row.createEl('button', { text: isNew ? '保存灵感' : '保存处理' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const fields = { content: contentTa.value.trim() || '（空灵感）', status, bindings: this.binds };
      if (isNew) { await p.captureInspiration(fields.content, '', { status, bindings: this.binds }); }
      else { await p.updateNote(n.id, fields); new Notice('灵感已更新'); }
      this.close();
    });
    setTimeout(() => contentTa.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

class EntityCreateModal extends Modal {
  constructor(app, plugin, presetLib, presetGroup, presetName) { super(app); this.p = plugin; this.preset = presetLib; this.presetGroup = presetGroup; this.presetName = presetName; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: '新建设定 · 选大类' });
    const desc = contentEl.createEl('div', { text: '第 1 步选一个大类（每类有专属模板）→ 第 2 步填名称 → 创建。会在 设定/<大类>/ 下生成同名 md 笔记，按模板补充即可。语言风格或自定义内容选「独立」。' });
    desc.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';

    /* ① 大类（v2.6 单纯大库版：无二级小库；若从右键带入了具体小库，则自动归到对应大类并沿用该小库模板） */
    contentEl.createEl('p', { text: '① 选择大类' }).style.cssText = 'font-weight:600;margin:0 0 5px';
    const groupRow = contentEl.createDiv(); groupRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap';
    /* presetLib 传入时定位其所属大类 */
    let chosenGroup = null, presetLib = this.preset && LIB_BY_NAME[this.preset] ? this.preset : null;
    if (presetLib) chosenGroup = groupOfLib(presetLib);
    if (!chosenGroup && this.presetGroup && GROUP_BY_NAME[this.presetGroup]) chosenGroup = this.presetGroup;
    let activeGroupBtn = null;
    const customWrap = contentEl.createDiv('nws-custom-type'); customWrap.style.cssText = 'margin-top:8px;display:none';
    customWrap.createSpan({ text: '自定义类型名：' }).style.cssText = 'font-size:11px';
    const customInp = customWrap.createEl('input'); customInp.type = 'text'; customInp.placeholder = '如：法宝、功法、神通…'; customInp.style.cssText = 'width:100%;margin-top:4px';
    const hint = contentEl.createDiv('nws-tpl-hint'); hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:8px;line-height:1.6';

    /* 每个大类下本条设定实际用的小库（模板来源）：优先 presetLib，否则该类第一个小库 */
    let chosen = presetLib || null;
    const syncHint = () => {
      if (!chosen) chosen = libsOfGroup(chosenGroup)[0];
      const lib = LIB_BY_NAME[chosen];
      const fields = (lib && lib.fields && lib.fields.length) ? lib.fields : groupFields(chosenGroup);
      hint.textContent = '模板字段：' + fields.join(' · ');
      customWrap.style.display = (chosenGroup === '独立') ? '' : 'none';
    };
    ENTITY_GROUPS.forEach((g) => {
      const b = groupRow.createEl('button', { text: g.emoji + ' ' + g.name });
      const on = g.name === chosenGroup;
      b.className = 'nws-fbtn' + (on ? ' on' : '');
      if (on) activeGroupBtn = b;
      b.addEventListener('click', () => {
        if (activeGroupBtn) activeGroupBtn.removeClass('on'); b.addClass('on'); activeGroupBtn = b;
        chosenGroup = g.name; chosen = null; syncHint();
      });
    });
    if (!chosenGroup) {
      chosenGroup = ENTITY_GROUPS[0].name; chosen = null;
      const firstBtn = groupRow.children && groupRow.children[0];
      if (firstBtn) { firstBtn.addClass('on'); activeGroupBtn = firstBtn; }
    }
    syncHint();

    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = '② 设定名称（将作为文件名）'; inp.style.cssText = 'width:100%;margin-top:12px';
    if (this.presetName) inp.value = this.presetName;

    /* 第 3 步：颜色（正文着色方式） */
    contentEl.createEl('p', { text: '③ 正文高亮颜色（可选）' }).style.cssText = 'font-weight:600;margin:12px 0 5px';
    const colorRow = contentEl.createDiv(); colorRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center';
    let chosenColor = p.typeColor(chosen || '自定义');
    const colorBtns = [];
    PALETTE.forEach((col, i) => {
      const cb = colorRow.createEl('button');
      cb.style.cssText = 'width:24px;height:24px;border-radius:50%;border:' + (i === chosenColor ? '3px solid var(--text-normal)' : '2px solid ' + col) + ';background:' + col + ';cursor:pointer';
      cb.title = PALETTE_NAMES[i] + '（正文彩色加粗）';
      cb.addEventListener('click', () => { chosenColor = i; colorBtns.forEach((x, j) => x.style.border = (j === i ? '3px solid var(--text-normal)' : '2px solid ' + PALETTE[j])); noColorBtn.style.border = '2px solid var(--text-muted)'; });
      colorBtns.push(cb);
    });
    const noColorBtn = colorRow.createEl('button', { text: '无颜色（加粗+下划线）' });
    noColorBtn.className = 'nws-btn sm';
    noColorBtn.addEventListener('click', () => { chosenColor = -1; colorBtns.forEach((x, j) => x.style.border = '2px solid ' + PALETTE[j]); noColorBtn.style.border = '2px solid var(--text-normal)'; });

    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const ok = row.createEl('button', { text: '创建并生成模板笔记' }); ok.className = 'mod-cta';
    const submit = async () => {
      if (!inp.value.trim()) return;
      let type = chosen;
      if (chosenGroup === '独立') {
        const cn = customInp.value.trim();
        if (cn) {
          type = cn;
          if (p.data.entityTypes.indexOf(cn) < 0) { p.data.entityTypes.push(cn); p.data.typeColors[cn] = 0; }
        } else type = '自定义';
      }
      const e = await p.addEntity(inp.value.trim(), type, chosenGroup);
      if (e) { e.color = chosenColor; await p.writeEntityFile(e, false); await p.saveNow(); p.entityVersion++; p.refreshViews(); }
      this.close();
      if (e) { new Notice('已创建 设定/' + groupFolderName(chosenGroup) + '/' + e.name + '.md'); p.openEntityFile(e.id); }
    };
    ok.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    setTimeout(() => inp.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* 绑定选择器 */
class BindModal extends Modal {
  constructor(app, plugin, ownerKind, ownerId) { super(app); this.p = plugin; this.ownerKind = ownerKind; this.ownerId = ownerId; this.q = ''; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    const owner = this.ownerKind === 'outline' ? p.outlineById(this.ownerId) : p.entityById(this.ownerId);
    if (!owner) { this.close(); return; }
    contentEl.createEl('h3', { text: '绑定对象 · ' + (owner.title || owner.name) });
    const hint = contentEl.createEl('div', { text: '点击条目切换绑定/取消。可绑定章节、设定（角色/情节/背景等）、其它大纲。' });
    hint.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:8px';
    const inp = contentEl.createEl('input'); inp.type = 'text'; inp.placeholder = '搜索…'; inp.style.width = '100%';
    const list = contentEl.createDiv(); list.style.cssText = 'max-height:340px;overflow:auto;margin-top:8px';
    const isBound = (kind, id) => (owner.bindings || []).some((b) => b.kind === kind && b.id === id);
    const render = () => {
      list.empty();
      const q = this.q.trim().toLowerCase();
      const section = (title, items) => {
        const arr = items.filter((x) => !q || x.name.toLowerCase().indexOf(q) >= 0);
        if (!arr.length) return;
        list.createEl('div', { text: title }).style.cssText = 'font-size:10px;color:var(--text-muted);margin:10px 0 4px;font-weight:600';
        arr.forEach((it) => {
          const on = isBound(it.kind, it.id);
          const row = list.createDiv();
          row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:5px;cursor:pointer;' + (on ? 'background:rgba(143,163,148,.18)' : '');
          row.createSpan({ text: (on ? '✅ ' : '⬜ ') + it.icon + ' ' + it.name });
          row.addEventListener('click', async () => { await p.toggleBinding(this.ownerKind, this.ownerId, { kind: it.kind, id: it.id, name: it.name }); render(); });
        });
      };
      section('📄 章节', p.allChapters().map((c) => ({ kind: 'chapter', id: c.path, name: c.volume + ' / ' + c.title, icon: '📄' })));
      section('🔗 设定', p.data.entities.map((e) => ({ kind: 'entity', id: e.id, name: typeEmoji(e.type) + ' ' + e.name + '（' + e.type + '）', icon: '🔗' })));
      section('📋 大纲', p.data.outlines.filter((o) => o.id !== this.ownerId).map((o) => ({ kind: 'outline', id: o.id, name: typeEmoji(o.type, true) + ' ' + o.title, icon: '📋' })));
    };
    inp.addEventListener('input', (e) => { this.q = e.target.value; render(); });
    render();
  }
  onClose() { this.contentEl.empty(); }
}

/* 设定详情：全书统计 + 每章分布 + 绑定 + 编辑入口 */
class EntityDetailModal extends Modal {
  constructor(app, plugin, entity) { super(app); this.p = plugin; this.e = entity; }
  onOpen() {
    const { contentEl } = this, p = this.p, e = this.e;
    if (!e) { this.close(); return; }
    const ag = p.aggregate();
    const pe = ag.perEntity[e.id] || { total: 0, chapters: {}, first: '—', last: '—' };
    contentEl.createEl('h3', { text: typeEmoji(e.type) + ' ' + e.name + ' · ' + (e.type || '') });
    contentEl.createEl('p', { text: e.desc || '（无描述）' });
    const stats = contentEl.createDiv('nws-stat4');
    [['全书出现', pe.total + ' 次'], ['涉及章节', Object.keys(pe.chapters).length + ' 章'], ['首次出现', pe.first || '—'], ['最近出现', pe.last || '—']].forEach((kv) => {
      const c = stats.createDiv('nws-sc'); c.createDiv('nws-k').textContent = kv[0]; c.createDiv('nws-v').textContent = kv[1];
    });
    contentEl.createEl('h4', { text: '每章出现次数' });
    const entries = Object.keys(pe.chapters).sort((a, b) => pe.chapters[b] - pe.chapters[a]);
    if (!entries.length) contentEl.createEl('div', { text: '（正文中暂未出现）' }).style.cssText = 'font-size:11px;color:var(--text-muted)';
    const max = Math.max(1, ...entries.map((k) => pe.chapters[k]));
    entries.forEach((path) => {
      const row = contentEl.createDiv('nws-dist');
      const title = (ag.chapters.find((c) => c.path === path) || {}).title || path;
      const n = row.createSpan('n'); n.textContent = title; n.setAttribute('title', path);
      const b = row.createSpan('b'), i = b.createEl('i'); i.style.width = (pe.chapters[path] / max * 100) + '%';
      row.createSpan('v').textContent = pe.chapters[path];
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => { p.openChapterByPath(path); this.close(); });
    });
    const binds = e.bindings || [];
    contentEl.createEl('h4', { text: '绑定对象（' + binds.length + '）' });
    if (binds.length) {
      const bwrap = contentEl.createDiv(); bwrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
      binds.forEach((b) => {
        const chip = bwrap.createEl('span', { text: (b.kind === 'chapter' ? '📄' : b.kind === 'entity' ? '🔗' : '📋') + ' ' + (b.name || b.id) });
        chip.className = 'nws-bind';
      });
    } else contentEl.createEl('div', { text: '（未绑定）' }).style.cssText = 'font-size:11px;color:var(--text-muted)';

    const row = contentEl.createDiv('nws-row'); row.style.marginTop = '14px';
    const openFile = row.createEl('button', { text: '📄 打开设定文件' }); openFile.className = 'nws-btn pri';
    openFile.addEventListener('click', () => { this.close(); p.openEntityFile(e.id); });
    const edit = row.createEl('button', { text: '编辑元数据' }); edit.className = 'nws-btn'; edit.style.marginLeft = '8px';
    edit.addEventListener('click', () => { this.close(); new EntityEditModal(this.app, p, e).open(); });
    const bind = row.createEl('button', { text: '🔗 管理绑定' }); bind.className = 'nws-btn'; bind.style.marginLeft = '8px';
    bind.addEventListener('click', () => { this.close(); new BindModal(this.app, p, 'entity', e.id).open(); });
    const del = row.createEl('button', { text: '删除' }); del.className = 'nws-btn'; del.style.marginLeft = '8px';
    del.addEventListener('click', () => { this.close(); p.deleteEntity(e.id); });
  }
  onClose() { this.contentEl.empty(); }
}

class EntityEditModal extends Modal {
  constructor(app, plugin, entity) { super(app); this.p = plugin; this.e = entity; }
  onOpen() {
    const { contentEl } = this, p = this.p, e = this.e;
    if (!e) { this.close(); return; }
    contentEl.createEl('h3', { text: '编辑设定 · ' + e.name });
    const name = contentEl.createEl('input'); name.type = 'text'; name.value = e.name; name.style.width = '100%';

    /* 两级归属：大类 → 小库 */
    let chosenGroup = e.group || groupOfLib(e.type);
    let chosen = e.type;
    const selNote = contentEl.createDiv(); selNote.style.cssText = 'margin-top:10px;font-size:11px;color:var(--text-muted)';
    const refreshSelNote = () => { selNote.textContent = '归属：' + groupEmoji(chosenGroup) + ' ' + chosenGroup + ' / ' + ((LIB_BY_NAME[chosen] || {}).emoji || '🔹') + ' ' + chosen; };
    const gpRow = contentEl.createDiv(); gpRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-top:6px';
    contentEl.createEl('p', { text: '大类' }).style.cssText = 'font-weight:600;margin:10px 0 0';
    const libRow = contentEl.createDiv(); libRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-top:6px';
    let activeG = null, activeL = null;
    const renderLibs = () => {
      libRow.empty();
      libsOfGroup(chosenGroup).forEach((l) => {
        const def = LIB_BY_NAME[l]; const b = libRow.createEl('button', { text: (def ? def.emoji + ' ' : '') + l });
        b.className = 'nws-fbtn' + (l === chosen ? ' on' : ''); if (l === chosen) activeL = b;
        b.addEventListener('click', () => { if (activeL) activeL.removeClass('on'); b.addClass('on'); activeL = b; chosen = l; refreshSelNote(); });
      });
    };
    ENTITY_GROUPS.forEach((g) => {
      const b = gpRow.createEl('button', { text: g.emoji + ' ' + g.name });
      b.className = 'nws-fbtn' + (g.name === chosenGroup ? ' on' : ''); if (g.name === chosenGroup) activeG = b;
      b.addEventListener('click', () => {
        if (activeG) activeG.removeClass('on'); b.addClass('on'); activeG = b;
        chosenGroup = g.name; const libs = libsOfGroup(chosenGroup); if (libs.indexOf(chosen) < 0) chosen = libs[0];
        renderLibs(); refreshSelNote();
      });
    });
    renderLibs(); refreshSelNote();

    contentEl.createEl('p', { text: '别名（逗号分隔，正文命中即标注并计入统计）' });
    const aliases = contentEl.createEl('input'); aliases.type = 'text'; aliases.value = (e.aliases || []).join('、'); aliases.style.width = '100%';
    /* 颜色：沿用当前，可在详情里用 🎨 调整 */
    contentEl.createEl('p', { text: '描述' });
    const desc = contentEl.createEl('textarea'); desc.value = e.desc || ''; desc.style.cssText = 'width:100%;height:70px';
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:12px;text-align:right';
    const ok = row.createEl('button', { text: '保存' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => {
      const al = aliases.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
      await p.updateEntity(e.id, { name: name.value.trim() || e.name, type: chosen, group: chosenGroup, aliases: al, desc: desc.value });
      new Notice('设定已保存'); this.close();
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= v2.1 数据中心（热力图 / 码字统计） ================= */
class StatsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.days = 365; this.gran = 'day'; }
  getViewType() { return VIEW_STATS; }
  getDisplayText() { return '写作台 · 数据中心'; }
  getIcon() { return 'chart-no-axes-column'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const today = p.todayData();
    const pace = p.pacePerMinute();
    /* 概览卡 */
    const cards = [
      ['今日码字', fmt(today.words) + ' 字', '📝'],
      ['码字时长', fmtDur(today.secs), '⏱️'],
      ['专注时长', fmtDur(today.focus), '🎯'],
      ['实时速度', pace + ' 字/分', '⚡'],
    ].map((kv) => '<div class="nws-dc-card"><div class="k">' + kv[2] + ' ' + kv[0] + '</div><div class="v">' + kv[1] + '</div></div>').join('');
    /* 热力图：84 天 / 365 天可切换 */
    const heat = this.heatmap(p, this.days);
    const heatBtns = [84, 365].map((n) => '<button class="nws-fbtn' + (this.days === n ? ' on' : '') + '" data-heat="' + n + '">' + (n === 84 ? '3 个月' : '1 年') + '</button>').join('');
    /* 图 1 粒度下拉：日 / 周 / 月 */
    const granOpts = [['day', '日码字数（近 30 天）'], ['week', '周码字数（近 12 周）'], ['month', '月总字数（近 12 月）']];
    const granSel = '<select class="dropdown nws-gran-sel">' + granOpts.map((o) => '<option value="' + o[0] + '"' + (this.gran === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
    /* 每日明细：最近 14 天 */
    const rows = [];
    for (let i = 0; i < 14; i++) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const k = dateKey(dt);
      const d = Object.assign({ words: 0, secs: 0, focus: 0 }, p.data.daily[k] || {});
      const avg = d.secs > 0 ? Math.round(d.words / (d.secs / 60)) : 0;
      rows.push('<tr><td>' + k + (i === 0 ? ' <span class="nws-tag g">今天</span>' : '') + '</td>' +
        '<td>' + fmt(d.words) + '</td><td>' + fmtDur(d.secs) + '</td><td>' + fmtDur(d.focus) + '</td><td>' + avg + '</td></tr>');
    }
    /* 累计 */
    const allDays = Object.keys(p.data.daily);
    const cumWords = allDays.reduce((s, k) => s + (p.data.daily[k].words || 0), 0);
    const cumFocus = allDays.reduce((s, k) => s + (p.data.daily[k].focus || 0), 0);

    const html =
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">📊 数据中心</div><div class="nws-sp"></div>' +
      '<button class="nws-btn" data-act="pomodoro">🍅 番茄钟</button>' +
      '<button class="nws-btn pri" data-act="focus">🎯 专注模式</button></div>' +
      '<div class="nws-psub">累计码字 ' + fmt(cumWords) + ' · 累计专注 ' + fmtDur(cumFocus) + ' · 数据随码字实时更新，保存在本地</div></div>' +
      '<div class="nws-dc">' +
      '<div class="nws-dc-cards">' + cards + '</div>' +
      /* 图 1：码字量（柱）+ 有效码字时长（折线）双轴同图，粒度可切 */
      '<div class="nws-dc-sec"><h4>码字量与时长' + granSel + ' <span class="nws-dc-hint">柱 = 字数（左轴）· 折线 = 有效码字时长（右轴·分）</span></h4>' + this.comboChart(p, this.gran || 'day') + '</div>' +
      /* 图 2：有效码字时长（单独一张） */
      '<div class="nws-dc-sec"><h4>有效码字时长（近 14 天） <span class="nws-dc-hint">双色柱：码字时长 vs 专注时长</span></h4>' + this.durationChart(p, 14) + '</div>' +
      /* 时间分布 */
      '<div class="nws-dc-sec"><h4>时间分布 <span class="nws-dc-hint">你习惯在什么时候写 · 按小时段累计字数</span></h4>' + this.timeDistribution(p) + '</div>' +
      /* 三组指标卡 */
      '<div class="nws-kpi-grid">' +
      '<div class="nws-kpi-col"><h4>码字稳定性</h4>' + this.kpiStability(p) + '</div>' +
      '<div class="nws-kpi-col"><h4>效率</h4>' + this.kpiEfficiency(p) + '</div>' +
      '<div class="nws-kpi-col"><h4>目标达成</h4>' + this.kpiGoals(p) + '</div>' +
      '</div>' +
      '<div class="nws-dc-sec"><h4>设定库使用 Top 10 <span class="nws-dc-hint">按全书出现次数 · 点击打开设定笔记</span></h4>' + this.entityTop10(p) + '</div>' +
      '<div class="nws-dc-sec"><h4>码字热力图（最近 ' + (this.days === 84 ? '3 个月' : '1 年') + '）' +
      '<span class="nws-heat-switch">' + heatBtns + '</span></h4>' + heat +
      '<div class="nws-heat-legend"><span>少</span>' + [0, 1, 2, 3, 4].map((i) => '<i class="h' + i + '"></i>').join('') + '<span>多</span></div></div>' +
      '<div class="nws-dc-sec"><h4>内容更新 · 最近改动 <span class="nws-dc-hint">章节与设定笔记，按修改时间</span></h4>' + this.recentUpdates(p) + '</div>' +
      '<div class="nws-dc-sec"><h4>每日码字明细（最近 14 天）</h4>' +
      '<table class="nws-dc-table"><thead><tr><th>日期</th><th>字数</th><th>码字时长</th><th>专注</th><th>均速(字/分)</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
      '</div>';
    const root = setViewRoot(this, html);
    root.querySelector('[data-act="pomodoro"]').addEventListener('click', () => new FocusModal(this.app, p, 'pomodoro').open());
    root.querySelector('[data-act="focus"]').addEventListener('click', () => new FocusModal(this.app, p, 'focus').open());
    root.querySelectorAll('[data-heat]').forEach((b) => b.addEventListener('click', () => { this.days = Number(b.getAttribute('data-heat')) || 365; this.render(); }));
    root.querySelectorAll('[data-ent]').forEach((row) => row.addEventListener('click', () => {
      const id = row.getAttribute('data-ent'); if (id) p.openEntityFile(id);
    }));
    root.querySelectorAll('[data-open]').forEach((row) => row.addEventListener('click', () => {
      const path = row.getAttribute('data-open'); if (!path) return;
      const f = p.app.vault.getAbstractFileByPath(path);
      if (f) p.app.workspace.getLeaf('tab').openFile(f);
    }));
    const granEl = root.querySelector('.nws-gran-sel');
    if (granEl) granEl.addEventListener('change', (e) => { this.gran = e.target.value; this.render(); });
  }
  /* 粒度聚合：day(近30天) / week(近12周,周一为起点) / month(近12月) → {k,w,secs,label} */
  aggSeries(p, gran) {
    const daily = p.data.daily || {};
    const arr = [];
    const push = (k, label, days) => {
      let w = 0, secs = 0, has = false;
      for (const kk of days) { const dd = daily[kk]; if (dd) { has = true; w += dd.words || 0; secs += dd.secs || 0; } }
      arr.push({ k, label, w, secs, has });
    };
    const keysBetween = (fromD, toD) => { const out = []; const d = new Date(fromD); while (d <= toD) { out.push(dateKey(d)); d.setDate(d.getDate() + 1); } return out; };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (gran === 'month') {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        push(dateKey(d).slice(0, 7), (d.getMonth() + 1) + '月', keysBetween(d, i === 0 ? today : end));
      }
    } else if (gran === 'week') {
      const monday = new Date(today); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      for (let i = 11; i >= 0; i--) {
        const s = new Date(monday); s.setDate(s.getDate() - i * 7);
        const e = new Date(s); e.setDate(e.getDate() + 6);
        push(dateKey(s), (s.getMonth() + 1) + '/' + s.getDate() + ' 周', keysBetween(s, i === 0 ? today : e));
      }
    } else {
      this.dailySeries(p, 30).forEach((d) => { const dd = daily[d.k]; arr.push({ k: d.k, label: d.label, w: d.w, secs: (dd && dd.secs) || 0, has: !!dd }); });
    }
    return arr;
  }
  /* 图 1（合并）：柱 = 字数（左轴），折线 = 有效码字时长（右轴·分钟） */
  comboChart(p, gran) {
    const data = this.aggSeries(p, gran);
    const W = 600, H = 170, PL = 40, PR = 44, PT = 16, PB = 22;
    const maxW = Math.max(500, ...data.map((d) => d.w));
    const maxS = Math.max(30, ...data.map((d) => d.secs / 60));
    const iw = W - PL - PR, ih = H - PT - PB;
    const n = data.length, step = iw / n, bw = Math.min(30, step * 0.6);
    const yW = (v) => PT + ih - (v / maxW) * ih;
    const yS = (v) => PT + ih - (v / maxS) * ih;
    /* 网格（左轴字数 4 档） */
    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const gv = Math.round((maxW / 4) * g);
      const gy = yW(gv);
      grid += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="var(--nws-line)" stroke-width="1"/>' +
        '<text x="' + (PL - 5) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="9" fill="var(--nws-ink2)">' + (gv >= 10000 ? (gv / 10000) + 'w' : (gv >= 1000 ? (gv / 1000) + 'k' : gv)) + '</text>';
      const sv = Math.round((maxS / 4) * g);
      grid += '<text x="' + (W - PR + 5) + '" y="' + (gy + 3) + '" font-size="9" fill="#d09a30">' + sv + '</text>';
    }
    let bars = '';
    data.forEach((d, i) => {
      const bx = PL + i * step + (step - bw) / 2;
      const bh = Math.max(d.w > 0 ? 2 : 0, (d.w / maxW) * ih);
      bars += '<rect x="' + (bx).toFixed(1) + '" y="' + yW(d.w).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="var(--nws-accent)" opacity=".6"><title>' + d.k + '：' + fmt(d.w) + ' 字</title></rect>';
    });
    const pts = data.map((d, i) => (PL + i * step + step / 2).toFixed(1) + ',' + yS(d.secs / 60).toFixed(1)).join(' ');
    let xl = '';
    const tick = gran === 'day' ? 7 : (gran === 'week' ? 2 : 1);
    data.forEach((d, i) => { if (i % tick === 0 || i === n - 1) xl += '<text x="' + (PL + i * step + step / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="var(--nws-ink2)">' + d.label + '</text>'; });
    const totW = data.reduce((s, d) => s + d.w, 0);
    const totS = data.reduce((s, d) => s + d.secs, 0);
    return '<div class="nws-chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:' + H + 'px">' +
      grid + bars +
      '<polyline points="' + pts + '" fill="none" stroke="#d09a30" stroke-width="2" stroke-linejoin="round"/>' +
      data.map((d, i) => '<circle cx="' + (PL + i * step + step / 2) + '" cy="' + yS(d.secs / 60) + '" r="2.2" fill="#d09a30"><title>' + d.k + '：' + fmtDur(d.secs) + '</title></circle>').join('') +
      xl + '</svg>' +
      '<div class="nws-chart-sum">合计 <b>' + fmt(totW) + '</b> 字 · 有效码字 <b>' + fmtDur(totS) + '</b> · 均速 <b>' + (totS > 0 ? Math.round(totW / (totS / 60)) : 0) + '</b> 字/分</div></div>';
  }
  /* 图 2（单独）：近 14 天有效码字时长——码字时长 vs 专注时长 双柱 */
  durationChart(p, n) {
    const daily = p.data.daily || {};
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const k = dateKey(dt);
      const dd = daily[k] || {};
      days.push({ k, label: (dt.getMonth() + 1) + '/' + dt.getDate(), secs: dd.secs || 0, focus: dd.focus || 0 });
    }
    const W = 600, H = 150, PL = 40, PR = 10, PT = 16, PB = 22;
    const max = Math.max(600, ...days.map((d) => Math.max(d.secs, d.focus)));
    const iw = W - PL - PR, ih = H - PT - PB;
    const step = iw / n, bw = Math.min(11, step * 0.34);
    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const gv = Math.round((max / 4) * g), gy = PT + ih - (gv / max) * ih;
      grid += '<line x1="' + PL + '" y1="' + gy + '" x2="' + (W - PR) + '" y2="' + gy + '" stroke="var(--nws-line)" stroke-width="1"/>' +
        '<text x="' + (PL - 5) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="9" fill="var(--nws-ink2)">' + (gv >= 3600 ? (gv / 3600) + '时' : Math.round(gv / 60) + '分') + '</text>';
    }
    let bars = '';
    days.forEach((d, i) => {
      const cx = PL + i * step + step / 2;
      const h1 = Math.max(d.secs > 0 ? 2 : 0, (d.secs / max) * ih);
      const h2 = Math.max(d.focus > 0 ? 2 : 0, (d.focus / max) * ih);
      bars += '<rect x="' + (cx - bw - 1).toFixed(1) + '" y="' + (PT + ih - h1).toFixed(1) + '" width="' + bw + '" height="' + h1.toFixed(1) + '" rx="2" fill="var(--nws-accent)" opacity=".75"><title>' + d.k + ' 码字：' + fmtDur(d.secs) + '</title></rect>';
      bars += '<rect x="' + (cx + 1).toFixed(1) + '" y="' + (PT + ih - h2).toFixed(1) + '" width="' + bw + '" height="' + h2.toFixed(1) + '" rx="2" fill="#6287A8" opacity=".85"><title>' + d.k + ' 专注：' + fmtDur(d.focus) + '</title></rect>';
      if (i % 3 === 0 || i === n - 1) bars += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="var(--nws-ink2)">' + d.label + '</text>';
    });
    const totS = days.reduce((s, d) => s + d.secs, 0), totF = days.reduce((s, d) => s + d.focus, 0);
    return '<div class="nws-chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:' + H + 'px">' + grid + bars + '</svg>' +
      '<div class="nws-chart-sum"><i class="nws-lg-dot" style="background:var(--nws-accent)"></i> 码字 <b>' + fmtDur(totS) + '</b>　<i class="nws-lg-dot" style="background:#6287A8"></i> 专注 <b>' + fmtDur(totF) + '</b></div></div>';
  }
  /* 时间分布：凌晨/上午/下午/晚上 + 工作日/周末 */
  timeDistribution(p) {
    const daily = p.data.daily || {};
    const seg = [0, 0, 0, 0]; // 凌晨0-6 上午6-12 下午12-18 晚上18-24
    let wk = 0, we = 0, hasHours = false;
    Object.keys(daily).forEach((k) => {
      const dd = daily[k];
      if (Array.isArray(dd.hours)) {
        hasHours = true;
        for (let h = 0; h < 24; h++) seg[Math.floor(h / 6)] += dd.hours[h] || 0;
      }
      wk += dd.wk || 0; we += dd.we || 0;
    });
    if (!hasHours && wk === 0 && we === 0) return '<div class="nws-dc-empty">时间分布从现在开始记录——写作时自动按小时段累计，写一会儿再回来看就有数据了。</div>';
    const names = ['🌙 凌晨 0-6', '🌅 上午 6-12', '☀️ 下午 12-18', '🌃 晚上 18-24'];
    const maxSeg = Math.max(1, ...seg);
    const rows = seg.map((v, i) => '<div class="nws-seg-row"><span class="nm">' + names[i] + '</span>' +
      '<span class="bar"><i style="width:' + Math.round((v / maxSeg) * 100) + '%"></i></span>' +
      '<span class="ct">' + fmt(v) + ' 字</span></div>').join('');
    const wkw = wk + we > 0 ? Math.round((wk / (wk + we)) * 100) : 50;
    const dowRow = '<div class="nws-seg-row dow"><span class="nm">工作日</span><span class="bar split"><i style="width:' + wkw + '%"></i></span><span class="nm2">周末</span></div>' +
      '<div class="nws-seg-sum">工作日 ' + fmt(wk) + ' 字（' + wkw + '%）· 周末 ' + fmt(we) + ' 字（' + (100 - wkw) + '%）</div>';
    const best = seg.indexOf(Math.max(...seg));
    return '<div class="nws-time-dist">' + rows + dowRow +
      '<div class="nws-chart-sum">你最常在 <b>' + names[best].replace(/^\S+\s/, '') + '</b> 写作</div></div>';
  }
  /* KPI 卡片组装 */
  kpiRow(label, value, sub) {
    return '<div class="nws-kpi"><div class="l">' + label + '</div><div class="v">' + value + '</div>' + (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>';
  }
  /* 码字稳定性：连续更新 / 断更次数 / 字数波动 */
  kpiStability(p) {
    const daily = p.data.daily || {};
    const get = (off) => { const d = new Date(); d.setDate(d.getDate() - off); return (daily[dateKey(d)] || {}).words || 0; };
    /* 连续更新：今天有产出从今天数，否则从昨天数 */
    let streak = 0, start = get(0) > 0 ? 0 : (get(1) > 0 ? 1 : -1);
    if (start >= 0) { let i = start; while (get(i) > 0) { streak++; i++; } }
    /* 断更次数：近 30 天中 0 字天数（从首次记录日起算） */
    let gaps = 0, recorded = 0;
    for (let i = 0; i < 30; i++) { const w = get(i); if (w > 0) recorded++; else if (daily[dateKeyOf(i)] || (i < 30 && (30 - i) <= firstAge(daily))) gaps++; }
    /* 字数波动：近 14 天产出日的标准差/均值 */
    const ws = []; for (let i = 0; i < 14; i++) { const w = get(i); if (w > 0) ws.push(w); }
    let cv = '—';
    if (ws.length >= 3) {
      const mean = ws.reduce((a, b) => a + b, 0) / ws.length;
      const sd = Math.sqrt(ws.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ws.length);
      cv = Math.round((sd / mean) * 100) + '%';
    }
    return this.kpiRow('连续更新', streak + ' 天', streak >= 3 ? '🔥 状态在线' : '保持住') +
      this.kpiRow('断更次数（30 天）', gaps + ' 次', recorded + ' 天有产出') +
      this.kpiRow('字数波动（14 天）', cv, ws.length + ' 个产出日');
    function firstAge(dl) { /* 首次记录距今天数：0 字但从未记录过的不算断更 */
      const keys = Object.keys(dl).sort();
      if (!keys.length) return 99;
      const d0 = new Date(keys[0]); const d1 = new Date();
      return Math.floor((d1 - d0) / 86400e3);
    }
    function dateKeyOf(off) { const d = new Date(); d.setDate(d.getDate() - off); return dateKey(d); }
  }
  /* 效率：有效写作时长占比 / 删除修改比例 / 卡文时长 / 番茄钟完成率 */
  kpiEfficiency(p) {
    let open = 0, active = 0;
    Object.values(p.data.chapters || {}).forEach((m) => { const t = m && m.timing; if (t) { open += t.open || 0; active += t.active || 0; } });
    const effPct = open > 0 ? Math.round((active / open) * 100) : 0;
    let del = 0, wds = 0;
    Object.values(p.data.daily || {}).forEach((d) => { del += d.del || 0; wds += d.words || 0; });
    const delPct = (del + wds) > 0 ? Math.round((del / (del + wds)) * 100) : 0;
    const stuck = Math.max(0, open - active);
    const pm = p.data.pomo || { started: 0, completed: 0 };
    const pomoPct = pm.started > 0 ? Math.round((pm.completed / pm.started) * 100) : 0;
    return this.kpiRow('有效写作时长占比', effPct + '%', fmtDur(active) + ' / ' + fmtDur(open)) +
      this.kpiRow('删除修改比例', delPct + '%', '删 ' + fmt(del) + ' · 写 ' + fmt(wds)) +
      this.kpiRow('卡文/摸鱼时长', fmtDur(stuck), '打开但没写的时间') +
      this.kpiRow('番茄钟完成率', pomoPct + '%', pm.completed + ' / ' + pm.started + ' 个');
  }
  /* 目标达成：日更目标完成率 / 月度完稿率 / 章节平均耗时 */
  kpiGoals(p) {
    const goal = Number(p.settings.dailyGoal) || 1000;
    const daily = p.data.daily || {};
    let hit = 0, rec = 0;
    for (let i = 0; i < 30; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dd = daily[dateKey(d)];
      if (dd && (dd.words > 0 || dd.secs > 0)) { rec++; if ((dd.words || 0) >= goal) hit++; }
    }
    const goalPct = rec > 0 ? Math.round((hit / rec) * 100) : 0;
    /* 月度完稿率：本月写过字的章节中已定稿占比 */
    const now = new Date(), monthPrefix = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const chapters = (p.stats && p.stats.chapters) || [];
    const timingMap = p.data.chapters || {};
    let written = 0, done = 0;
    chapters.forEach((c) => {
      const t = (timingMap[c.path] || {}).timing;
      if (t && (t.written > 0 || t.open > 0)) { written++; if (c.status === 3) done++; }
    });
    const finPct = written > 0 ? Math.round((done / written) * 100) : 0;
    /* 章节平均耗时 */
    let totOpen = 0, cnt = 0;
    Object.values(timingMap).forEach((m) => { const t = m && m.timing; if (t && t.open > 60) { totOpen += t.open; cnt++; } });
    const avgOpen = cnt > 0 ? Math.round(totOpen / cnt) : 0;
    return this.kpiRow('日更目标完成率', goalPct + '%', '达标 ' + hit + '/' + rec + ' 天 · 目标 ' + fmt(goal) + ' 字') +
      this.kpiRow('完稿率（本书）', finPct + '%', done + ' / ' + written + ' 章已定稿') +
      this.kpiRow('章节平均耗时', cnt > 0 ? fmtDur(avgOpen) : '—', cnt + ' 章有计时');
  }
  /* 每日字数序列（最近 n 天，含今天） */
  dailySeries(p, n) {
    const arr = [];
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(); dt.setDate(dt.getDate() - i);
      const k = dateKey(dt);
      arr.push({ k, w: (p.data.daily[k] || {}).words || 0, label: (dt.getMonth() + 1) + '/' + dt.getDate() });
    }
    return arr;
  }
  entityTop10(p) {
    const st = p.stats || { perEntity: {} };
    const arr = Object.values(st.perEntity || {}).filter((pe) => pe && pe.entity && pe.total > 0);
    if (!arr.length) return '<div class="nws-dc-empty">还没有设定在正文中出现过——去正文里写到角色/世界观的名字，这里就会出现条形统计。</div>';
    arr.sort((a, b) => b.total - a.total);
    const top = arr.slice(0, 10);
    /* 与正文设定高亮同色（nws-c0..5），深浅两套随主题 */
    const dark = document.body.classList.contains('theme-dark');
    const COLORS = dark ? ['#E0A19B', '#A6C7AF', '#A4BED6', '#E0B57F', '#DCCB7E', '#BCAED0'] : ['#B5716B', '#6F9A7C', '#6287A8', '#B98448', '#B19A44', '#8E7BA9'];
    const max = top[0].total || 1;
    const rows = top.map((pe, i) => {
      const e = pe.entity;
      const pct = Math.max(6, Math.round((pe.total / max) * 100));
      const color = hasEntityColor(e) ? COLORS[e.color % 6] : 'var(--nws-accent)';
      return '<div class="nws-top-row" data-ent="' + escapeHtml(e.id) + '" title="点击打开设定笔记">' +
        '<span class="rk">' + (i + 1) + '</span>' +
        '<span class="nm">' + escapeHtml(e.name || '') + (e.type ? ' <i class="tp">' + escapeHtml(e.type) + '</i>' : '') + '</span>' +
        '<span class="bar"><i style="width:' + pct + '%;background:' + color + '"></i></span>' +
        '<span class="ct">' + fmt(pe.total) + ' 次</span></div>';
    }).join('');
    return '<div class="nws-top10">' + rows + '</div>';
  }
  /* 内容更新：最近改动的章节 + 设定笔记（按文件 mtime） */
  recentUpdates(p) {
    const items = [];
    const push = (path, name, kind) => {
      try {
        const f = p.app.vault.getAbstractFileByPath(path);
        if (f && f.stat && f.stat.mtime) items.push({ path, name, kind, mtime: f.stat.mtime });
      } catch (e) { /* 忽略 */ }
    };
    (p.allChapters() || []).slice(0, 60).forEach((c) => push(c.path, c.title, '章节'));
    (p.data.entities || []).forEach((e) => { if (e.file) push(e.file, e.name || String(e.file), e.type || '设定'); });
    if (!items.length) return '<div class="nws-dc-empty">暂无章节与设定文件，先在目录里创建章节吧。</div>';
    items.sort((a, b) => b.mtime - a.mtime);
    const top = items.slice(0, 10);
    const now = Date.now();
    const rel = (ms) => {
      const dt = Math.floor((now - ms) / 1000);
      if (dt < 60) return '刚刚';
      if (dt < 3600) return Math.floor(dt / 60) + ' 分钟前';
      if (dt < 86400) return Math.floor(dt / 3600) + ' 小时前';
      if (dt < 86400 * 30) return Math.floor(dt / 86400) + ' 天前';
      return new Date(ms).toISOString().slice(0, 10);
    };
    const rows = top.map((it) => '<div class="nws-upd-row" data-open="' + escapeHtml(it.path) + '" title="点击打开">' +
      '<span class="k ' + (it.kind === '章节' ? 'ch' : 'ent') + '">' + (it.kind === '章节' ? '📄 章节' : '🏷 设定') + '</span>' +
      '<span class="nm">' + escapeHtml(it.name) + '</span>' +
      '<span class="tm">' + rel(it.mtime) + '</span></div>').join('');
    return '<div class="nws-updates">' + rows + '</div>';
  }
  heatmap(p, days) {
    const small = days > 100;
    const cells = [];
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - (days - 1));
    /* 对齐到周日开始 */
    const gridStart = new Date(start); gridStart.setDate(gridStart.getDate() - gridStart.getDay());
    let cur = new Date(gridStart);
    const weeks = [];
    let monthMarks = '';
    let lastMonth = -1;
    while (cur <= end) {
      if (small && cur.getDay() === 0 && cur.getMonth() !== lastMonth) { lastMonth = cur.getMonth(); monthMarks += '<span style="width:' + (weeks.length * 10) + 'px" class="mk">' + (lastMonth + 1) + '月</span>'; }
      const week = [];
      for (let d = 0; d < 7; d++) {
        const k = dateKey(cur);
        const w = (p.data.daily[k] || {}).words || 0;
        let lv = 0;
        if (w > 0 && w < 500) lv = 1; else if (w < 1500) lv = 2; else if (w < 3000) lv = 3; else if (w >= 3000) lv = 4;
        const inRange = cur >= start && cur <= end;
        week.push('<i class="nws-heat h' + lv + (inRange ? '' : ' out') + '" title="' + k + '：' + fmt(w) + ' 字"></i>');
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push('<div class="nws-heat-week">' + week.join('') + '</div>');
    }
    const cls = small ? ' nws-heatmap sm' : '';
    return (small && monthMarks ? '<div class="nws-heat-months">' + monthMarks + '</div>' : '') +
      '<div class="nws-heatmap' + cls + '">' + weeks.join('') + '</div>';
  }
}

/* ================= v2.5 本章统计弹窗 =================
   每章单独展示：目标 vs 字数 / 码字速度 / 专注时长 / 偷懒时间 /
   设定按大类与小库分类统计 / 本章出现最多的设定 Top10。 */
class ChapterStatsModal extends Modal {
  constructor(app, plugin, path) { super(app); this.p = plugin; this.path = path; }
  onOpen() {
    this.contentEl.addClass('nws-chstat-modal');
    this.render();
    /* 专注/码字进行中时每 3 秒轻量刷新 */
    this._timer = setInterval(() => { if (this.p.focusState.active) this.render(); }, 3000);
  }
  render() {
    const p = this.p, path = this.path;
    const ch = (p.allChapters().find((c) => c.path === path)) || { title: path.split('/').pop().replace(/\.md$/, ''), volume: '—', words: 0, status: 0 };
    const t = p.chapterTiming(path);
    const target = p.targetOf(path);
    const words = ch.words || 0;
    const idle = Math.max(0, t.open - t.active);
    const speed = t.active > 0 ? Math.round(t.written / (t.active / 60)) : 0;
    const pct = target > 0 ? Math.min(100, Math.round(words / target * 100)) : 0;
    const st = p.aggregate();
    const es = p.chapterEntityStats(path);

    const bar = (pctv) => '<div class="nws-chprog"><div class="fill" style="width:' + Math.max(0, Math.min(100, pctv)) + '%"></div></div>';
    const row = (k, v) => '<div class="nws-chrow"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    const gbar = (val, max) => '<span class="nws-chgbar"><i style="width:' + (max > 0 ? Math.round(val / max * 100) : 0) + '%"></i></span>';

    /* 大类统计 */
    const gmax = es.groups.length ? Math.max.apply(null, es.groups.map((g) => g.total)) : 0;
    const gRows = es.groups.map((g) => {
      const sub = g.libArr.map((l) => typeEmoji(l.name) + ' ' + escapeHtml(l.name) + '×' + l.total).join('　');
      return row(groupEmoji(g.name) + ' ' + escapeHtml(g.name), '<b>' + g.total + '</b> 次 ' + gbar(g.total, gmax) + (sub ? '<span class="sub">' + sub + '</span>' : ''));
    }).join('');
    /* 小库统计 */
    const lmax = es.libs.length ? Math.max.apply(null, es.libs.map((l) => l.total)) : 0;
    const lRows = es.libs.map((l) => row(l.emoji + ' ' + escapeHtml(l.name), '<b>' + l.total + '</b> 次 ' + gbar(l.total, lmax))).join('');
    /* Top10 */
    const topRows = es.top.map((it, i) =>
      '<div class="nws-chtop" data-eid="' + it.e.id + '"><span class="rk">' + (i + 1) + '</span>' +
      '<span class="nm">' + typeEmoji(it.e.type) + ' ' + escapeHtml(it.e.name) + '</span>' +
      '<span class="nws-chgbar"><i style="width:' + (es.top[0].n ? Math.round(it.n / es.top[0].n * 100) : 0) + '%"></i></span>' +
      '<b class="ct">×' + it.n + '</b></div>').join('');

    const html =
      '<h3>📊 本章统计 — ' + escapeHtml(ch.title) + '</h3>' +
      '<div class="nws-chmeta">' + escapeHtml(ch.volume) + ' · ' + (CH_STATUS[ch.status] || '草稿') +
      (es.total ? ' · 本章设定共出现 <b>' + es.total + '</b> 次' : '') + '</div>' +

      '<div class="nws-chsec"><h4>🎯 目标与字数</h4>' +
      row('当前字数', '<b>' + fmt(words) + '</b> 字') +
      row('本章目标', target > 0 ? fmt(target) + ' 字' : '未设定（全局默认 ' + fmt(p.settings.chapterTarget || DEFAULT_CHAPTER_TARGET) + ' 字）') +
      (target > 0 ? row('完成度', pct + '%（还差 ' + fmt(Math.max(0, target - words)) + ' 字）' + bar(pct)) : '') +
      '</div>' +

      '<div class="nws-chsec"><h4>⏱️ 码字与专注</h4>' +
      '<div class="nws-dc-cards">' +
      [['码字速度', t.active > 0 ? speed + ' 字/分' : '—', '⚡'],
       ['码字时长', fmtDur(t.active), '⌨️'],
       ['专注时长', fmtDur(t.focus), '🎯'],
       ['偷懒时间', fmtDur(idle), '😴']].map((kv) =>
        '<div class="nws-dc-card"><div class="k">' + kv[2] + ' ' + kv[0] + '</div><div class="v">' + kv[1] + '</div></div>').join('') +
      '</div>' +
      row('打开本章时长', fmtDur(t.open)) + row('本章累计输入', fmt(t.written) + ' 字（含删改）') +
      '<div class="nws-chtip">打开本章即开始计时；60 秒内有敲字记为码字，否则记为偷懒；专注模式计时中自动记为专注。</div></div>' +

      '<div class="nws-chsec"><h4>🗂️ 设定分类统计（本章出现的设定）</h4>' +
      (es.groups.length
        ? '<div class="nws-chlist">' + gRows + '</div>' +
          '<details class="nws-chlibs"><summary>按小库细分（' + es.libs.length + ' 个库）</summary><div class="nws-chlist">' + lRows + '</div></details>'
        : '<div class="nws-chtip">本章还没有出现设定词。设定着色开启后，正文中出现的设定会自动统计。</div>') +
      '</div>' +

      '<div class="nws-chsec"><h4>🏆 本章出现最多的设定 Top ' + Math.min(10, es.top.length || 10) + '</h4>' +
      (es.top.length ? '<div class="nws-chtops">' + topRows + '</div>' : '<div class="nws-chtip">暂无数据。</div>') +
      '</div>';

    this.contentEl.innerHTML = html;
    this.modalEl.classList.toggle('nws-wide', false);
    /* Top10 点击 → 打开设定详情 */
    this.contentEl.querySelectorAll('.nws-chtop').forEach((r) => r.addEventListener('click', () => {
      const e = p.entityById(r.dataset.eid);
      if (e) { this.close(); new EntityDetailModal(this.app, p, e).open(); }
    }));
  }
  onClose() { if (this._timer) clearInterval(this._timer); this.contentEl.empty(); }
}

/* 移动章节到其他分卷 */
class ChapterMoveModal extends Modal {
  constructor(app, plugin, path) { super(app); this.p = plugin; this.path = path; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    const title = this.path.split('/').pop().replace(/\.md$/, '');
    const cur = p.volumeOfPath(this.path);
    /* 收集所有卷（保持目录视图顺序：未分卷在前） */
    const bodyRoot = p.settings.folderBody || '正文';
    const vols = [];
    p.app.vault.getMarkdownFiles().forEach((f) => {
      if (f.path.indexOf(bodyRoot + '/') !== 0) return;
      const rel = f.path.slice((bodyRoot + '/').length);
      const i = rel.indexOf('/');
      if (i > 0 && vols.indexOf(rel.slice(0, i)) < 0) vols.push(rel.slice(0, i));
    });
    contentEl.createEl('h3', { text: '📁 移动章节「' + title + '」' });
    const desc = contentEl.createEl('div', { text: '当前所在卷：' + cur + '。点击目标卷即移动（章节文件与其状态/目标/计时数据一起走）。' });
    desc.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.6';
    const row = contentEl.createDiv(); row.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    const targets = ['（未分卷）'].concat(vols.filter((v) => v !== cur));
    if (!targets.length) { const t = contentEl.createEl('div', { text: '没有其他可移动的卷。可先在目录「＋ 新建卷」。' }); t.style.cssText = 'color:var(--text-muted);font-size:12px'; return; }
    targets.forEach((v) => {
      const b = row.createEl('button', { text: (v === '（未分卷）' ? '📂 ' + v + '（正文根目录）' : '📚 ' + v) });
      b.className = 'nws-btn';
      b.style.cssText = 'text-align:left;width:100%';
      b.addEventListener('click', async () => { this.close(); await p.moveChapter(this.path, v); });
    });
  }
  onClose() { this.contentEl.empty(); }
}

/* v2.7 卷级数据分析：一卷内所有章节的聚合统计 */
class VolumeStatsModal extends Modal {
  constructor(app, plugin, volume) { super(app); this.p = plugin; this.volume = volume; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    const vols = Object.create(null);
    p.allChapters().forEach((c) => { (vols[c.volume] = vols[c.volume] || []).push(c); });
    const list = vols[this.volume] || [];
    const words = list.reduce((s, c) => s + c.words, 0);
    const target = list.reduce((s, c) => s + p.targetOf(c.path), 0);
    /* 卷内设定聚合 */
    const agg = Object.create(null);
    list.forEach((c) => { const m = p.stats.perChapter[c.path] || {}; Object.keys(m).forEach((id) => { agg[id] = (agg[id] || 0) + m[id]; }); });
    const top = Object.keys(agg).sort((a, b) => agg[b] - agg[a]).slice(0, 10);
    /* 计时聚合 */
    const tim = list.reduce((acc, c) => { const t = p.chapterTiming(c.path); acc.open += t.open; acc.active += t.active; acc.focus += t.focus; acc.written += t.written; return acc; }, { open: 0, active: 0, focus: 0, written: 0 });
    const stCount = list.map((c) => (c.status == null ? (c.words > 0 ? 1 : 0) : c.status));
    const stRows = CH_STATUS.map((s, i) => '<span class="nws-tag">' + s + ' × ' + stCount.filter((x) => x === i).length + '</span>').join(' ');
    const pct = target > 0 ? Math.min(100, Math.round(words / target * 100)) : 0;

    contentEl.createEl('h3', { text: '📊 卷数据分析 · ' + this.volume });
    const cards = contentEl.createDiv();
    cards.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px';
    [['章节数', list.length], ['总字数', fmt(words)], ['总目标', target > 0 ? fmt(target) : '未设'], ['完成度', pct + '%']].forEach((kv) => {
      const d = cards.createDiv(); d.style.cssText = 'background:var(--background-secondary);border-radius:8px;padding:8px;text-align:center';
      const k = d.createDiv(); k.textContent = kv[0]; k.style.cssText = 'font-size:10px;color:var(--text-muted)';
      const v = d.createDiv(); v.textContent = String(kv[1]); v.style.cssText = 'font-size:16px;font-weight:700';
    });
    const prog = contentEl.createDiv();
    prog.style.cssText = 'height:8px;background:var(--background-secondary);border-radius:4px;overflow:hidden;margin-bottom:10px';
    prog.innerHTML = '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#a8bfa0,#c9a24a)"></div>';
    const stRow = contentEl.createDiv(); stRow.style.cssText = 'margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap';
    stRow.innerHTML = stRows;
    /* 各章表 */
    const tbl = contentEl.createEl('table');
    tbl.style.cssText = 'width:100%;font-size:12px;border-collapse:collapse;margin-bottom:12px';
    tbl.innerHTML = '<thead><tr>' + ['章节', '状态', '字数/目标', '打开', '码字', '偷懒', '专注'].map((h) => '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--background-modifier-border)">' + h + '</th>').join('') + '</tr></thead><tbody>' +
      list.map((c) => {
        const t = p.chapterTiming(c.path);
        const st = CH_STATUS[c.status == null ? (c.words > 0 ? 1 : 0) : c.status];
        return '<tr>' + ['<td>' + escapeHtml(c.title) + '</td>', '<td>' + st + '</td>', '<td>' + fmt(c.words) + ' / ' + (p.targetOf(c.path) || '—') + '</td>', '<td>' + fmtDur(t.open) + '</td>', '<td>' + fmtDur(t.active) + '</td>', '<td>' + fmtDur(t.open - t.active) + '</td>', '<td>' + fmtDur(t.focus) + '</td>'].join('') + '</tr>';
      }).join('') + '</tbody>';
    /* 卷内设定 Top10 */
    contentEl.createEl('p', { text: '本卷出现的设定 Top 10' }).style.cssText = 'font-weight:600;margin-bottom:5px';
    if (top.length) {
      const max = agg[top[0]];
      const box = contentEl.createDiv();
      top.forEach((id) => {
        const e = p.entityById(id);
        if (!e) return;
        const rowEl = box.createDiv(); rowEl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
        const nm = rowEl.createSpan(); nm.textContent = typeEmoji(e.type) + ' ' + e.name; nm.style.cssText = 'width:130px;font-size:12px;flex-shrink:0';
        const bar = rowEl.createDiv(); bar.style.cssText = 'flex:1;height:10px;background:var(--background-secondary);border-radius:5px;overflow:hidden';
        bar.innerHTML = '<div style="height:100%;width:' + Math.round(agg[id] / max * 100) + '%;background:var(--interactive-accent)"></div>';
        const cnt = rowEl.createSpan(); cnt.textContent = '×' + agg[id]; cnt.style.cssText = 'font-size:11px;color:var(--text-muted);width:34px;text-align:right';
      });
    } else {
      const tip = contentEl.createDiv(); tip.textContent = '本卷章节里还没有出现任何设定词（把设定名写进正文就会统计）。';
      tip.style.cssText = 'color:var(--text-muted);font-size:12px';
    }
    const foot = contentEl.createDiv(); foot.style.cssText = 'margin-top:8px;font-size:10px;color:var(--text-muted)';
    foot.textContent = '计时合计：打开 ' + fmtDur(tim.open) + ' · 码字 ' + fmtDur(tim.active) + ' · 偷懒 ' + fmtDur(tim.open - tim.active) + ' · 专注 ' + fmtDur(tim.focus);
  }
  onClose() { this.contentEl.empty(); }
}

/* v2.7 批注弹窗：不改原文，只记录批注 */
class AnnotationModal extends Modal {
  constructor(app, plugin, path, quote, from, to) { super(app); this.p = plugin; this.path = path; this.quote = quote; this.from = from; this.to = to; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: '📝 添加批注' });
    const q = contentEl.createDiv();
    q.style.cssText = 'font-size:11px;color:var(--text-muted);background:var(--background-secondary);padding:7px 9px;border-radius:7px;line-height:1.6;margin-bottom:10px';
    q.textContent = '批注对象：「' + this.quote.slice(0, 80) + (this.quote.length > 80 ? '…' : '') + '」';
    contentEl.createEl('p', { text: '批注内容（原文不会改动；鼠标悬浮在原文该段上即可看到批注）' }).style.cssText = 'font-weight:600;margin-bottom:5px';
    const ta = contentEl.createEl('textarea');
    ta.placeholder = '写下你的想法：这段为什么要这样写、要修改什么、灵感延伸…';
    ta.style.cssText = 'width:100%;height:110px;font-size:13px';
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:10px;text-align:right';
    const cancel = row.createEl('button', { text: '取消' }); cancel.style.marginRight = '8px';
    const ok = row.createEl('button', { text: '保存批注' }); ok.className = 'mod-cta';
    cancel.addEventListener('click', () => this.close());
    ok.addEventListener('click', async () => {
      await p.addAnnotation(this.path, this.quote, ta.value.trim(), this.from, this.to);
      this.close();
    });
    setTimeout(() => ta.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* v2.7 批注管理视图：表格呈现，可跳转回原文 */
class AnnotsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_ANNOT; }
  getDisplayText() { return '写作台 · 批注'; }
  getIcon() { return 'sticky-note'; }
  async onOpen() { this.render(); }
  render() {
    const p = this.plugin;
    const anns = (p.data.annotations || []).slice().sort((a, b) => b.created - a.created);
    const chTitle = (path) => (p.allChapters().find((c) => c.path === path) || {}).title || String(path).split('/').pop().replace(/\.md$/, '');
    const rows = anns.map((a) =>
      '<tr data-aid="' + a.id + '">' +
      '<td class="c">' + escapeHtml(chTitle(a.path)) + '</td>' +
      '<td class="q">「' + escapeHtml(String(a.quote || '').slice(0, 40)) + (String(a.quote || '').length > 40 ? '…' : '') + '」</td>' +
      '<td class="n">' + escapeHtml(a.note || '（无内容）') + '</td>' +
      '<td class="t">' + new Date(a.created).toLocaleDateString() + '</td>' +
      '<td class="ops"><button class="nws-btn sm" data-jump="' + a.id + '">跳转</button><button class="nws-btn sm" data-edit="' + a.id + '">编辑</button><button class="nws-btn sm" data-del="' + a.id + '">删</button></td>' +
      '</tr>').join('');
    const root = setViewRoot(this,
      '<div class="nws-phead"><div class="nws-row"><div class="nws-ptitle">📝 批注 <span class="nws-tag">' + anns.length + ' 条</span></div>' +
      '<div class="nws-sp"></div><button class="nws-fold" data-view="catalog">📖 目录</button></div>' +
      '<div class="nws-psub">在正文中选中文字 → 右键 →「📝 添加批注」· 原文不改一个字，鼠标悬浮在该段上即可看到批注</div></div>' +
      (anns.length
        ? '<table class="nws-annot-table"><thead><tr><th>章节</th><th>原文摘录</th><th>批注内容</th><th>日期</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<div class="nws-empty">还没有批注。<br>在正文里选中一段文字，右键选「📝 添加批注」试试。</div>'));
    root.querySelector('[data-view="catalog"]').addEventListener('click', () => p.activateView(VIEW_CATALOG));
    root.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = p.annotById(b.dataset.jump);
      if (a) p.jumpToAnnotation(a);
    }));
    root.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = p.annotById(b.dataset.edit);
      if (a) new AnnotationEditModal(this.app, p, a).open();
    }));
    root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('删除这条批注？')) p.deleteAnnotation(b.dataset.del);
    }));
    root.querySelectorAll('tr[data-aid]').forEach((tr) => tr.addEventListener('click', () => {
      const a = p.annotById(tr.dataset.aid);
      if (a) p.jumpToAnnotation(a);
    }));
  }
}

/* 编辑已有批注 */
class AnnotationEditModal extends Modal {
  constructor(app, plugin, annot) { super(app); this.p = plugin; this.a = annot; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.createEl('h3', { text: '📝 编辑批注' });
    const q = contentEl.createDiv();
    q.style.cssText = 'font-size:11px;color:var(--text-muted);background:var(--background-secondary);padding:7px 9px;border-radius:7px;line-height:1.6;margin-bottom:10px';
    q.textContent = '批注对象：「' + String(this.a.quote || '').slice(0, 80) + '」';
    const ta = contentEl.createEl('textarea');
    ta.value = this.a.note || '';
    ta.style.cssText = 'width:100%;height:110px;font-size:13px';
    const row = contentEl.createDiv(); row.style.cssText = 'margin-top:10px;text-align:right';
    const ok = row.createEl('button', { text: '保存' }); ok.className = 'mod-cta';
    ok.addEventListener('click', async () => { await p.updateAnnotation(this.a.id, { note: ta.value.trim() }); this.close(); });
    setTimeout(() => ta.focus(), 30);
  }
  onClose() { this.contentEl.empty(); }
}

/* ================= v2.1 番茄钟 / 专注模式 ================= */
class FocusModal extends Modal {
  constructor(app, plugin, mode) { super(app); this.p = plugin; this.mode = mode || 'focus'; }
  onOpen() {
    const { contentEl } = this, p = this.p;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.mode === 'pomodoro' ? '🍅 番茄钟' : '🎯 专注模式' });
    const desc = contentEl.createDiv();
    desc.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';
    desc.textContent = this.mode === 'pomodoro'
      ? '专注 ' + p.settings.pomodoroWork + ' 分 / 短休 ' + p.settings.pomodoroBreak + ' 分 / ' + p.settings.pomodoroRounds + ' 轮后长休 ' + p.settings.pomodoroLongBreak + ' 分；可在下方直接输入任意分钟数。'
      : '进入全屏禅模式：低刺激深色壁纸 + 可选背景音 + 打字音效；当前段高亮、前后渐淡。';

    /* --- 计时选择 --- */
    const row = contentEl.createDiv(); row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px';
    row.createSpan({ text: '时长：' }).style.cssText = 'font-size:11px';
    let chosenSec = 0;
    const presets = this.mode === 'pomodoro'
      ? [{ l: '专注 ' + p.settings.pomodoroWork + '分', s: p.settings.pomodoroWork * 60 }, { l: '短休 ' + p.settings.pomodoroBreak + '分', s: p.settings.pomodoroBreak * 60 }, { l: '长休 ' + p.settings.pomodoroLongBreak + '分', s: p.settings.pomodoroLongBreak * 60 }]
      : [{ l: '15 分', s: 900 }, { l: '25 分', s: 1500 }, { l: '45 分', s: 2700 }, { l: '90 分', s: 5400 }];
    let activeBtn = null;
    presets.forEach((ps, i) => {
      const b = row.createEl('button', { text: ps.l }); b.className = 'nws-fbtn' + (i === (this.mode === 'pomodoro' ? 0 : 0) ? ' on' : '');
      if (i === 0) { activeBtn = b; chosenSec = ps.s; }
      b.addEventListener('click', () => { if (activeBtn) activeBtn.removeClass('on'); b.addClass('on'); activeBtn = b; chosenSec = ps.s; });
    });
    /* v2.8：任意分钟数直接输入（1-600），输入后自动记住为默认 */
    const crow = contentEl.createDiv(); crow.style.cssText = 'display:flex;gap:6px;align-items:center;margin:4px 0 6px';
    crow.createSpan({ text: '自定义分钟：' }).style.cssText = 'font-size:11px';
    const minInput = crow.createEl('input'); minInput.type = 'number'; minInput.min = '1'; minInput.max = '600';
    minInput.value = String(this.mode === 'pomodoro' ? (p.settings.pomodoroWork || 25) : (p.settings.focusMinutes || 25));
    minInput.style.cssText = 'width:64px;font-size:12px;padding:3px 6px';
    const applyBtn = crow.createEl('button', { text: '应用' }); applyBtn.className = 'nws-fbtn';
    const applyMinutes = () => {
      const n = clamp(parseInt(minInput.value, 10) || 0, 1, 600);
      if (!n) { new Notice('请输入 1-600 的分钟数'); return; }
      minInput.value = String(n);
      chosenSec = n * 60;
      if (activeBtn) activeBtn.removeClass('on');
      if (this.mode === 'pomodoro') { p.settings.pomodoroWork = n; } else { p.settings.focusMinutes = n; }
      p.saveNow();
      new Notice('已设为 ' + n + ' 分钟');
    };
    applyBtn.addEventListener('click', applyMinutes);
    minInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyMinutes(); });

    if (this.mode === 'focus') {
      /* 全屏禅模式开关 */
      const frow = contentEl.createDiv(); frow.style.cssText = 'margin-top:10px;display:flex;align-items:center;gap:8px';
      const fcb = frow.createEl('input'); fcb.type = 'checkbox'; fcb.checked = p.settings.focusFullscreen !== false;
      frow.createSpan({ text: '进入专注自动全屏（隐藏两侧边栏，退出时还原）' }).style.cssText = 'font-size:11px';
      fcb.addEventListener('change', async () => { p.settings.focusFullscreen = fcb.checked; await p.saveNow(); });
      /* 壁纸选择（含新增低刺激深色系） */
      contentEl.createEl('div', { text: '专注壁纸' }).style.cssText = 'font-size:11px;font-weight:600;margin:12px 0 5px';
      const wrow = contentEl.createDiv(); wrow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      let aw = null;
      FOCUS_WALLPAPERS.forEach((w) => {
        const b = wrow.createEl('button', { text: w.name }); b.className = 'nws-fbtn' + (w.id === p.settings.focusWallpaper ? ' on' : '');
        if (w.id === p.settings.focusWallpaper) aw = b;
        b.addEventListener('click', () => { if (aw) aw.removeClass('on'); b.addClass('on'); aw = b; p.settings.focusWallpaper = w.id; p.saveNow(); });
      });
      /* 打字音效：敲一下键响一声（与背景音无关） */
      contentEl.createEl('div', { text: '打字音效（每次敲键响一声）' }).style.cssText = 'font-size:11px;font-weight:600;margin:12px 0 5px';
      const trow2 = contentEl.createDiv(); trow2.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      let at = null;
      TYPING_SOUNDS.forEach((s) => {
        const b = trow2.createEl('button', { text: s.name }); b.className = 'nws-fbtn' + ((s.id === p.settings.typeSound) || (s.id === 'key' && !p.settings.typeSound) ? ' on' : '');
        if (b.hasClass('on')) at = b;
        b.addEventListener('click', () => { if (at) at.removeClass('on'); b.addClass('on'); at = b; p.settings.typeSound = s.id; p.saveNow(); if (s.id !== 'off') p.playTypeSound(true); });
      });
      /* 背景音：持续环境声，可选关闭 */
      contentEl.createEl('div', { text: '背景音（持续环境声，可关）' }).style.cssText = 'font-size:11px;font-weight:600;margin:12px 0 5px';
      const srow = contentEl.createDiv(); srow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
      let as = null;
      FOCUS_SOUNDS.forEach((s) => {
        const b = srow.createEl('button', { text: s.name }); b.className = 'nws-fbtn' + (s.id === p.settings.focusSound ? ' on' : '');
        if (s.id === p.settings.focusSound) as = b;
        b.addEventListener('click', () => {
          if (as) as.removeClass('on'); b.addClass('on'); as = b;
          p.settings.focusSound = s.id; p.saveNow();
          p.startSound(s.id); // 试听
        });
      });
      /* 打字模式开关 */
      const trow = contentEl.createDiv(); trow.style.cssText = 'margin-top:12px;display:flex;align-items:center;gap:8px';
      const tcb = trow.createEl('input'); tcb.type = 'checkbox'; tcb.checked = !!p.settings.typingMode;
      trow.createSpan({ text: '打字模式（当前段高亮，前后段逐渐变淡）' }).style.cssText = 'font-size:11px';
      tcb.addEventListener('change', async () => { p.settings.typingMode = tcb.checked; p.entityVersion++; await p.saveNow(); });
    }

    /* 实时显示 */
    const live = contentEl.createDiv('nws-focus-live');
    live.style.cssText = 'margin-top:14px;padding:12px;border:1px solid var(--nws-line);border-radius:8px;text-align:center;background:var(--background-secondary)';
    const renderLive = () => {
      const s = p.focusState;
      if (!s.active) { live.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">尚未开始 · 实时速度与剩余字数将在此显示</div>'; return; }
      const left = Math.max(0, (s.left || 0));
      const f = p.app.workspace.getActiveFile();
      const target = f ? p.targetOf(f.path) : 0;
      const words = f ? (p.wordCache[f.path] || 0) : 0;
      const remainWord = target > 0 ? Math.max(0, target - words) : 0;
      live.innerHTML = '<div style="font-size:26px;font-weight:600;font-variant-numeric:tabular-nums">' + fmtDur(left) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' +
        (s.paused ? '⏸ 已暂停' : '● 进行中') + ' · ⚡ ' + p.pacePerMinute() + ' 字/分' +
        (target > 0 ? ' · 本章还差 ' + fmt(remainWord) + ' 字' : '') + '</div>';
    };
    renderLive();
    this._liveTimer = setInterval(() => renderLive(), 1000);

    /* 按钮 */
    const brow = contentEl.createDiv(); brow.style.cssText = 'margin-top:14px;text-align:right;display:flex;gap:8px;justify-content:flex-end';
    const startBtn = brow.createEl('button', { text: '▶ 开始' }); startBtn.className = 'mod-cta';
    startBtn.addEventListener('click', () => {
      if (p.focusState.active) { new Notice('已有计时进行中，请先结束'); return; }
      p.startFocusSession(this.mode === 'pomodoro' ? 'work' : 'focus', chosenSec || 1500);
      renderLive();
    });
    const pauseBtn = brow.createEl('button', { text: '⏸ 暂停/继续' });
    pauseBtn.addEventListener('click', () => { if (p.focusState.active) { p.pauseFocusSession(); renderLive(); } });
    const stopBtn = brow.createEl('button', { text: '■ 结束' });
    stopBtn.addEventListener('click', () => { if (p.focusState.active) { p.stopFocusSession(); renderLive(); } });
  }
  onClose() {
    if (this._liveTimer) clearInterval(this._liveTimer);
    /* 未开启专注时，关闭弹窗要停掉试听音效与壁纸 */
    if (!this.p.focusState.active) { this.p.stopSound(); this.p.clearFocusWallpaper(); }
    this.contentEl.empty();
  }
}

/* ================= 设置页 ================= */
class NSSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.p = plugin; }
  display() {
    const { containerEl } = this;
    const p = this.p;
    containerEl.empty();
    containerEl.createEl('h2', { text: '小说写作台 · 设置' });

    new Setting(containerEl).setName('正文目录').setDesc('只有该目录下的 Markdown 才计为章节与统计范围')
      .addText((t) => t.setValue(p.settings.folderBody).onChange(async (v) => { p.settings.folderBody = v; await p.saveNow(); await p.rescan(true); }));
    new Setting(containerEl).setName('大纲目录').addText((t) => t.setValue(p.settings.folderOutline).onChange(async (v) => { p.settings.folderOutline = v; await p.saveNow(); }));
    new Setting(containerEl).setName('设定目录').addText((t) => t.setValue(p.settings.folderSetting).onChange(async (v) => { p.settings.folderSetting = v; await p.saveNow(); }));
    new Setting(containerEl).setName('灵感目录').setDesc('每条灵感独立存为该目录下的一个 md 笔记（原统一的 灵感.md 已弃用）')
      .addText((t) => t.setValue(p.settings.folderInspiration || '灵感').onChange(async (v) => { p.settings.folderInspiration = v || '灵感'; await p.saveNow(); }));

    containerEl.createEl('h3', { text: '正文辅助' });
    new Setting(containerEl).setName('对话高亮').setDesc('双引号 “…” 内的文字高亮')
      .addToggle((t) => t.setValue(p.settings.dialogueHighlight).onChange(async (v) => { p.settings.dialogueHighlight = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('英文双引号').addToggle((t) => t.setValue(p.settings.dialogueEnglish).onChange(async (v) => { p.settings.dialogueEnglish = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('设定提及着色').setDesc('正文出现设定名称/别名时：有颜色→该色加粗倾斜；无颜色→加粗倾斜+下划线；鼠标悬停预览内容，点击直接打开设定笔记')
      .addToggle((t) => t.setValue(p.settings.entityHighlight).onChange(async (v) => { p.settings.entityHighlight = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('同名文本匹配').addToggle((t) => t.setValue(p.settings.entityNameMatch).onChange(async (v) => { p.settings.entityNameMatch = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('别名匹配').addToggle((t) => t.setValue(p.settings.entityAliasMatch).onChange(async (v) => { p.settings.entityAliasMatch = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('名称前显示类型图标').addToggle((t) => t.setValue(p.settings.entityEmoji).onChange(async (v) => { p.settings.entityEmoji = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('日更目标（字）').setDesc('数据中心「日更目标完成率」按这个标准计算，默认 1000 字')
      .addText((t) => t.setValue(String(p.settings.dailyGoal || 1000)).onChange(async (v) => { const n = parseInt(v, 10); p.settings.dailyGoal = (n >= 100 && n <= 100000) ? n : 1000; await p.saveNow(); }));
    new Setting(containerEl).setName('单击设定词打开设定笔记').setDesc('开启后，正文里单击高亮的设定名/别名即跳转到该设定的 md 笔记（拖动选字不会误触）；关闭则只能用 Ctrl/Cmd+点击')
      .addToggle((t) => t.setValue(p.settings.entityClickJump !== false).onChange(async (v) => { p.settings.entityClickJump = v; await p.saveNow(); }));
    new Setting(containerEl).setName('悬浮卡延迟(ms)').addText((t) => t.setValue(String(p.settings.hoverDelay)).onChange(async (v) => { p.settings.hoverDelay = Number(v) || 0; await p.saveNow(); }));
    new Setting(containerEl).setName('【】自动收集').setDesc('默认关闭。推荐用「选中文字→右键→保存为灵感」收集；开启后打完 】 会把内容存为一条灵感笔记并从正文移除')
      .addToggle((t) => t.setValue(p.settings.autoCollectBracket).onChange(async (v) => { p.settings.autoCollectBracket = v; await p.saveNow(); }));
    new Setting(containerEl).setName('【】chip 提示').addToggle((t) => t.setValue(p.settings.noteChip).onChange(async (v) => { p.settings.noteChip = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('批注底纹显示').setDesc('选中文字右键「添加批注」后，原文该段显示浅黄底纹；悬浮可看批注内容（原文不改一个字）')
      .addToggle((t) => t.setValue(p.settings.annotShow !== false).onChange(async (v) => { p.settings.annotShow = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('码字里程碑').setDesc('每满 N 字，在该行右侧标注 🎯 300 / 600 / 900…')
      .addToggle((t) => t.setValue(p.settings.milestoneMark !== false).onChange(async (v) => { p.settings.milestoneMark = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('里程碑步长（字）').setDesc('默认 300；每达到 300 的整数倍，在该行右侧标注')
      .addText((t) => t.setValue(String(p.settings.milestoneStep || 300)).onChange(async (v) => { const n = parseInt(v, 10); p.settings.milestoneStep = (n >= 100) ? n : 300; p.entityVersion++; await p.saveNow(); }));

    /* ===== 设定笔记出场章节统计（保留） ===== */
    containerEl.createEl('h3', { text: '设定笔记统计' });
    new Setting(containerEl).setName('设定笔记自动统计出场章节').setDesc('每个设定的 md 笔记末尾自动生成「📍 出场章节」表格：出场次数 + 章节链接（点击跳转），随正文修改自动刷新')
      .addToggle((t) => t.setValue(p.settings.appearSync !== false).onChange(async (v) => { p.settings.appearSync = v; await p.saveNow(); if (v) await p.syncEntityAppearances(); }));
    new Setting(containerEl).setName('立即刷新出场章节统计').setDesc('手动触发一次全部设定笔记的出场章节表格重建')
      .addButton((b) => b.setButtonText('刷新').onClick(async () => { await p.syncEntityAppearances(); new Notice('出场章节统计已更新'); }));

    /* ===== v2.4 三轴独立开关 ===== */
    containerEl.createEl('h3', { text: '时间 / 空间 / 情绪线' });
    const axesDesc = containerEl.createDiv();
    axesDesc.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:10px';
    axesDesc.textContent = '三类线各自可开可关、任意组合：可只显示时间线、只显示空间线、只显示情绪线，或全部对照。每条线都能重命名、建多条、绑定人物/情节/设定。';
    TRACK_AXES.forEach((a) => {
      new Setting(containerEl).setName(a.emoji + ' ' + a.name).setDesc('在双线视图中显示' + a.name + '（可有多条）')
        .addToggle((t) => t.setValue(p.axisOn(a.key)).onChange(async (v) => {
          const cur = p.visibleAxes().slice();
          const i = cur.indexOf(a.key);
          if (v && i < 0) cur.push(a.key);
          if (!v && i >= 0 && cur.length > 1) cur.splice(i, 1);
          p.settings.visibleAxes = TRACK_AXES.map((x) => x.key).filter((k) => cur.indexOf(k) >= 0);
          await p.saveNow(); p.refreshViews();
        }));
    });

    /* ===== v2.1 码字 / 目标 / 专注 ===== */
    containerEl.createEl('h3', { text: '码字目标与进度条' });
    new Setting(containerEl).setName('每章默认目标字数').setDesc('新建章节默认目标；单章可在目录点字数单独设定（覆盖此值）')
      .addText((t) => t.setValue(String(p.settings.chapterTarget || DEFAULT_CHAPTER_TARGET)).onChange(async (v) => {
        p.settings.chapterTarget = parseInt(v, 10) || DEFAULT_CHAPTER_TARGET; await p.saveNow(); p.refreshProgressBar();
      }));
    new Setting(containerEl).setName('顶部悬浮渐变进度条').setDesc('打开正文时顶部显示渐变进度条：当前字数/目标、百分比、还差多少、实时码字速度')
      .addToggle((t) => t.setValue(p.settings.showProgressBar !== false).onChange(async (v) => { p.settings.showProgressBar = v; await p.saveNow(); p.refreshProgressBar(); }));
    new Setting(containerEl).setName('码字速度统计窗口(秒)').setDesc('实时速度 = 最近 N 秒码字数换算为字/分钟')
      .addText((t) => t.setValue(String(p.settings.paceWindow || 60)).onChange(async (v) => { p.settings.paceWindow = parseInt(v, 10) || 60; await p.saveNow(); }));

    containerEl.createEl('h3', { text: '番茄钟 / 专注模式' });
    const minClamp = (v, d) => { const n = parseInt(v, 10); return (n >= 1 && n <= 600) ? n : d; };
    new Setting(containerEl).setName('番茄钟专注(分)').setDesc('任意 1-600 分钟，例如输 5')
      .addText((t) => t.setValue(String(p.settings.pomodoroWork)).onChange(async (v) => { p.settings.pomodoroWork = minClamp(v, 25); await p.saveNow(); }));
    new Setting(containerEl).setName('番茄钟短休(分)').addText((t) => t.setValue(String(p.settings.pomodoroBreak)).onChange(async (v) => { p.settings.pomodoroBreak = minClamp(v, 5); await p.saveNow(); }));
    new Setting(containerEl).setName('番茄钟长休(分)').addText((t) => t.setValue(String(p.settings.pomodoroLongBreak)).onChange(async (v) => { p.settings.pomodoroLongBreak = minClamp(v, 15); await p.saveNow(); }));
    new Setting(containerEl).setName('几轮后长休').addText((t) => t.setValue(String(p.settings.pomodoroRounds)).onChange(async (v) => { p.settings.pomodoroRounds = clamp(parseInt(v, 10) || 4, 1, 10); await p.saveNow(); }));
    new Setting(containerEl).setName('自定义专注(分)').addText((t) => t.setValue(String(p.settings.focusMinutes)).onChange(async (v) => { p.settings.focusMinutes = minClamp(v, 25); await p.saveNow(); }));
    const wpNote = containerEl.createDiv();
    wpNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin:6px 0';
    wpNote.textContent = '可选壁纸：' + FOCUS_WALLPAPERS.map((w) => w.name).join(' / ') + '。深色系已提亮并加色彩层次，正文下方有半透明承载卡保证文字对比。';
    new Setting(containerEl).setName('专注壁纸')
      .addDropdown((d) => d.addOptions(FOCUS_WALLPAPERS.reduce((o, w) => { o[w.id] = w.name; return o; }, {})).setValue(p.settings.focusWallpaper).onChange(async (v) => { p.settings.focusWallpaper = v; await p.saveNow(); p.applyFocusWallpaper(v); }));
    new Setting(containerEl).setName('进入专注自动全屏').setDesc('开启后点「开始专注」自动隐藏两侧边栏并系统全屏；结束专注自动还原')
      .addToggle((t) => t.setValue(p.settings.focusFullscreen !== false).onChange(async (v) => { p.settings.focusFullscreen = v; await p.saveNow(); }));
    new Setting(containerEl).setName('背景变暗程度').setDesc('专注时把界面压暗的程度，0=不变暗、90%=几乎全黑；越暗越容易专注')
      .addSlider((s) => s.setLimits(0, 90, 5).setValue(Math.round((Number(p.settings.focusDim) || 0) * 100)).onChange(async (v) => { p.settings.focusDim = v / 100; await p.saveNow(); if (p.focusState.active) p.applyFocusWallpaper(p.settings.focusWallpaper); }));
    new Setting(containerEl).setName('打字音效（敲键发声）').setDesc('每次敲键盘响一声，与背景音独立；只在真实输入时发声')
      .addDropdown((d) => d.addOptions(TYPING_SOUNDS.reduce((o, s) => { o[s.id] = s.name; return o; }, {})).setValue(p.settings.typeSound || 'off').onChange(async (v) => { p.settings.typeSound = v; await p.saveNow(); if (v !== 'off') p.playTypeSound(true); }));
    new Setting(containerEl).setName('打字音效音量(0-1)').addText((t) => t.setValue(String(p.settings.typeSoundVolume != null ? p.settings.typeSoundVolume : 0.35)).onChange(async (v) => { p.settings.typeSoundVolume = clamp(Number(v) || 0, 0, 1); await p.saveNow(); }));
    new Setting(containerEl).setName('背景音（持续环境声）').setDesc('雨滴/白噪音等循环环境声，专注或平时都可开；选「关闭」即静音')
      .addDropdown((d) => d.addOptions(FOCUS_SOUNDS.reduce((o, s) => { o[s.id] = s.name; return o; }, {})).setValue(p.settings.focusSound).onChange(async (v) => { p.settings.focusSound = v; await p.saveNow(); }));
    new Setting(containerEl).setName('背景音音量(0-1)').addText((t) => t.setValue(String(p.settings.focusSoundVolume)).onChange(async (v) => { p.settings.focusSoundVolume = clamp(Number(v) || 0, 0, 1); await p.saveNow(); }));
    new Setting(containerEl).setName('打字模式（当前段高亮·前后渐淡）').setDesc('光标所在段落高亮，前后段落逐级减淡，集中注意力')
      .addToggle((t) => t.setValue(!!p.settings.typingMode).onChange(async (v) => { p.settings.typingMode = v; p.entityVersion++; await p.saveNow(); }));
    new Setting(containerEl).setName('渐淡段数').addText((t) => t.setValue(String(p.settings.typingRadius || 2)).onChange(async (v) => { p.settings.typingRadius = Math.max(1, parseInt(v, 10) || 2); p.entityVersion++; await p.saveNow(); }));

    new Setting(containerEl).setName('设定文件存放方式').setDesc('设定按大类分门别类存放为 设定/<大类>/<名称>.md，6 大类各有独立子文件夹；大类与类型同时写在文件 frontmatter（nws_group / nws_type），正文按模板补充。已有的扁平文件会在加载时自动归入对应子文件夹。');

    containerEl.createEl('h3', { text: '设定库分类（6 大类 + 独立）' });
    const groupNote = containerEl.createDiv();
    groupNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.7;margin-bottom:8px';
    groupNote.innerHTML = '每条设定先归入一个大类，再选大类下的小库；每个库都有专属模板。无法归类者归入「独立」。'
      + ENTITY_GROUPS.map((g) => '<br>· <b>' + g.emoji + ' ' + g.name + '</b>：' + g.libs.join(' / ')).join('');

    containerEl.createEl('h3', { text: '小库默认颜色（正文彩色加粗用）' });
    const typeNote = containerEl.createDiv();
    typeNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.6;margin-bottom:6px';
    typeNote.textContent = '小库默认色；在「新建设定 / 更换高亮颜色」里也可对单条设定选「无颜色（加粗+下划线）」。';
    p.data.entityTypes.forEach((t) => {
      const row = new Setting(containerEl).setName(typeEmoji(t) + ' ' + t);
      PALETTE_NAMES.forEach((cn, ci) => {
        row.addButton((b) => {
          b.setTooltip(t + ' → ' + cn + '色');
          b.setButtonText(p.typeColor(t) === ci ? '●' : '○');
          b.onClick(async () => { p.data.typeColors[t] = ci; p.entityVersion++; await p.saveNow(); this.display(); });
        });
      });
    });
    new Setting(containerEl).setName('新增设定类型').addText((t) => t.setPlaceholder('如：情绪')
      .addButton((b) => b.setButtonText('添加').onClick(async () => {
        const v = t.getValue().trim();
        if (v && p.data.entityTypes.indexOf(v) < 0) { p.data.entityTypes.push(v); p.data.typeColors[v] = 2; await p.saveNow(); this.display(); }
      })));

    containerEl.createEl('h3', { text: '大纲类型与模板' });
    const otNote = containerEl.createDiv();
    otNote.style.cssText = 'font-size:11px;color:var(--text-muted);line-height:1.7;margin-bottom:8px';
    otNote.innerHTML = '每种大纲类型对应一套模板骨架，新建时写入同名 md 笔记，按模板补充内容：'
      + Object.keys(OUTLINE_TEMPLATES).map((k) => '<br>· <b>' + outlineEmoji(k) + ' ' + k + '</b>：' + OUTLINE_TEMPLATES[k].fields.join(' / ')).join('');
    new Setting(containerEl).setName('新增大纲类型').setDesc('新类型沿用「自定义」模板骨架（说明/要点/关联对象/备注）')
      .addText((t) => t.setPlaceholder('如：冲突')
      .addButton((b) => b.setButtonText('添加').onClick(async () => {
        const v = t.getValue().trim();
        if (v && p.data.outlineTypes.indexOf(v) < 0) { p.data.outlineTypes.push(v); await p.saveNow(); this.display(); }
      })));
  }
}

module.exports = NovelWriterStudio;
