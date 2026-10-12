import './style.css';
import JSZip from 'jszip';
import { createIcons, AudioLines, Bell, ClipboardPaste, Copy, Download, Eraser, FolderInput, FolderOpen, Image, Keyboard, LocateFixed, LogOut, MousePointer2, Music2, Orbit, Pause, Pencil, Play, Plus, Redo2, Save, ScanLine, Search, Settings2, SkipBack, SlidersHorizontal, Sparkles, Trash2, Undo2, Volume2, X } from 'lucide';
const icons = { AudioLines, Bell, ClipboardPaste, Copy, Download, Eraser, FolderInput, FolderOpen, Image, Keyboard, LocateFixed, LogOut, MousePointer2, Music2, Orbit, Pause, Pencil, Play, Plus, Redo2, Save, ScanLine, Search, Settings2, SkipBack, SlidersHorizontal, Sparkles, Trash2, Undo2, Volume2, X };
import { History, beatToSeconds, secondsToBeat, snap, newItem, newProject, items, ensureItems, kinds, labels, decodeText, readYaml, writeYaml, sortedProject, validateChart, updateMetadata, type Project, type Song, type Kind, type Item } from './model';
import { drawTimeline, timelineHeight, timelineHit, timelineLane, timelineMargin, bands, eventTypes, type Selection, type ViewState } from './render';
import { findOverlaps, type Overlap } from './diagnostics';
import { mirrorArt } from './mirror-art';
import { tutorialHtml, tutorialSteps } from './tutorial';
import { handPositions, isHandPosition, footTrack, defaultDepthScale, defaultPreviewRange } from './layout';
import { applyGrouping, groupingOptions, repairGroups, type GroupAction } from './groups';
import { defaultLightTracks, lightTracks, lightValues, validLightMapping } from './lighting-data';
import { SpatialPreview } from './preview3d';
import { mirroredItem, type MirrorMode } from './transforms';
import { fillEndpoints, fillPlans, nearestFillPlan, buildFill, maxFillNotes, type FillDirection, type FillPlan } from './fill';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const icon = (name: string) => `<i data-lucide="${name}"></i>`;
const escape = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
let viewDefaults = { depthScale: defaultDepthScale, previewRange: defaultPreviewRange };
try {
  const saved = JSON.parse(localStorage.getItem('ringmapper-view-defaults') || 'null');
  if (typeof saved?.depthScale === 'number' && Number.isFinite(saved.depthScale) && saved.depthScale >= .25 && saved.depthScale <= 10) viewDefaults.depthScale = saved.depthScale;
  if (typeof saved?.previewRange === 'number' && Number.isFinite(saved.previewRange) && saved.previewRange >= 1 && saved.previewRange <= 64) viewDefaults.previewRange = saved.previewRange;
} catch {}
let noteOpacity = { hand: 1, foot: 1, linked: true };
try {
  const saved = JSON.parse(localStorage.getItem('ringmapper-note-opacity') || 'null');
  for (const key of ['hand', 'foot'] as const) if (typeof saved?.[key] === 'number' && Number.isFinite(saved[key]) && saved[key] >= 0 && saved[key] <= 1) noteOpacity[key] = saved[key];
  if (typeof saved?.linked === 'boolean') noteOpacity.linked = saved.linked;
} catch {}
let project = newProject(), songs: Song[] = [], activeSong: Song | undefined;
let selected: Selection[] = [], clipboard: { kind: Kind; item: Item }[] = [];
type FillSession = { before: Project; history: ReturnType<History['checkpoint']>; selection: Selection[]; chart: Project['chart']; endpoints: [Item, Item]; generated: Item[]; plans: Record<FillDirection, FillPlan[]>; direction: FillDirection; index: number; skipped: number };
let fillSession: FillSession | undefined, applyingFill = false;
let dirty = false, beat = 0, start = 0, scale = 48 * viewDefaults.depthScale, division = 4, active: Kind = 'notes', noteType = 0;
const ringRotation = 0, ringReverse = false;
let mode: 'notes' | 'obstacles' | 'events' = 'notes';
let eventValue = 1, eventType = 1;
let lightMapping = defaultLightTracks.map(t => ({ ...t }));
try { const types = JSON.parse(localStorage.getItem('ringmapper-light-mapping') || 'null'); if (Array.isArray(types) && validLightMapping(types)) lightMapping = lightMapping.map((t,i) => ({ ...t, type: types[i] })); } catch {}
let wheelReverse = localStorage.getItem('ringmapper-wheel-reverse') === 'true';
let overlaps: Overlap[] = [], diagnosticsDirty = true, diagnosticsChart: Project['chart'] | undefined;
let playing = false, waveform: number[] = [], waveToken = 0, audioUrl = '';
let virtualStart = 0, virtualBeat = 0, lastClickBeat = -1, metronome = false;
let saving = false, loadingProject = 0, shiftHeld = false;
let localAssets = new Map<string, Blob>(), history = new History(), savedSignature = '', draftTimer: ReturnType<typeof setTimeout>;
const audio = new Audio(); audio.preload = 'auto';
const app = $('app');
app.innerHTML = `
<div class="workspace"><aside class="library"><div class="brand"><span class="brand-mark">◎</span><div>RingMapper<small>本地创作 · 谱面工作台</small></div></div><div class="section-label">WORKSPACE <button id="workspace-folder" title="在文件管理器中打开当前歌曲目录；未保存时打开 Map" aria-label="打开本地谱面路径">${icon('folder-open')}谱面目录</button></div><div class="library-actions"><button id="new-project">${icon('plus')}新建</button><button id="import">${icon('folder-input')}导入</button></div><div class="search-wrap">${icon('search')}<input id="search" placeholder="搜索歌曲 / 艺术家" aria-label="搜索歌曲"></div><div class="library-caption"><span>全部歌曲</span><span id="song-count">加载中</span></div><div id="song-list" class="song-list"></div><div class="library-bottom"><span class="status-dot"></span>本地工作区<span>Map /</span></div></aside>
<main id="scene-workspace"><section class="preview-panel" aria-label="3D 工作区">
<div class="preview-viewport"><canvas id="preview" tabindex="0" aria-label="3D 圆环手部与下方脚部音符预览"></canvas></div>
<button id="overlap-status" class="overlap-status" hidden aria-live="polite"></button><div class="scene-top"><div class="scene-song"><div class="song-details"><section class="songbar"><div class="song-cover" id="current-cover">◎</div><div class="song-info"><h1 id="song-name">未命名歌曲</h1><p id="artist-name">开始创作你的节奏</p></div><div class="song-meta"><span>BPM<strong id="bpm-display">120</strong></span><span>音符<strong id="note-count">0</strong></span></div><button id="settings" title="歌曲设置">${icon('settings-2')}</button></section>
<div class="scene-status"><div class="project-title"><span class="status-dot"></span><span id="project-title">新建谱面</span><span class="badge" id="save-state">未保存</span></div></div></div><section class="difficulty-bar" aria-label="当前歌曲难度"><div class="difficulty-heading"><span>模式 · 难度</span></div><div id="difficulties"></div><span id="source-path">Ring/NormalRing.yaml</span></section></div><div class="header-actions"><div id="account" class="account" hidden><img id="account-avatar" alt="" hidden><span id="account-name"></span><button id="logout" title="退出 PICO 登录">${icon('log-out')}<span>退出</span></button></div><button id="tutorial" title="新手教程" aria-label="新手教程"><b class="tutorial-question">?</b><span>新手教程</span></button><button id="help">${icon('keyboard')}<span>快捷键</span></button><button id="export">${icon('download')}<span>导出 ZIP</span></button><button id="save" class="primary">${icon('save')}<span>保存谱面</span></button></div></div>
<div class="scene-camera"><span>${icon('orbit')}3D 空间预览</span><div><button id="camera-reset" title="重置相机">${icon('locate-fixed')}</button><button id="camera-near" title="拉近相机" aria-label="拉近相机">＋</button><button id="camera-far" title="拉远相机" aria-label="拉远相机">−</button><button id="view-settings" title="视图设置">${icon('sliders-horizontal')}<span>设置</span></button></div><div class="scene-snap"><label for="division">SNAP · 吸附</label><select id="division" aria-label="吸附预设">${[1,2,3,4,6,8,16,24,32].map(n => `<option value="${n}" ${n === 4 ? 'selected' : ''}>${n === 1 ? '1 beat' : `1/${n}`}</option>`).join('')}<option value="custom">自定义</option></select><label class="snap-custom">1 / <input id="snap-denominator" aria-label="自定义吸附分母" title="输入分母，例如 5 表示 1/5 拍" type="number" step="any" min="0.000001" max="1000000" value="4">拍</label></div><label class="scene-depth">纵深拉伸<input id="depth-zoom" aria-label="3D 纵深拉伸" type="range" min="0.25" max="10" step="any" value="${viewDefaults.depthScale}"><output id="depth-zoom-value">${viewDefaults.depthScale.toFixed(2)}×</output></label><label class="scene-depth">预览范围<input id="preview-range" aria-label="预览范围（拍）" type="range" min="1" max="64" step="any" value="${viewDefaults.previewRange}"><output id="preview-range-value">${viewDefaults.previewRange.toFixed(2)} 拍</output></label></div>
<section class="inspector-panel" id="tools-panel" aria-label="编辑工具子窗口"><div class="panel-heading" id="tools-handle" title="拖动移动工具窗口，双击复位"><span>${icon('mouse-pointer-2')}编辑工具</span><div><span class="subtle" id="selection-count">未选中</span><button id="toggle-tools" aria-label="收起编辑工具" aria-controls="tools-body" aria-expanded="true">−</button></div></div><div id="tools-body"><div class="kind-tabs"><button data-mode="notes" class="active" title="音符（1）">音符</button><button data-mode="obstacles" title="障碍物（2）">障碍物</button><button data-mode="events" title="灯光（3）">灯光事件</button></div><div id="inspector"></div><div class="mirror-controls"><button id="mirror-left-right" title="左右镜像，保留颜色（Ctrl+F）">${mirrorArt('left-right')}<span>左右镜像</span></button><button id="mirror-up-down" title="沿水平轴翻转上下两半">${mirrorArt('up-down')}<span>上下镜像</span></button><button id="mirror-diagonal" title="上下、左右同时翻转，保留颜色">${mirrorArt('diagonal')}<span>对角镜像</span></button></div><div class="edit-actions"><button id="undo" title="撤销 Ctrl+Z">${icon('undo-2')}</button><button id="redo" title="重做 Ctrl+Y">${icon('redo-2')}</button><button id="copy" title="复制 Ctrl+C">${icon('copy')}</button><button id="paste" title="粘贴 Ctrl+V">${icon('clipboard-paste')}</button><button id="delete" title="删除选中项（Del）" aria-label="删除选中项（Del）">${icon('trash-2')}<span>Del</span></button></div><div class="inspector-bottom"><button id="range-select">范围选取</button><button id="group">打组</button><button id="fill" hidden title="沿圆环填充两个手部音符之间的空位">填充</button><button id="join-group" hidden>加入组</button><button id="check">${icon('scan-line')}检查谱面</button></div></div></section>
<section id="fill-panel" class="fill-panel" aria-label="圆环填充" hidden></section>
<section class="timeline-panel is-collapsed" id="timeline-panel" aria-label="时间轴子窗口" inert><div class="timeline-toolbar"><div class="timeline-title">${icon('audio-lines')}时间轴 <span class="badge" id="visible-range">BEATS</span></div><div class="timeline-options"><button id="hide-timeline" title="向下收起时间轴">向下收起 ↓</button><button id="follow" title="定位到播放头">${icon('locate-fixed')}</button></div></div><div class="timeline-wrap"><canvas id="timeline" aria-label="谱面时间轴"></canvas></div><input id="scroll" class="timeline-scroll" type="range" min="0" max="256" step="0.25" value="0" aria-label="滚动时间轴"></section>

<button class="timeline-toggle" id="toggle-timeline" aria-controls="timeline-panel" aria-expanded="false" title="展开传统时间轴">${icon('audio-lines')}<span>传统时间轴 ↑</span></button><footer class="transport"><div class="transport-buttons"><button id="home" title="回到开始">${icon('skip-back')}</button><button id="play" class="play-button" title="播放 / 暂停 Space">${icon('play')}</button></div><div class="transport-time"><strong id="time-display">00:00.000</strong><span>BEAT <input id="beat-input" type="number" min="0" step="0.25" value="0" aria-label="当前节拍"></span></div><div class="seek-wrap"><div id="seek-bookmarks" class="seek-bookmarks" aria-label="歌曲书签"></div><input id="seek" type="range" min="0" max="256" step="0.01" value="0" aria-label="播放进度"></div><div class="speed-control"><label class="speed-label" title="歌曲播放速度">倍速<input id="speed" aria-label="播放速度" type="range" min="0.1" max="2" step="any" value="1"><output id="speed-value">1.00×</output></label><button id="speed-reset" hidden title="恢复默认播放速度" aria-label="恢复默认播放速度">↺ 1×</button></div><div class="metronome-control"><button id="metronome" title="节拍器开关" aria-label="节拍器开关" aria-pressed="false">${icon('bell')}</button><input id="metronome-volume" aria-label="节拍器音量" title="节拍器音量" type="range" min="0" max="1" step="any" value="0.5"></div><label class="volume-label">${icon('volume-2')}<input id="volume" type="range" min="0" max="1" step="0.05" value="0.7" aria-label="音量"></label></footer>
<div id="toast" role="status"></div><dialog id="modal"><div id="modal-content"></div></dialog><input id="import-input" type="file" accept=".zip,.yaml,.yml" multiple hidden><input id="audio-input" type="file" accept="audio/ogg,audio/mpeg,audio/wav" hidden><input id="cover-input" type="file" accept="image/png,image/jpeg,image/webp" hidden></section></main></div><div id="login-gate" class="login-gate" hidden><section class="login-card"><span class="brand-mark">◎</span><p class="login-kicker">RINGMAPPER</p><h1>使用 PICO 账号登录</h1><p>与闪韵谱库使用同一套 PICO 账号关联。登录后即可进入本地谱面编辑，并带着这个账号对接谱库。</p><a id="pico-login" class="primary" href="/api/auth/pico/login">使用 PICO 登录</a><p id="login-error" class="login-error" hidden></p></section></div>`;
function iconsRefresh() { createIcons({ icons }); }
function notify(message: string) { $('toast').textContent = message; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 4500); }
async function api<T>(url: string, options?: RequestInit): Promise<T> { const r = await fetch(url, options); const data = await r.json(); if (!r.ok) throw new Error(data.error || r.statusText); return data; }
function asset(song: string, file: string) { return `/api/asset?song=${encodeURIComponent(song)}&file=${encodeURIComponent(file)}`; }
function view(): ViewState { return { project, beat, start, scale, division, selected: selected[0], selections: selected, active, mode, overlaps, ringRotation, ringReverse }; }
const preview = $<HTMLCanvasElement>('preview'), timeline = $<HTMLCanvasElement>('timeline');
let spatialPreview: SpatialPreview | undefined;
try { spatialPreview = new SpatialPreview(preview); spatialPreview.lighting.mapping = lightMapping; spatialPreview.depthScale = viewDefaults.depthScale; spatialPreview.lookAhead = viewDefaults.previewRange; spatialPreview.setNoteOpacity(noteOpacity.hand, noteOpacity.foot); }
catch (e) { preview.dataset.renderer = 'unavailable'; const message = document.createElement('div'); message.className = 'preview-error'; message.textContent = '3D 预览无法初始化，请启用浏览器硬件加速或使用支持 WebGL 2 的浏览器。时间轴仍可编辑。'; preview.parentElement!.append(message); console.warn('3D preview unavailable:', e); }
import.meta.hot?.dispose(() => spatialPreview?.dispose());
function draw() { refreshDiagnostics(); spatialPreview?.update(view()); drawTimeline(timeline, view(), waveform); if (selectionBox) { const c = timeline.getContext('2d')!; c.fillStyle = '#a9f2d920'; c.strokeStyle = '#a9f2d9'; const b = selectionBox; c.fillRect(b.x, b.y, b.endX - b.x, b.endY - b.y); c.strokeRect(b.x, b.y, b.endX - b.x, b.endY - b.y); } }
function totalBeats() { return Math.max(16, secondsToBeat(Number(project.info.songDuration) || 120, project.info.beatsPerMinute, project.info.songTimeOffset || 0), ...kinds.map(k => items(project, k).reduce((max, n) => Math.max(max, n.time + Number(n.duration || 0) + 4), 0))); }
function changed() {
  if (!applyingFill) closeFill();
  diagnosticsDirty = true;
  dirty = JSON.stringify(project) !== savedSignature;
  $('save-state').textContent = dirty ? '有未保存修改' : '已保存'; $('save-state').classList.toggle('unsaved', dirty);
  clearTimeout(draftTimer); draftTimer = setTimeout(() => { try { localStorage.setItem('ringmapper-draft', JSON.stringify({ project, date: Date.now() })); } catch { notify('浏览器草稿空间不足，请保存到本地'); } }, 600);
  renderSummary(); draw();
}
function mutate(fn: () => void) { history.push(project); fn(); changed(); renderInspector(); }
function renderSummary() {
  $('song-name').textContent = project.info.songName; $('project-title').textContent = project.info.songName;
  $('artist-name').textContent = `${project.info.songAuthorName || '未知艺术家'}  /  ${project.info.levelAuthorName || '未填写谱师'}`;
  $('bpm-display').textContent = String(project.info.beatsPerMinute); $('note-count').textContent = String(items(project, 'notes').length + items(project, 'ringNotes').length);
  $('source-path').textContent = project.chartPath;
  $<HTMLInputElement>('seek').max = String(totalBeats()); $<HTMLInputElement>('scroll').max = String(totalBeats());
  renderBookmarks();
  const entries = chartEntries(), standard = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
  $('difficulties').innerHTML = ['Ring', 'RingDance', ...new Set(entries.map(c => c.mode).filter(m => m !== 'Ring' && m !== 'RingDance'))].map(mode => {
    const charts = entries.filter(c => c.mode === mode), difficulties = mode === 'Ring' || mode === 'RingDance' ? [...standard, ...new Set(charts.map(c => c.difficulty).filter(d => !standard.includes(d)))] : charts.map(c => c.difficulty);
    return `<div class="difficulty-group" data-difficulty-mode="${escape(mode)}"><span>${escape(mode)}</span><div>${difficulties.map(difficulty => {
      const chart = charts.find(c => c.difficulty === difficulty);
      return chart ? `<button class="difficulty ${chart.path === project.chartPath ? 'active' : ''}" data-chart="${escape(chart.path)}">${escape(difficulty)}</button>` : `<button class="difficulty difficulty-empty" data-create-mode="${escape(mode)}" data-create-difficulty="${escape(difficulty)}" aria-label="创建 ${escape(mode)} ${escape(difficulty)} 难度" title="创建 ${escape(mode)} ${escape(difficulty)}"><span>${escape(difficulty)}</span><b aria-hidden="true">＋</b></button>`;
    }).join('')}</div></div>`;
  }).join('');
}
function renderLibrary() {
  const query = $<HTMLInputElement>('search').value.toLocaleLowerCase();
  const visible = songs.filter(s => `${s.name} ${s.artist} ${s.id}`.toLowerCase().includes(query));
  $('song-count').textContent = `${visible.length} 首`;
  $('song-list').innerHTML = visible.map(s => `<button class="song-card ${s.id === activeSong?.id ? 'active' : ''}" data-song="${escape(s.id)}"><div class="thumb">${s.cover ? `<img draggable="false" loading="lazy" src="${asset(s.id, s.cover)}" alt="">` : '◎'}</div><div class="song-card-info"><strong>${escape(s.name)}</strong><span>${escape(s.artist)}</span><small>${s.bpm} BPM <i>·</i> ${s.charts.length} 张谱面</small></div>${s.id === activeSong?.id ? '<span class="song-active-dot"></span>' : ''}</button>`).join('') || '<div class="empty-library">没有找到歌曲</div>';
}
const fields: Record<Kind, string[]> = { notes: ['time', 'lineIndex', 'lineLayer', 'type', 'cutDirection', 'groupId', 'groupNoteType', 'specialType'], ringNotes: ['time', 'lineIndex', 'type', 'ringNoteType', 'duration'], obstacles: ['time', 'lineIndex', 'type', 'style'], events: ['time', 'type', 'value'] };
const fieldNames: Record<string, string> = { time: '节拍', lineIndex: '位置编号', lineLayer: '层级', type: '类型 / 颜色', cutDirection: '击打方向', ringNoteType: '脚部音符类型', duration: '持续拍数', width: '宽度', value: '事件值', groupId: '分组 ID', groupNoteType: '分组标记', specialType: '特殊类型', style: '样式' };
function renderInspector() {
  $('selection-count').textContent = selected.length ? `已选 ${selected.length} 项` : '未选中';
  document.querySelectorAll('[data-mode]').forEach(e => e.classList.toggle('active', (e as HTMLElement).dataset.mode === mode));
  const groupOptions = groupingOptions(project, selected);
  $('fill').hidden = selected.length !== 2 || !selected.every(s => s.kind === 'notes');
  if (fillSession && (fillSession.chart !== project.chart || selected.length !== 2 || !selected.every(s => s.kind === 'notes' && fillSession!.endpoints.includes(items(project, 'notes')[s.index])))) closeFill();
  $('group').hidden = !groupOptions.canCreate; $('join-group').hidden = !groupOptions.canJoin;
  $<HTMLButtonElement>('delete').disabled = !selected.length;
  for (const axis of ['up-down', 'diagonal']) $<HTMLButtonElement>(`mirror-${axis}`).disabled = mode === 'obstacles' || selected.some(s => s.kind === 'obstacles');
  const first = selected[0], n = first ? items(project, first.kind)[first.index] : undefined;
  const wallOptions = `<p class="field-help wall-placement-help">悬停圆环前方四轨矩形区域预览：横线上方放上半墙，下方放全高墙。每面墙固定 1 轨宽。</p>`;
  if (n && first) {
    $('inspector').innerHTML = `${mode === 'obstacles' ? wallOptions : ''}<div class="inspector-caption">${labels[first.kind]}属性 <span>${first.kind === 'ringNotes' ? `轨道 ${footTrack(n.lineIndex)}` : selected.length > 1 ? '修改应用于同类选中项' : '已选中'}</span></div><div class="field-grid">${fields[first.kind].map(key => `<label>${first.kind === 'obstacles' && key === 'type' ? '墙体类型' : fieldNames[key]}${first.kind === 'events' && key === 'type' ? eventTypeSelect(n.type, 'data-field="type"') : first.kind === 'events' && key === 'value' ? eventValueSelect(n.type, n.value, 'data-field="value"') : first.kind === 'notes' && key === 'type' ? `<select data-field="type" aria-label="音符类型">${[[0,'红色'],[1,'蓝色'],[3,'地雷']].map(([value,label]) => `<option value="${value}" ${n.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select>` : first.kind === 'obstacles' && key === 'type' ? `<select data-field="type" aria-label="墙体类型"><option value="0" ${n.type === 0 ? 'selected' : ''}>全高墙</option><option value="1" ${n.type === 1 ? 'selected' : ''}>上半墙</option></select>` : `<input data-field="${key}" aria-label="${fieldNames[key]}" ${key === 'groupId' ? 'type="text"' : 'type="number" step="any"'} value="${escape(n[key] ?? '')}" placeholder="未设置">`}</label>`).join('')}</div><p class="field-help">${first.kind === 'notes' ? 'Shift 点击多选；双击组内音符选整组。Alt 拖动换位，Delete 优先删除选中项；未选中时删除鼠标下对象。' : first.kind === 'ringNotes' ? 'Alt＋滚轮调整长度；轨道 -18…-1、1…18，文件编号仍为 0–35。' : first.kind === 'obstacles' ? '全高墙 type 0；上半墙 type 1，下方留空。点击地面四轨放置，Alt 拖动换轨。' : '在右侧灯光轨道点击空位放置，点击事件可选中；速度点越高代表越快。'}</p>`;
  } else {
    $('inspector').innerHTML = `<div class="inspector-caption">放置 ${mode === 'notes' ? '音符' : labels[active]}<span>当前节拍 ${beat.toFixed(2)}</span></div>${mode === 'obstacles' ? wallOptions : mode === 'events' ? lightInspector() : mode === 'notes' ? `<div class="color-picker"><button data-color="0" class="${noteType === 0 ? 'active' : ''}"><i class="legend-dot pink"></i>红色</button><button data-color="1" class="${noteType === 1 ? 'active' : ''}"><i class="legend-dot blue"></i>蓝色</button></div>` : ''}<div class="empty-selection"><span class="empty-icon">${icon('mouse-pointer-2')}</span><strong>${mode === 'obstacles' ? '点击地面四轨，放置障碍物' : mode === 'notes' ? '点击圆环或脚部平台放置音符' : '点击右侧灯光轨道放置事件'}</strong><p>点击已有物体选中 · Shift 点击多选<br>Alt 拖动换位 · Delete 删除</p></div><div class="quick-add">${mode === 'notes' ? `<button id="add-at-beat">添加手部音符</button><button id="add-foot">添加脚部音符</button><button id="hold-add">添加脚部长音符</button>` : `<button id="add-at-beat">在当前拍添加${mode === 'obstacles' ? '障碍物' : '事件'}</button>`}</div>`;
  }
  iconsRefresh();
}
function setMode(next: typeof mode) { mode = next; active = next; selected = []; renderInspector(); draw(); }
function select(refs: Selection[]) { selected = refs; if (refs[0]) { active = refs[0].kind; mode = active === 'obstacles' && mode === 'notes' ? 'notes' : active === 'obstacles' || active === 'events' ? active : 'notes'; } renderInspector(); draw(); }
function refreshDiagnostics() {
  if (!diagnosticsDirty && diagnosticsChart === project.chart) return;
  diagnosticsDirty = false; diagnosticsChart = project.chart; overlaps = findOverlaps(project);
  const status = $('overlap-status'); status.hidden = !overlaps.length;
  status.textContent = overlaps.length ? `⚠ beat ${Number(overlaps[0].time.toFixed(5))} 上有错误音符 · ${overlaps.length} 处重叠` : '';
}
function showOverlaps() {
  refreshDiagnostics();
  modal('重叠音符', `<p>以下音符占用相同位置。点击一项跳转并选中，移动或删除后提示会自动消失。</p><div class="overlap-list">${overlaps.map((o, i) => `<button data-overlap="${i}">beat ${Number(o.time.toFixed(5))} · ${labels[o.kind]} · ${o.indices.length} 个重叠对象</button>`).join('') || '没有重叠音符'}</div>`);
}
function selectGroup(ref: Selection) {
  const n = items(project, ref.kind)[ref.index]; if (!n?.groupId) return;
  select(items(project, ref.kind).flatMap((item, index) => item.groupId === n.groupId ? [{ kind: ref.kind, index }] : []));
}
function permitted(kind: Kind) { return mode === 'notes' ? kind === 'notes' || kind === 'ringNotes' : kind === mode; }
function currentSeconds() { return beatToSeconds(beat, Number(project.info.beatsPerMinute), Number(project.info.songTimeOffset) || 0); }
function setBeat(value: number) {
  beat = Math.max(0, Math.min(totalBeats(), value));
  if (audioUrl) audio.currentTime = Math.max(0, Math.min(Number.isFinite(audio.duration) ? audio.duration : Infinity, currentSeconds()));
  virtualStart = performance.now(); virtualBeat = beat; updateTransport(); draw();
}
function updateTransport() {
  const sec = Math.max(0, currentSeconds()); $('time-display').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')}`;
  if (document.activeElement !== $('beat-input')) $<HTMLInputElement>('beat-input').value = beat.toFixed(3);
  $<HTMLInputElement>('seek').value = String(beat);
  $('visible-range').textContent = `${start.toFixed(1)} — ${(start + (timeline.clientWidth - timelineMargin) / scale).toFixed(1)} 拍`;
}
function stop() { audio.pause(); playing = false; $('play').innerHTML = icon('play'); iconsRefresh(); }
async function togglePlay() {
  if (playing) { stop(); return; }
  if (beat >= totalBeats()) setBeat(0);
  if (audioUrl) { try { await audio.play(); } catch { notify('音频无法播放，请检查文件格式或重新选择音频'); return; } }
  virtualStart = performance.now(); virtualBeat = beat; playing = true; $('play').innerHTML = icon('pause'); iconsRefresh();
}
let audioContext: AudioContext | undefined;
function clickBeat() {
  audioContext ??= new AudioContext(); void audioContext.resume(); const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
  const volume = Number($<HTMLInputElement>('metronome-volume').value);
  oscillator.frequency.value = Math.floor(beat) % 4 === 0 ? 1200 : 800; gain.gain.setValueAtTime(.48 * volume, audioContext.currentTime); gain.gain.linearRampToValueAtTime(0, audioContext.currentTime + .04); oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + .05);
}
function frame(now: number) {
  spatialPreview?.tick(now);
  if (playing) {
    beat = audioUrl ? Math.max(0, secondsToBeat(audio.currentTime, project.info.beatsPerMinute, project.info.songTimeOffset || 0)) : virtualBeat + (now - virtualStart) / 1000 * project.info.beatsPerMinute / 60 * Number($<HTMLInputElement>('speed').value);
    if (metronome && Math.floor(beat) !== lastClickBeat) { lastClickBeat = Math.floor(beat); clickBeat(); }
    if (beat >= totalBeats() || audio.ended && !!audioUrl) stop();
    const windowSize = (timeline.clientWidth - timelineMargin) / scale;
    if (beat > start + windowSize * .85 || beat < start) { start = Math.max(0, beat - windowSize * .15); $<HTMLInputElement>('scroll').value = String(start); }
    updateTransport(); draw();
  }
  requestAnimationFrame(frame);
}
async function loadAudio(url: string) {
  const token = ++waveToken; stop(); waveform = [];
  if (audioUrl.startsWith('blob:')) URL.revokeObjectURL(audioUrl);
  audioUrl = url; audio.src = url; audio.volume = Number($<HTMLInputElement>('volume').value); audio.playbackRate = Number($<HTMLInputElement>('speed').value);
  if (!url) { audio.removeAttribute('src'); audio.load(); draw(); return; }
  try {
    const response = await fetch(url); if (!response.ok) throw new Error('无法读取音频');
    const bytes = await response.arrayBuffer(); audioContext ??= new AudioContext(); const decoded = await audioContext.decodeAudioData(bytes);
    if (token !== waveToken) return;
    const data = decoded.getChannelData(0), count = 4000, stride = Math.max(1, Math.floor(data.length / count));
    waveform = Array.from({ length: count }, (_, i) => { let max = 0; for (let j = i * stride; j < Math.min(data.length, (i + 1) * stride); j += 16) max = Math.max(max, Math.abs(data[j])); return max; }); draw();
  } catch { if (token === waveToken) notify('无法生成音频波形，仍可继续编辑谱面'); }
}
function modal(title: string, html: string) { $('modal').classList.remove('tutorial-dialog'); $('modal-content').innerHTML = `<div class="modal-heading"><h2>${title}</h2><button id="close-modal">${icon('x')}</button></div>${html}`; if (!$<HTMLDialogElement>('modal').open) $<HTMLDialogElement>('modal').showModal(); iconsRefresh(); }
function showTutorial(index = 0) { modal('新手教程', tutorialHtml(Math.max(0, Math.min(tutorialSteps.length - 1, index)))); $('modal').classList.add('tutorial-dialog'); }
function confirmDiscard(action: () => void) {
  if (!dirty) { action(); return; }
  modal('离开当前谱面？', '<p>当前修改尚未保存。请先保存，或选择放弃修改后继续。</p><div class="modal-actions"><button id="discard" class="danger">放弃修改并继续</button><button id="cancel-modal">继续编辑</button></div>');
  $('discard').onclick = () => { $<HTMLDialogElement>('modal').close(); action(); };
}
async function openSong(song: Song, chartPath?: string) {
  const loadId = ++loadingProject;
  try {
    const entry = chartPath ? song.charts.find(c => c.path === chartPath) : song.charts.find(c => c.difficulty === 'Normal') ?? song.charts[0];
    if (!entry) { notify('此歌曲没有谱面文件，可新建谱面并导入该歌曲音频'); return; }
    const p = await api<Project>(`/api/project?song=${encodeURIComponent(song.id)}&chart=${encodeURIComponent(entry.path)}`);
    if (loadId !== loadingProject) return;
    activeSong = song; localAssets.clear(); project = p; history.clear(); selected = []; beat = 0; start = 0; dirty = false; savedSignature = JSON.stringify(project);
    $('current-cover').innerHTML = song.cover ? `<img draggable="false" src="${asset(song.id, song.cover)}" alt="歌曲封面">` : '◎';
    $('save-state').textContent = '已保存'; $('save-state').classList.remove('unsaved'); renderSummary(); renderLibrary(); renderInspector(); updateTransport(); draw();
    void loadAudio(song.audio ? asset(song.id, song.audio) : '');
    if (song.warnings.length) notify(`已按实际文件加载；发现 ${song.warnings.length} 个旧元数据路径引用`);
  } catch (e: any) { notify(e.message); }
}
function add(kind: Kind, lineIndex = 0, layer = 0, time = snap(beat, division), hold = false, obstacleType = 0) {
  if (shiftHeld || !permitted(kind)) return;
  if (kind === 'notes' && !isHandPosition(lineIndex, layer)) { notify('圆环只使用外圈 10 个位置，(1,1) 和 (2,1) 不可放置'); return; }
  mutate(() => { const n = newItem(kind, time, lineIndex, kind === 'obstacles' ? obstacleType : noteType); if (kind === 'events') n.value = lightMapping.find(t => t.type === lineIndex)?.speed ? Math.min(6, eventValue) : eventValue; if (kind === 'notes') n.lineLayer = layer; if (kind === 'ringNotes' && hold) { n.ringNoteType = 1; n.duration = 1; } const list = ensureItems(project, kind); list.push(n); selected = []; active = kind; });
}
function removeSelected() { if (!selected.length) return; mutate(() => { const touched = new Set(selected.filter(s => s.kind === 'notes').map(s => items(project, 'notes')[s.index].groupId).filter(Boolean) as string[]); for (const k of kinds) { const indices = new Set(selected.filter(s => s.kind === k).map(s => s.index)); const list = ensureItems(project, k); for (let i = list.length - 1; i >= 0; i--) if (indices.has(i)) list.splice(i, 1); } repairGroups(project, touched); selected = []; }); }
function copy() { clipboard = selected.map(s => ({ kind: s.kind, item: structuredClone(items(project, s.kind)[s.index]) })); notify(`已复制 ${clipboard.length} 项`); }
function paste() {
  if (!clipboard.length) return; const min = Math.min(...clipboard.map(c => c.item.time)), groups = new Map<string, string>();
  mutate(() => { selected = clipboard.map(c => { const n = structuredClone(c.item); n.time = Math.max(0, n.time - min + snap(beat, division)); if (n.groupId) { if (!groups.has(n.groupId)) groups.set(n.groupId, crypto.randomUUID()); n.groupId = groups.get(n.groupId); } const list = ensureItems(project, c.kind); list.push(n); return { kind: c.kind, index: list.length - 1 }; }); repairGroups(project, new Set(groups.values())); });
}
function mirror(axis: MirrorMode) {
  if (!selected.length || axis !== 'left-right' && (mode === 'obstacles' || selected.some(s => s.kind === 'obstacles'))) return;
  mutate(() => { for (const s of selected) { const n = items(project, s.kind)[s.index]; Object.assign(n, mirroredItem(s.kind, n, axis)); } });
}
function togglePlacementColor() { noteType = 1 - noteType; renderInspector(); }
function groupNotes(action: GroupAction = 'create', targetId?: string) {
  const options = groupingOptions(project, selected);
  if (action === 'join' && !targetId) {
    if (options.ids.length === 1) targetId = options.ids[0];
    else { modal('加入已有组', `<p>选择接收这些音符的组，原组中未选中的成员仍会保留。</p>${options.ids.map((id, i) => `<button data-join-id="${escape(id)}">组 ${i + 1} · ${escape(id.slice(0, 8))}</button>`).join('')}`); return; }
  }
  const trial = structuredClone(project);
  if (applyGrouping(trial, selected, action, targetId)) mutate(() => { project = trial; });
}
function closeFill() { fillSession = undefined; $('fill-panel').hidden = true; }
function cancelFill() {
  const session = fillSession; if (!session) return;
  project = session.before; selected = session.selection; history.restore(session.history);
  closeFill(); changed(); renderInspector(); notify('已取消本次填充');
}
function beginFill() {
  if (shiftHeld || selected.length !== 2 || !selected.every(s => s.kind === 'notes')) return;
  if (fillSession) { $('fill-panel').hidden = false; return; }
  const pair = fillEndpoints(items(project, 'notes')[selected[0].index], items(project, 'notes')[selected[1].index]);
  if (!pair) { notify('请选择不同节拍上的两个有效手部音符'); return; }
  const plans = { clockwise: fillPlans(...pair, 'clockwise'), counterclockwise: fillPlans(...pair, 'counterclockwise') };
  const direction = plans.clockwise.length ? 'clockwise' : 'counterclockwise';
  if (!plans[direction].length) { notify('两个音符间隔太小，没有可填充的方案'); return; }
  fillSession = { before: structuredClone(project), history: history.checkpoint(), selection: [...selected], chart: project.chart, endpoints: pair, generated: [], plans, direction, index: nearestFillPlan(plans[direction], division), skipped: 0 };
  applyFill();
}
function applyFill() {
  const session = fillSession; if (!session) return;
  const plan = session.plans[session.direction][session.index]; if (!plan) return;
  const generated = new Set(session.generated), existing = items(project, 'notes').filter(n => !generated.has(n));
  const result = buildFill(...session.endpoints, plan, existing);
  applyingFill = true;
  try {
    mutate(() => {
      project.chart.notes = [...existing, ...result.notes]; session.generated = result.notes; session.skipped = result.skipped;
      const sharedGroup = session.endpoints[0].groupId;
      if (sharedGroup && sharedGroup === session.endpoints[1].groupId) repairGroups(project, new Set([sharedGroup]));
      selected = session.endpoints.map(n => ({ kind: 'notes', index: project.chart.notes!.indexOf(n) }));
    });
  } finally { applyingFill = false; }
  renderFill();
}
function renderFill() {
  const session = fillSession; if (!session) return;
  const plans = session.plans[session.direction], plan = plans[session.index], number = (n: number) => String(Number(n.toPrecision(7)));
  $('fill-panel').hidden = false;
  $('fill-panel').innerHTML = `<div class="fill-heading"><strong>圆环填充</strong><span>beat ${number(session.endpoints[0].time)} → ${number(session.endpoints[1].time)}</span><button id="fill-cancel" aria-label="取消本次填充">取消</button><button id="fill-close" aria-label="完成填充">完成</button></div><div class="fill-directions"><button id="fill-clockwise" class="${session.direction === 'clockwise' ? 'active' : ''}" ${session.plans.clockwise.length ? '' : 'disabled'}>↻ 顺时针</button><button id="fill-counterclockwise" class="${session.direction === 'counterclockwise' ? 'active' : ''}" ${session.plans.counterclockwise.length ? '' : 'disabled'}>↺ 逆时针</button></div><div class="fill-density"><button id="fill-less" ${session.index === 0 ? 'disabled' : ''} title="减少密度，少绕一圈">− 密度</button><select id="fill-plan" aria-label="填充密度方案">${plans.map((p, i) => `<option value="${i}" ${i === session.index ? 'selected' : ''}>${p.steps - 1} 个位置 · 1/${number(p.denominator)} 拍</option>`).join('')}</select><button id="fill-more" ${session.index === plans.length - 1 ? 'disabled' : ''} title="增加密度，多绕一圈">＋ 密度</button></div><p class="fill-result" aria-live="polite">已新增 ${session.generated.length} 个 · 保留已有 ${session.skipped} 个 · 路径 ${Math.floor(plan.steps / 10)} 圈 ${plan.steps % 10} 格</p><p class="fill-hint">顺时针 ${session.plans.clockwise.length} 种／逆时针 ${session.plans.counterclockwise.length} 种（最多新增 ${maxFillNotes} 个）。颜色跟随起点，端点保留；调整替换本次结果，支持撤销。</p>`;
  $('fill-plan').onchange = () => { session.index = Number($<HTMLSelectElement>('fill-plan').value); applyFill(); focusEditor(); };
}
function changeFillDirection(direction: FillDirection) {
  const session = fillSession; if (!session || direction === session.direction || !session.plans[direction].length) return;
  const density = session.plans[session.direction][session.index].denominator;
  session.direction = direction; session.index = nearestFillPlan(session.plans[direction], density); applyFill();
}
function changeFillDensity(delta: number) {
  const session = fillSession; if (!session) return;
  const next = Math.max(0, Math.min(session.plans[session.direction].length - 1, session.index + delta));
  if (next === session.index) return; session.index = next; applyFill();
}
function renderBookmarks() {
  const total = totalBeats(), marks = project.chart.customData?.bookmarks ?? [];
  $('seek-bookmarks').innerHTML = marks.map((mark: any, index: number) => Number.isFinite(mark.time) && mark.time >= 0 ? `<button class="seek-bookmark" data-bookmark="${index}" style="left:${Math.min(100, mark.time / total * 100)}%" title="${escape(mark.name || '书签')} · beat ${Number(mark.time.toFixed(5))}" aria-label="书签 ${escape(mark.name || index + 1)}，第 ${Number(mark.time.toFixed(5))} 拍">◆</button>` : '').join('');
}
function addBookmark() {
  mutate(() => { project.chart.customData ??= {}; const marks = project.chart.customData.bookmarks ??= []; marks.push({ time: Number(beat.toFixed(6)), name: `书签 ${marks.length + 1}` }); });
  notify(`已在 beat ${Number(beat.toFixed(5))} 添加书签`);
}
function eventTypeSelect(type: number, attrs: string) {
  const tracks = lightTracks([...items(project, 'events'), { time: 0, type }], lightMapping);
  return `<select ${attrs} aria-label="灯光轨道">${tracks.map(t => `<option value="${t.type}" ${t.type === type ? 'selected' : ''}>${escape(t.name)}</option>`).join('')}</select>`;
}
function eventValueSelect(type: number, value: number, attrs: string) {
  const speed = lightMapping.find(t => t.type === type)?.speed;
  const options = speed ? Array.from({ length: 7 }, (_, i) => `${i}${i === 0 ? ' · 静止' : i === 6 ? ' · 最快' : ''}`) : lightValues;
  return `<select ${attrs} aria-label="灯光事件参数">${options.map((text, i) => `<option value="${i}" ${i === value ? 'selected' : ''}>${text}</option>`).join('')}${value >= options.length || value < 0 ? `<option selected value="${value}">原值 ${value}</option>` : ''}</select>`;
}
function lightInspector() {
  return `<div class="light-editor"><label>轨道${eventTypeSelect(eventType, 'id="light-track"')}</label><label>放置事件${eventValueSelect(eventType, eventValue, 'id="light-value"')}</label><div><button id="light-focus">灯光总览</button><button id="light-mapping">轨道映射</button></div><small>10 轨名称及效果采用样本推定映射，可校准。绿／黄短条表示灯光；绿点高度表示速度。</small></div>`;
}
function mappingDialog() {
  modal('灯光轨道映射', `<p>以下对应关系由现有谱面推定，尚未经过游戏实机校准。修改只影响编辑器的名称对应，不改写已有事件的 type / value。颜色与渐入、渐出预览也属于推定。</p><div class="field-grid">${lightMapping.map(t => `<label>${t.name}<input data-light-map="${t.key}" type="number" min="0" step="1" value="${t.type}"></label>`).join('')}</div><div class="modal-actions"><button id="light-map-default">恢复推定映射</button><button id="light-map-apply" class="primary">应用</button></div>`);
  $('light-map-default').onclick = () => { document.querySelectorAll<HTMLInputElement>('[data-light-map]').forEach((input, i) => { input.value = String(defaultLightTracks[i].type); }); };
  $('light-map-apply').onclick = () => {
    const types = [...document.querySelectorAll<HTMLInputElement>('[data-light-map]')].map(i => Number(i.value));
    if (!validLightMapping(types)) { notify('轨道编号须为不重复的非负整数'); return; }
    lightMapping = defaultLightTracks.map((t, i) => ({ ...t, type: types[i] })); localStorage.setItem('ringmapper-light-mapping', JSON.stringify(types));
    if (spatialPreview) spatialPreview.lighting.mapping = lightMapping;
    eventType = lightMapping[0].type; eventValue = 1; $<HTMLDialogElement>('modal').close(); renderInspector(); draw();
  };
}
async function saveProject(songId = project.songId) {
  if (saving) return;
  if (!songId) { modal('保存到本地曲库', '<p>输入新歌曲目录名，谱面将写入项目的 Map 目录。音频、封面及其他难度会一同保存。</p><label class="full-field">目录名<input id="new-song-id" value="my-song"></label><div class="modal-actions"><button id="confirm-save" class="primary">保存</button></div>'); $('confirm-save').onclick = () => { const id = $<HTMLInputElement>('new-song-id').value.trim(); $<HTMLDialogElement>('modal').close(); void saveProject(id); }; return; }
  try {
    saving = true; $<HTMLButtonElement>('save').disabled = true;
    const original = structuredClone(project); const p = sortedProject(project); p.songId = songId;
    const assets: Record<string, string> = {};
    for (const [name, blob] of localAssets) assets[name] = await blobBase64(blob);
    const result = await api<{ revision: string; backup: string; info: any }>('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, assets }) });
    const sameContext = project.songId === original.songId && project.chartPath === original.chartPath;
    if (sameContext) {
      const unchanged = JSON.stringify(project) === JSON.stringify(original);
      project.songId = songId; project.revision = result.revision;
      if (unchanged) project.info = result.info; else updateMetadata(project);
      original.songId = songId; original.revision = result.revision; original.info = result.info; savedSignature = JSON.stringify(original);
      if (unchanged) localAssets.clear(); changed();
    }
    songs = await api<Song[]>('/api/catalog'); if (sameContext) activeSong = songs.find(s => s.id === songId); renderLibrary(); renderSummary(); notify(result.backup ? '谱面已保存，原文件已自动备份' : '谱面已保存到 Map/' + songId);
  } catch (e: any) { notify('保存失败：' + e.message); }
  finally { saving = false; $<HTMLButtonElement>('save').disabled = false; }
}
function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
async function exportProject() {
  try {
    const p = sortedProject(project), errors = validateChart(p.chart, p.event); if (errors.length) throw new Error(errors[0]); updateMetadata(p);
    let zip: JSZip;
    if (project.songId) { const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); if (!r.ok) throw new Error((await r.json()).error); zip = await JSZip.loadAsync(await r.arrayBuffer()); }
    else { zip = new JSZip(); zip.file('Info.yaml', writeYaml(p.info)); zip.file(p.chartPath, writeYaml(p.chart)); zip.file(p.eventPath, writeYaml(p.event)); }
    for (const [name, blob] of localAssets) zip.file(name, blob);
    zip.file('Info.yaml', writeYaml(p.info)); zip.file(p.chartPath, writeYaml(p.chart)); zip.file(p.eventPath, writeYaml(p.event));
    download(await zip.generateAsync({ type: 'blob' }), `${p.info.songName || 'RingMapper'}.zip`); notify('ZIP 已导出，包含音频、封面及已有难度');
  } catch (e: any) { notify('导出失败：' + e.message); }
}
function settings() {
  const values = ['songName', 'songAuthorName', 'levelAuthorName', 'beatsPerMinute', 'songTimeOffset', 'songDuration'];
  const names = ['歌曲名称', '艺术家', '谱师', 'BPM', '音频偏移（秒）', '歌曲时长（秒）'];
  const sets = [...(project.info.difficultyCiphermapSets ?? []), ...(project.info.difficultyBeatmapSets ?? [])];
  const entry = sets.flatMap((s: any) => s.difficultyCiphermaps ?? s.difficultyBeatmaps ?? []).find((e: any) => (e.ciphermapFilename ?? e.beatmapFilename) === project.chartPath) ?? {};
  modal('歌曲与难度设置', `<div class="field-grid settings-grid">${values.map((key, i) => `<label>${names[i]}<input data-info="${key}" type="${i > 2 ? 'number' : 'text'}" step="any" value="${escape(project.info[key])}"></label>`).join('')}${['noteJumpMovementSpeed', 'noteJumpStartBeatOffset', 'ringNoteJumpMovementSpeed', 'ringNoteJumpStartBeatOffset'].map((key, i) => `<label>${['手部跳跃速度', '手部出生拍偏移', '脚部跳跃速度', '脚部出生拍偏移'][i]}<input data-difficulty-field="${key}" type="number" step="any" value="${escape(entry[key] ?? (i % 2 ? 2 : 10))}"></label>`).join('')}</div><p class="field-help">偏移约定：音频秒数 = 节拍 × 60 / BPM + 偏移。需试听校准。推荐 OGG 音频与 512 × 512 PNG 封面。</p><div class="modal-actions"><button id="choose-audio">${icon('music-2')}导入音频</button><button id="choose-cover">${icon('image')}导入封面</button><button id="tap-tempo">点击测 BPM</button><button id="apply-settings" class="primary">应用设置</button></div>`);
  $('choose-audio').onclick = () => $<HTMLInputElement>('audio-input').click(); $('choose-cover').onclick = () => $<HTMLInputElement>('cover-input').click();
  const taps: number[] = []; $('tap-tempo').onclick = () => { if (!playing) void togglePlay(); if (taps.length && performance.now() - taps.at(-1)! > 2500) taps.length = 0; taps.push(performance.now()); if (taps.length > 8) taps.shift(); if (taps.length > 1) { const bpm = Math.round(60000 * (taps.length - 1) / (taps.at(-1)! - taps[0])); (document.querySelector('[data-info="beatsPerMinute"]') as HTMLInputElement).value = String(bpm); $('tap-tempo').textContent = `${bpm} BPM · 继续点击`; } };
  $('apply-settings').onclick = () => {
    const inputs = [...document.querySelectorAll<HTMLInputElement>('[data-info]')];
    if (inputs.some(i => i.type === 'number' && (!i.value.trim() || !Number.isFinite(i.valueAsNumber))) || Number(inputs.find(i => i.dataset.info === 'beatsPerMinute')!.value) <= 0) { notify('请填写有效数值，BPM 必须大于 0'); return; }
    mutate(() => { for (const i of inputs) project.info[i.dataset.info!] = i.type === 'number' ? Number(i.value) : i.value; updateMetadata(project); const all = [...(project.info.difficultyCiphermapSets ?? []), ...(project.info.difficultyBeatmapSets ?? [])]; const target = all.flatMap((s: any) => s.difficultyCiphermaps ?? s.difficultyBeatmaps ?? []).find((e: any) => (e.ciphermapFilename ?? e.beatmapFilename) === project.chartPath); for (const i of document.querySelectorAll<HTMLInputElement>('[data-difficulty-field]')) target[i.dataset.difficultyField!] = Number(i.value); });
    setBeat(beat); $<HTMLDialogElement>('modal').close();
  };
}
function checkChart() {
  const errors = validateChart(project.chart, project.event), overlaps = findOverlaps(project).map(o => `${labels[o.kind]} beat ${Number(o.time.toFixed(5))}，${o.indices.length} 个重叠对象`), groups = new Map<string, Item[]>();
  for (const n of items(project, 'notes')) if (n.groupId) { const list = groups.get(n.groupId) ?? []; list.push(n); groups.set(n.groupId, list); }
  for (const [id, notes] of groups) { const list = [...notes].sort((a, b) => a.time - b.time); if (list.length < 2 || list[0].groupNoteType !== 1 || list.at(-1)!.groupNoteType !== 2 || list.filter(n => n.groupNoteType === 1).length !== 1 || list.filter(n => n.groupNoteType === 2).length !== 1) errors.push(`分组 ${id} 需要至少两个音符、一个组头和一个组尾`); }
  const hands = items(project, 'notes'), left = hands.filter(n => n.type === 0).length, right = hands.filter(n => n.type === 1).length;
  modal('谱面检查与统计', `<div class="stats-grid"><div><strong>${hands.length}</strong>手部音符</div><div><strong>${items(project, 'ringNotes').length}</strong>脚部音符</div><div><strong>${items(project, 'obstacles').length}</strong>障碍物</div><div><strong>${((hands.length + items(project, 'ringNotes').length) / (Number(project.info.songDuration) || 1)).toFixed(2)}</strong>平均每秒音符</div></div><p>红 / 蓝：${left} / ${right}（比值 ${right ? (left / right).toFixed(2) : '—'}） · 上 / 中 / 下层：${[2, 1, 0].map(l => hands.filter(n => n.lineLayer === l).length).join(' / ')} · ${groups.size} 个分组</p><h3>字段与分组 ${errors.length ? `· ${errors.length} 项问题` : '· 通过'}</h3><ul class="check-list">${errors.slice(0, 50).map(e => `<li>${escape(e)}</li>`).join('') || '<li>未发现字段或分组问题。</li>'}</ul><h3>重叠位置 · ${overlaps.length} 项</h3><ul class="check-list">${overlaps.slice(0, 50).map(e => `<li>${escape(e)}</li>`).join('') || '<li>未发现同拍同位置音符。</li>'}</ul><p class="field-help">检查只反映文件结构与相同位置；实际动作可玩性仍需在游戏中验证。</p>`);
}
function rangeDialog() {
  modal('范围选取', `<div class="field-grid"><label>起始拍<input id="range-start" type="number" min="0" step="any" value="${Math.floor(beat)}"></label><label>结束拍<input id="range-end" type="number" min="0" step="any" value="${Math.floor(beat) + 4}"></label></div><label class="full-field">选取内容<select id="range-kind"><option value="all">所有内容</option>${kinds.map(k => `<option value="${k}">${labels[k]}</option>`).join('')}</select></label><div class="modal-actions"><button id="range-apply" class="primary">选取范围</button><button id="range-delete" class="danger">删除范围内容</button></div>`);
  const apply = () => { const a = Number($<HTMLInputElement>('range-start').value), b = Number($<HTMLInputElement>('range-end').value), k = $<HTMLSelectElement>('range-kind').value; if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < a) { notify('范围必须满足 0 ≤ 起始拍 ≤ 结束拍'); return false; } selected = kinds.filter(kind => k === 'all' || kind === k).flatMap(kind => items(project, kind).map((n, index) => ({ n, index })).filter(({ n }) => n.time >= a && n.time <= b).map(({ index }) => ({ kind, index }))); return true; };
  $('range-apply').onclick = () => { if (!apply()) return; $<HTMLDialogElement>('modal').close(); select(selected); };
  $('range-delete').onclick = () => { if (!apply()) return; $<HTMLDialogElement>('modal').close(); removeSelected(); };
}
async function openWorkspaceFolder() {
  try { await api('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ song: project.songId || '' }) }); notify('已在文件管理器中打开谱面目录'); } catch (e: any) { notify('打开目录失败：' + e.message); }
}
function addDifficulty(initialMode = 'Ring', initialDifficulty = 'Hard') {
  modal('添加难度', `<div class="field-grid"><label>模式<select id="new-mode"><option>Ring</option><option>RingDance</option></select></label><label>难度<select id="new-difficulty"><option>Easy</option><option>Normal</option><option selected>Hard</option><option>Expert</option><option>ExpertPlus</option></select></label></div><label class="checkbox"><input id="clone-chart" type="checkbox">复制当前音符与障碍物</label><label class="checkbox"><input id="clone-events" type="checkbox" checked>复制当前灯光事件</label><div class="modal-actions"><button id="difficulty-create" class="primary">创建难度</button></div>`);
  $<HTMLSelectElement>('new-mode').value = initialMode; $<HTMLSelectElement>('new-difficulty').value = initialDifficulty;
  $('difficulty-create').onclick = async () => {
    const mode = $<HTMLSelectElement>('new-mode').value, difficulty = $<HTMLSelectElement>('new-difficulty').value, nextPath = `${mode}/${difficulty}${mode}.yaml`;
    if (nextPath === project.chartPath || activeSong?.charts.some(c => c.path === nextPath) || localAssets.has(nextPath)) { notify('此难度已存在'); return; }
    updateMetadata(project);
    const clone = $<HTMLInputElement>('clone-chart').checked, cloneEvents = $<HTMLInputElement>('clone-events').checked;
    localAssets.set(project.chartPath, new Blob([writeYaml(project.chart)])); localAssets.set(project.eventPath, new Blob([writeYaml(project.event)]));
    mutate(() => {
      project.chartPath = nextPath; project.eventPath = nextPath.replace('.yaml', 'Event.yaml');
      if (!clone) project.chart = { version: '2.3.0', notes: [], ringNotes: [], obstacles: [], customData: { bookmarks: [] } };
      if (!cloneEvents) project.event = { version: '2.3.0', events: [] }; selected = []; updateMetadata(project);
    });
    // New targets require a fresh revision including missing files, obtained without changing source files.
    if (project.songId) { try { project.revision = (await api<{ revision: string }>(`/api/revision?song=${encodeURIComponent(project.songId)}&chart=${encodeURIComponent(project.chartPath)}&event=${encodeURIComponent(project.eventPath)}`)).revision; } catch (e: any) { notify(e.message); } }
    $<HTMLDialogElement>('modal').close(); renderSummary(); notify('已创建新难度，保存后写入歌曲目录');
  };
}
async function importFiles(files: File[]) {
  try {
    let p = newProject(); const assets = new Map<string, Blob>();
    if (files[0]?.name.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(files[0]); const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
      if (names.length > 3000) throw new Error('ZIP 文件数量过多');
      const infoName = names.find(n => /(^|\/)Info\.yaml$/i.test(n)); if (!infoName) throw new Error('ZIP 中缺少 Info.yaml');
      const prefix = infoName.slice(0, -'Info.yaml'.length); let bytes = 0;
      for (const name of names.filter(n => n.startsWith(prefix))) { const relative = name.slice(prefix.length); if (!relative || relative.includes('..') || relative.startsWith('/') || relative.includes(':')) continue; const blob = await zip.files[name].async('blob'); bytes += blob.size; if (bytes > 200_000_000) throw new Error('解压内容超过 200MB'); assets.set(relative, blob); }
      p.info = readYaml(await blobText(assets.get('Info.yaml')!));
      const charts = [...assets.keys()].filter(n => /\.yaml$/i.test(n) && n !== 'Info.yaml' && !/Event\.yaml$/i.test(n));
      if (!charts.length) throw new Error('ZIP 中没有谱面文件');
      p.chartPath = charts.find(n => /Normal/.test(n)) ?? charts[0]; p.eventPath = p.chartPath.replace('.yaml', 'Event.yaml');
      p.chart = readYaml(await blobText(assets.get(p.chartPath)!)); p.event = assets.has(p.eventPath) ? readYaml(await blobText(assets.get(p.eventPath)!)) : { version: p.chart.version, events: [] };
    } else {
      const chartFile = files.find(f => !/Event\.ya?ml$/i.test(f.name) && f.name !== 'Info.yaml'); if (!chartFile) throw new Error('请选择音符 YAML，可同时选择 Info.yaml 与 Event.yaml');
      p.chart = readYaml(await blobText(chartFile)); p.chartPath = `Ring/${chartFile.name}`; p.eventPath = p.chartPath.replace(/\.ya?ml$/, 'Event.yaml');
      const info = files.find(f => f.name === 'Info.yaml'); if (info) p.info = readYaml(await blobText(info));
      const events = files.find(f => /Event\.ya?ml$/i.test(f.name)); if (events) p.event = readYaml(await blobText(events));
    }
    const errors = validateChart(p.chart, p.event); if (errors.length) throw new Error(errors.slice(0, 3).join('；'));
    if (!(Number(p.info.beatsPerMinute) > 0)) throw new Error('Info.yaml 的 BPM 必须大于 0');
    project = p; activeSong = undefined; localAssets = assets; selected = []; history.clear(); beat = start = 0; savedSignature = ''; changed(); renderLibrary(); renderInspector();
    const audioBlob = assets.get(p.info.songFilename); void loadAudio(audioBlob ? URL.createObjectURL(audioBlob) : '');
    const cover = assets.get(p.info.coverImageFilename); setCover(cover); notify('谱面导入成功，全部难度与原始字段已保留');
  } catch (e: any) { notify('导入失败：' + e.message); }
}
let coverUrl = '';
function setCover(blob?: Blob) { if (coverUrl) URL.revokeObjectURL(coverUrl); coverUrl = blob ? URL.createObjectURL(blob) : ''; $('current-cover').innerHTML = coverUrl ? `<img src="${coverUrl}" alt="歌曲封面">` : '◎'; }
function undo(redo = false) {
  const next = redo ? history.redo(project) : history.undo(project); if (!next) return;
  const revision = project.revision; project = next; project.revision = revision; selected = []; changed(); renderInspector();
}
const actions: Record<string, () => void> = {
  tutorial: () => showTutorial(), 'overlap-status': showOverlaps, fill: beginFill, 'fill-close': closeFill, 'fill-cancel': cancelFill, 'fill-clockwise': () => changeFillDirection('clockwise'), 'fill-counterclockwise': () => changeFillDirection('counterclockwise'), 'fill-less': () => changeFillDensity(-1), 'fill-more': () => changeFillDensity(1),
  save: () => void saveProject(), export: () => void exportProject(), settings, check: checkChart, 'range-select': rangeDialog,
  group: () => groupNotes(), 'join-group': () => groupNotes('join'), 'light-focus': () => spatialPreview?.focusLighting(), 'light-mapping': mappingDialog, 'speed-reset': () => setPlaybackRate(1), copy, paste, 'mirror-left-right': () => mirror('left-right'), 'mirror-up-down': () => mirror('up-down'), 'mirror-diagonal': () => mirror('diagonal'), delete: removeSelected, undo: () => undo(), redo: () => undo(true),
  play: () => void togglePlay(), home: () => { stop(); setBeat(0); start = 0; draw(); }, follow: () => { start = Math.max(0, beat - 2); draw(); },
  'new-project': () => confirmDiscard(() => { project = newProject(); activeSong = undefined; localAssets.clear(); history.clear(); selected = []; beat = start = 0; savedSignature = ''; void loadAudio(''); setCover(); changed(); renderLibrary(); renderInspector(); settings(); }),
  import: () => confirmDiscard(() => $<HTMLInputElement>('import-input').click()),
  'workspace-folder': () => void openWorkspaceFolder(),
  'add-at-beat': () => add(mode === 'notes' ? 'notes' : mode, mode === 'events' ? eventType : 0), 'add-foot': () => add('ringNotes'), 'hold-add': () => add('ringNotes', 0, 0, snap(beat, division), true),
  metronome: () => { metronome = !metronome; $('metronome').classList.toggle('active', metronome); $('metronome').setAttribute('aria-pressed', String(metronome)); if (metronome) clickBeat(); },
  'view-settings': () => {
    modal('编辑设置', `<div class="view-defaults"><label>默认纵深拉伸（×）<input id="default-depth" aria-label="默认纵深拉伸" type="number" min="0.25" max="10" step="any" required value="${viewDefaults.depthScale}"></label><label>默认预览范围（拍）<input id="default-preview-range" aria-label="默认预览范围" type="number" min="1" max="64" step="any" required value="${viewDefaults.previewRange}"></label></div><p class="field-help">修改默认值后点击完成，立即应用并记住。场景中的滑杆仅临时调整，不覆盖默认值。</p><label class="settings-opacity">圆环不透明度<input id="ring-opacity" aria-label="圆环不透明度" type="range" min="0" max="100" step="any" value="${(spatialPreview?.ringOpacity ?? .22) * 100}"><output id="ring-opacity-value">${Math.round((spatialPreview?.ringOpacity ?? .22) * 100)}%</output></label><fieldset class="note-opacity-settings"><legend>音符不透明度</legend><label class="check-setting"><input id="note-opacity-linked" type="checkbox" ${noteOpacity.linked ? 'checked' : ''}>同步调整手部和脚部</label>${(['hand', 'foot'] as const).map(key => `<label class="settings-opacity">${key === 'hand' ? '手部音符' : '脚部音符'}<input id="${key}-opacity" aria-label="${key === 'hand' ? '手部' : '脚部'}音符不透明度" type="range" min="0" max="100" step="any" value="${noteOpacity[key] * 100}"><output id="${key}-opacity-value">${Math.round(noteOpacity[key] * 100)}%</output></label>`).join('')}<p class="field-help">0% 完全透明，100% 不透明。脚部长音符同步调整，选中标记仍清晰显示。</p></fieldset><label class="check-setting"><input id="wheel-reverse" type="checkbox" ${wheelReverse ? 'checked' : ''}>歌曲进度滚轮反向</label><p class="field-help">默认向上滚动前进，勾选后向下滚动前进。Ctrl＋滚轮切换吸附档位；Alt＋滚轮编辑脚部长音符长度。</p><div class="modal-actions"><button id="view-apply" class="primary">完成</button></div>`);
    $('ring-opacity').oninput = () => { const value = Number($<HTMLInputElement>('ring-opacity').value); spatialPreview?.setRingOpacity(value / 100); $('ring-opacity-value').textContent = `${Math.round(value)}%`; };
    const applyOpacity = (key: 'hand' | 'foot') => {
      noteOpacity[key] = Number($<HTMLInputElement>(`${key}-opacity`).value) / 100;
      if (noteOpacity.linked) noteOpacity.hand = noteOpacity.foot = noteOpacity[key];
      for (const k of ['hand', 'foot'] as const) { $<HTMLInputElement>(`${k}-opacity`).value = String(noteOpacity[k] * 100); $(`${k}-opacity-value`).textContent = `${Math.round(noteOpacity[k] * 100)}%`; }
      spatialPreview?.setNoteOpacity(noteOpacity.hand, noteOpacity.foot);
      try { localStorage.setItem('ringmapper-note-opacity', JSON.stringify(noteOpacity)); } catch {}
    };
    for (const key of ['hand', 'foot'] as const) $(`${key}-opacity`).oninput = () => applyOpacity(key);
    $('note-opacity-linked').onchange = () => { noteOpacity.linked = $<HTMLInputElement>('note-opacity-linked').checked; applyOpacity('hand'); };
    $('wheel-reverse').onchange = () => { wheelReverse = $<HTMLInputElement>('wheel-reverse').checked; localStorage.setItem('ringmapper-wheel-reverse', String(wheelReverse)); };
    $('view-apply').onclick = () => {
      const depthInput = $<HTMLInputElement>('default-depth'), rangeInput = $<HTMLInputElement>('default-preview-range');
      if (!depthInput.reportValidity() || !rangeInput.reportValidity()) return;
      const depthScale = Number(depthInput.value), previewRange = Number(rangeInput.value);
      if (depthScale !== viewDefaults.depthScale) setDepthZoom(depthScale);
      if (previewRange !== viewDefaults.previewRange) setPreviewRange(previewRange);
      viewDefaults = { depthScale, previewRange };
      try { localStorage.setItem('ringmapper-view-defaults', JSON.stringify(viewDefaults)); } catch { notify('默认值已应用，但浏览器无法记住设置'); }
      $<HTMLDialogElement>('modal').close();
    };
  },
  help: () => modal('快捷键与操作', `<div class="shortcut-list">${[['Space', '播放 / 暂停'], ['Ctrl + Z / Y', '撤销 / 重做'], ['Ctrl + C / V', '复制 / 在播放头粘贴'], ['Ctrl + S', '保存谱面'], ['Ctrl + F', '左右镜像'], ['Ctrl + B', '在当前拍添加书签'], ['Ctrl + A', '选择当前类别中视野内的对象'], ['Delete', '优先删除选中项；未选中时删除鼠标下对象'], ['Q', '切换红蓝放置颜色'], ['1 / 2 / 3', '切换音符 / 障碍物 / 灯光'], ['按住 Shift', '暂时禁止放置（保留多选与相机控制）'], ['← / →', '前后移动一个吸附单位'], ['Shift + 点击', '多选'], ['拖动时间轴音符', '移动节拍和位置'], ['Alt + 拖动手部音符', '更改击打方向'], ['时间轴 Alt + 拖动脚部', '调整持续时长'], ['鼠标中键', '切换类型 0 / 1'], ['时间轴右键', '删除音符'], ['3D 右键拖动 / WASD', '旋转 / 移动相机'], ['3D 滚轮', '向上前进 / 向下后退，可在设置反向'], ['3D 右键 + Shift / 空格', '降低 / 升高相机'], ['3D Alt + 滚轮', '鼠标指向脚部音符，向上加长 / 向下缩短一个吸附单位；0 拍转为短音符'], ['3D Alt + 左键拖动', '拖动音符到对应轨道的其他位置'], ['3D Alt + 点击', '直接选中与圆环重叠的已有音符'], ['3D ＋ / −', '拉近 / 拉远相机'], ['Ctrl + 滚轮', '切换 SNAP 预设'], ['双击组内音符', '选中整个组']].map(([k, v]) => `<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div><p class="field-help">源文件保存前自动备份到 .ringmapper-backups。浏览器会保存最近一次工作草稿；本工具不连接官方账号。</p>`),
};
app.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('button'); if (!el) return;
  if ((e.shiftKey || shiftHeld) && (['add-at-beat', 'add-foot', 'hold-add', 'fill', 'fill-more', 'fill-less', 'fill-clockwise', 'fill-counterclockwise'].includes(el.id))) { e.preventDefault(); return; }
  if (el.id === 'close-modal' || el.id === 'cancel-modal') { $<HTMLDialogElement>('modal').close(); return; }
  const textSelection = window.getSelection();
  if (el.dataset.song && textSelection?.toString() && (el.contains(textSelection.anchorNode) || el.contains(textSelection.focusNode))) return;
  if (el.dataset.bookmark !== undefined) { const mark = project.chart.customData?.bookmarks?.[Number(el.dataset.bookmark)]; if (mark) setBeat(mark.time); return; }
  if (el.dataset.joinId) { $<HTMLDialogElement>('modal').close(); groupNotes('join', el.dataset.joinId); return; }
  if (el.dataset.tutorialStep !== undefined) { showTutorial(Number(el.dataset.tutorialStep)); return; }
  if (el.dataset.createMode && el.dataset.createDifficulty) { addDifficulty(el.dataset.createMode, el.dataset.createDifficulty); return; }
  if (actions[el.id]) { actions[el.id](); return; }
  if (el.dataset.song) { const s = songs.find(s => s.id === el.dataset.song)!; confirmDiscard(() => void openSong(s)); }
  if (el.dataset.chart && el.dataset.chart !== project.chartPath) { if (localAssets.has(el.dataset.chart)) void openLocalChart(el.dataset.chart); else if (activeSong) confirmDiscard(() => void openSong(activeSong!, el.dataset.chart)); }
  if (el.dataset.mode) setMode(el.dataset.mode as typeof mode);
  if (el.dataset.overlap !== undefined) { const o = overlaps[Number(el.dataset.overlap)]; if (o) { $<HTMLDialogElement>('modal').close(); setBeat(o.time); select(o.indices.map(index => ({ kind: o.kind, index }))); } }
  if (el.dataset.color) { noteType = Number(el.dataset.color); renderInspector(); }
});
$('inspector').addEventListener('change', e => {
  const input = e.target as HTMLInputElement;
  if (input.id === 'light-track') { eventType = Number(input.value); eventValue = 1; renderInspector(); return; }
  if (input.id === 'light-value') { eventValue = Number(input.value); return; }
  const key = input.dataset.field; if (!key || !selected.length) return;
  const value = key === 'groupId' ? input.value : input.value === '' ? undefined : Number(input.value);
  const trial = structuredClone(project);
  for (const s of selected.filter(s => s.kind === selected[0].kind)) { const n = items(trial, s.kind)[s.index]; if (value === undefined || value === '') delete n[key]; else n[key] = value; }
  const errors = validateChart(trial.chart, trial.event); if (errors.length) { notify(errors[0]); renderInspector(); return; }
  if (JSON.stringify(trial) === JSON.stringify(project)) return;
  mutate(() => { project = trial; });
});
$('search').addEventListener('input', renderLibrary);
const snapPresets = [1,2,3,4,6,8,16,24,32];
function setSnap(denominator: number) {
  if (!Number.isFinite(denominator) || denominator < .000001 || denominator > 1000000) { notify('吸附分母请输入 0.000001 到 1000000 之间的正数'); $<HTMLInputElement>('snap-denominator').value = String(division); return; }
  division = denominator;
  const preset = [1,2,3,4,6,8,16,24,32].find(n => Math.abs(division - n) < 1e-9);
  $<HTMLSelectElement>('division').value = preset ? String(preset) : 'custom';
  $<HTMLInputElement>('snap-denominator').value = String(division);
  $<HTMLInputElement>('beat-input').step = String(1 / division); draw();
}
$('division').addEventListener('change', () => {
  const value = $<HTMLSelectElement>('division').value;
  if (value === 'custom') { requestAnimationFrame(() => { $<HTMLInputElement>('snap-denominator').focus(); $<HTMLInputElement>('snap-denominator').select(); }); }
  else setSnap(Number(value));
});
$('snap-denominator').addEventListener('change', () => setSnap(Number($<HTMLInputElement>('snap-denominator').value)));
$('scroll').addEventListener('input', () => { start = Number($<HTMLInputElement>('scroll').value); draw(); updateTransport(); });
$('seek').addEventListener('input', () => setBeat(Number($<HTMLInputElement>('seek').value)));
$('beat-input').addEventListener('change', () => { const value = Number($<HTMLInputElement>('beat-input').value); if (Number.isFinite(value)) setBeat(value); });
function setPlaybackRate(rate: number) {
  // Preserve the current virtual playhead when changing speed between animation frames.
  const now = performance.now();
  if (playing && !audioUrl) beat = virtualBeat + (now - virtualStart) / 1000 * project.info.beatsPerMinute / 60 * audio.playbackRate;
  audio.playbackRate = rate; $<HTMLInputElement>('speed').value = String(rate); virtualBeat = beat; virtualStart = now;
  $('speed-reset').hidden = Math.abs(rate - 1) < 1e-9;
  $('speed-value').textContent = `${audio.playbackRate.toFixed(2)}×`; updateTransport();
}
$('speed').addEventListener('input', () => setPlaybackRate(Number($<HTMLInputElement>('speed').value)));
$('volume').addEventListener('input', () => { audio.volume = Number($<HTMLInputElement>('volume').value); });
$('import-input').addEventListener('change', () => { const input = $<HTMLInputElement>('import-input'); if (input.files?.length) void importFiles([...input.files]); input.value = ''; });
$('audio-input').addEventListener('change', () => {
  const file = $<HTMLInputElement>('audio-input').files?.[0]; if (!file) return;
  mutate(() => { project.info.songFilename = file.name; localAssets.set(file.name, file); }); void loadAudio(URL.createObjectURL(file));
  audio.addEventListener('loadedmetadata', () => { if (Number.isFinite(audio.duration)) { project.info.songDuration = audio.duration; const input = document.querySelector<HTMLInputElement>('[data-info="songDuration"]'); if (input) input.value = String(audio.duration); changed(); } }, { once: true }); notify('音频已载入');
});
$('cover-input').addEventListener('change', async () => {
  const file = $<HTMLInputElement>('cover-input').files?.[0]; if (!file) return;
  try { const image = await createImageBitmap(file), canvas = document.createElement('canvas'); canvas.width = canvas.height = 512; const side = Math.min(image.width, image.height); canvas.getContext('2d')!.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 512, 512); image.close(); const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('封面处理失败')), 'image/png')); mutate(() => { project.info.coverImageFilename = 'cover.png'; localAssets.set('cover.png', blob); }); setCover(blob); notify('封面已居中裁剪为 512 × 512 PNG'); } catch (e: any) { notify(e.message); }
});
let selectionBox: { x: number; y: number; endX: number; endY: number; base: Selection[] } | undefined;
let drag: { x: number; y: number; refs: Selection[]; originals: Item[]; pushed: boolean; alt: boolean } | undefined;
function canvasPoint(e: PointerEvent | MouseEvent, canvas: HTMLCanvasElement) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: (e.clientY - r.top) * (canvas === timeline ? timelineHeight / r.height : 1) }; }
timeline.addEventListener('pointerdown', e => {
  const { x, y } = canvasPoint(e, timeline), hit = timelineHit(x, y, view());
  if (y < 32 && x >= timelineMargin && e.button === 0) { setBeat(snap(start + (x - timelineMargin) / scale, division)); return; }
  if (!hit) { if (e.button === 0 && !e.shiftKey) select([]); return; }
  if (hit.index !== undefined) {
    const ref = { kind: hit.kind, index: hit.index };
    if (e.button === 2) { select([ref]); removeSelected(); return; }
    if (e.button === 1) { e.preventDefault(); mutate(() => { const n = items(project, hit.kind)[hit.index!]; if (n.type === 0 || n.type === 1) n.type = 1 - n.type; }); return; }
    if (e.button !== 0) return;
    const exists = selected.some(s => s.kind === ref.kind && s.index === ref.index);
    if (e.shiftKey) select(exists ? selected.filter(s => s.kind !== ref.kind || s.index !== ref.index) : [...selected, ref]); else if (!exists) select([ref]);
    drag = { x, y, refs: [...selected], originals: selected.map(s => structuredClone(items(project, s.kind)[s.index])), pushed: false, alt: e.altKey };
    timeline.setPointerCapture(e.pointerId);
  } else if (e.button === 0) {
    if (!e.shiftKey && permitted(hit.kind)) { const index = hit.kind === 'notes' ? handPositions[hit.lane][0] : hit.kind === 'events' ? eventTypes[hit.lane] : hit.lane; const layer = hit.kind === 'notes' ? handPositions[hit.lane][1] : 0; add(hit.kind, index, layer, snap(hit.time, division)); }
    else if (e.shiftKey) { selectionBox = { x, y, endX: x, endY: y, base: e.shiftKey ? [...selected] : [] }; timeline.setPointerCapture(e.pointerId); setBeat(snap(hit.time, division)); }
    else select([]);
  }
});
timeline.addEventListener('pointermove', e => {
  if (selectionBox) { const p = canvasPoint(e, timeline); selectionBox.endX = p.x; selectionBox.endY = p.y; draw(); return; }
  if (!drag) return; const { x, y } = canvasPoint(e, timeline); if (Math.abs(x - drag.x) + Math.abs(y - drag.y) < 3) return;
  if (!drag.pushed) { history.push(project); drag.pushed = true; }
  const requested = Math.round((x - drag.x) / scale * division) / division, min = Math.min(...drag.originals.map(n => n.time)), delta = Math.max(-min, requested);
  const directionVectors = [[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]];
  for (let i = 0; i < drag.refs.length; i++) {
    const s = drag.refs[i], n = items(project, s.kind)[s.index], original = drag.originals[i];
    if (drag.alt && s.kind === 'notes') {
      const angle = Math.atan2(y - drag.y, x - drag.x); let best = 0, diff = Infinity;
      directionVectors.forEach(([vx, vy], index) => { const d = Math.abs(Math.atan2(Math.sin(angle - Math.atan2(vy, vx)), Math.cos(angle - Math.atan2(vy, vx)))); if (d < diff) { diff = d; best = index; } }); n.cutDirection = best;
    } else if (drag.alt && s.kind === 'ringNotes') { n.duration = Math.max(1 / division, Number(original.duration ?? 1) + requested); if (s.kind === 'ringNotes') n.ringNoteType = 1;
    } else { n.time = Math.round((original.time + delta) * 1e6) / 1e6;
      if (drag.refs.length === 1) { const hit = timelineHit(x, y, view()); if (hit?.kind === s.kind && s.kind !== 'events') { n.lineIndex = s.kind === 'notes' ? handPositions[hit.lane][0] : hit.lane; if (s.kind === 'notes') n.lineLayer = handPositions[hit.lane][1]; } }
    }
  } diagnosticsDirty = true; draw();
});
function finishDrag() {
  if (selectionBox) { const b = selectionBox, refs = [...b.base];
    for (const kind of kinds) items(project, kind).forEach((n, index) => { const band = bands[kind], row = timelineLane(kind, n); const x = timelineMargin + (n.time - start) * scale, y = band.top + (row + .5) / band.lanes * band.height; if (x >= Math.min(b.x, b.endX) && x <= Math.max(b.x, b.endX) && y >= Math.min(b.y, b.endY) && y <= Math.max(b.y, b.endY) && !refs.some(s => s.kind === kind && s.index === index)) refs.push({ kind, index }); }); selectionBox = undefined; select(refs);
  }
  if (drag?.pushed) { changed(); renderInspector(); } drag = undefined; }
timeline.addEventListener('pointerup', finishDrag); timeline.addEventListener('pointercancel', finishDrag);
timeline.addEventListener('contextmenu', e => e.preventDefault());
timeline.addEventListener('wheel', e => { e.preventDefault(); if (e.ctrlKey) { cycleSnap(e.deltaY); } else start = Math.max(0, Math.min(totalBeats(), start + (e.deltaX || e.deltaY) / scale)); $<HTMLInputElement>('scroll').value = String(start); updateTransport(); draw(); }, { passive: false });
let previewPress: { x: number; y: number; button: number; shift: boolean } | undefined;
let spatialDrag: { ref: Selection; original: Item; pushed: boolean; pointerId: number } | undefined;
preview.addEventListener('pointerdown', e => {
  window.getSelection()?.removeAllRanges();
  if (e.button === 1) e.preventDefault();
  previewPress = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
  if (e.button !== 0 || !e.altKey) return;
  const { x, y } = canvasPoint(e, preview), hit = spatialPreview?.pick(x, y, 'notes');
  if (hit?.index === undefined) return;
  stop(); select([{ kind: hit.kind, index: hit.index }]);
  spatialDrag = { ref: { kind: hit.kind, index: hit.index }, original: structuredClone(items(project, hit.kind)[hit.index]), pushed: false, pointerId: e.pointerId };
  preview.setPointerCapture(e.pointerId); e.preventDefault(); preview.classList.add('dragging-note');
});
preview.addEventListener('pointermove', e => {
  if (!spatialDrag || !previewPress || Math.hypot(e.clientX - previewPress.x, e.clientY - previewPress.y) < 4) return;
  const { x, y } = canvasPoint(e, preview), d = spatialDrag;
  const position = spatialPreview?.dragPosition(x, y, d.ref.kind, d.original); if (!position) return;
  const note = items(project, d.ref.kind)[d.ref.index];
  if (d.ref.kind === 'events' ? note.type === position.lineIndex && note.time === position.time : note.lineIndex === position.lineIndex && (d.ref.kind !== 'notes' || note.lineLayer === position.lineLayer)) return;
  if (!d.pushed) { history.push(project); d.pushed = true; }
  if (d.ref.kind === 'events') { note.type = position.lineIndex; note.time = position.time ?? note.time; } else note.lineIndex = position.lineIndex; if (d.ref.kind === 'notes') note.lineLayer = position.lineLayer;
  diagnosticsDirty = true; draw(); renderInspector();
});
function finishSpatialDrag() {
  if (!spatialDrag) return false;
  const d = spatialDrag; spatialDrag = undefined; previewPress = undefined;
  if (preview.hasPointerCapture(d.pointerId)) preview.releasePointerCapture(d.pointerId);
  preview.classList.remove('dragging-note'); if (d.pushed) changed();
  return true;
}
preview.addEventListener('pointercancel', () => { finishSpatialDrag(); previewPress = undefined; });
preview.addEventListener('lostpointercapture', () => { finishSpatialDrag(); });
window.addEventListener('blur', () => { finishSpatialDrag(); previewPress = undefined; });
preview.addEventListener('pointerup', e => {
  if (finishSpatialDrag()) return;
  const press = previewPress; previewPress = undefined;
  if (!press || press.button === 2 || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
  const { x, y } = canvasPoint(e, preview);
  const target = spatialPreview?.pick(x, y, 'targets'), noteHit = spatialPreview?.pick(x, y, 'notes');
  // Clicking a target places at the playhead even when a future note is visible behind it.
  // A note already occupying this beat is selected instead of creating a duplicate.
  const atTarget = target ? items(project, target.kind).findIndex(n => Math.abs(n.time - (target.time ?? snap(beat, division))) < 1e-6 && (target.kind === 'events' ? n.type : n.lineIndex) === target.lineIndex && (target.kind !== 'notes' || n.lineLayer === target.lineLayer)) : -1;
  // A wide pedal covers several placement positions: its visible edges still select the pedal.
  const occupiedFoot = noteHit?.index !== undefined && (noteHit.kind === 'obstacles' && mode === 'notes' || (noteHit.kind === 'ringNotes' || noteHit.kind === 'obstacles') && items(project, noteHit.kind)[noteHit.index].time <= snap(beat, division) + 1e-6) ? noteHit : undefined;
  if (e.button === 0 && !e.altKey && !e.shiftKey && !press.shift && !occupiedFoot && noteHit?.kind !== 'events' && !(noteHit?.index !== undefined && items(project, noteHit.kind)[noteHit.index].groupId) && target && atTarget < 0) { add(target.kind, target.lineIndex, target.lineLayer, target.time ?? snap(beat, division), false, target.obstacleType); return; }
  const groupedHit = noteHit?.index !== undefined && items(project, noteHit.kind)[noteHit.index].groupId ? noteHit : undefined;
  const hit = (noteHit?.kind === 'events' ? noteHit : undefined) ?? groupedHit ?? occupiedFoot ?? (target && atTarget >= 0 ? { ...target, index: atTarget } : noteHit);
  if (hit?.index === undefined) { if (e.button === 0 && !e.shiftKey && !press.shift) select([]); return; }
  const ref = { kind: hit.kind, index: hit.index };
  if (e.button === 1) { e.preventDefault(); mutate(() => { const n = items(project, ref.kind)[ref.index]; if (n.type === 0 || n.type === 1) n.type = 1 - n.type; }); }
  else if (e.button === 0) {
    const exists = selected.some(s => s.kind === ref.kind && s.index === ref.index);
    select(e.shiftKey ? exists ? selected.filter(s => s.kind !== ref.kind || s.index !== ref.index) : [...selected, ref] : [ref]);
  }
});
preview.addEventListener('fill-selection', beginFill);
preview.addEventListener('group-selection', e => groupNotes((e as CustomEvent).detail?.action ?? 'create'));
preview.addEventListener('dblclick', e => { const { x, y } = canvasPoint(e, preview), hit = spatialPreview?.pick(x, y, 'notes'); if (hit?.index !== undefined) selectGroup({ kind: hit.kind, index: hit.index }); });
timeline.addEventListener('dblclick', e => { const { x, y } = canvasPoint(e, timeline), hit = timelineHit(x, y, view()); if (hit?.index !== undefined) selectGroup({ kind: hit.kind, index: hit.index }); });
function cycleSnap(delta: number) {
  if (!delta) return;
  const next = delta < 0 ? snapPresets.find(n => n > division + 1e-9) ?? 32 : [...snapPresets].reverse().find(n => n < division - 1e-9) ?? 1;
  setSnap(next);
}
let holdWheel = { index: -1, delta: 0, last: 0 };
preview.addEventListener('wheel', e => {
  e.preventDefault(); preview.focus({ preventScroll: true });
  // Normalize pixels, lines and pages. A typical wheel notch advances one snap interval;
  // high-resolution trackpads retain fractional progress rather than jumping a whole beat.
  const delta = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? preview.clientHeight : 1);
  if (e.ctrlKey) { cycleSnap(delta); return; }
  if (e.altKey) {
    const { x, y } = canvasPoint(e, preview), hit = spatialPreview?.pick(x, y, 'notes');
    if (hit?.kind !== 'ringNotes' || hit.index === undefined || spatialDrag) { holdWheel.index = -1; return; }
    const now = performance.now();
    if (holdWheel.index !== hit.index || now - holdWheel.last > 300 || Math.sign(delta) !== Math.sign(holdWheel.delta)) holdWheel = { index: hit.index, delta: 0, last: now };
    holdWheel.delta += delta; holdWheel.last = now;
    const ticks = Math.trunc(holdWheel.delta / 100); if (!ticks) return;
    holdWheel.delta -= ticks * 100;
    const note = items(project, 'ringNotes')[hit.index], previous = note.ringNoteType === 1 ? Number(note.duration ?? 0) : 0;
    const next = Math.max(0, Number((previous - ticks / division).toFixed(10)));
    const duration = next < 1e-9 ? 0 : next;
    if (duration === previous) return;
    stop(); mutate(() => { note.duration = duration; note.ringNoteType = duration > 0 ? 1 : 0; });
    return;
  }
  holdWheel.index = -1;
  if (delta) setBeat(Math.round((beat + (wheelReverse ? delta : -delta) / 100 / division) * 1e6) / 1e6);
}, { passive: false });
preview.addEventListener('contextmenu', e => e.preventDefault());
preview.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
function setDepthZoom(value: number) {
  const zoom = Math.max(.25, Math.min(10, value));
  scale = 48 * zoom; spatialPreview?.setDepthScale(zoom);
  $<HTMLInputElement>('depth-zoom').value = String(zoom); $('depth-zoom-value').textContent = `${zoom.toFixed(2)}×`;
  draw(); updateTransport();
}
$('depth-zoom').addEventListener('input', () => setDepthZoom(Number($<HTMLInputElement>('depth-zoom').value)));
function setPreviewRange(value: number) {
  $<HTMLInputElement>('preview-range').value = String(value);
  if (spatialPreview) spatialPreview.lookAhead = value;
  $('preview-range-value').textContent = `${value.toFixed(2)} 拍`; draw();
}
$('preview-range').addEventListener('input', () => setPreviewRange(Number($<HTMLInputElement>('preview-range').value)));
// Resolve a fresh hit when Delete is pressed; cached indices go stale after deletion or playback.
let pointerPosition: { x: number; y: number } | undefined;
window.addEventListener('pointermove', e => { pointerPosition = { x: e.clientX, y: e.clientY }; }, { capture: true });
window.addEventListener('pointerdown', e => { pointerPosition = { x: e.clientX, y: e.clientY }; }, { capture: true });
window.addEventListener('pointerout', e => { if (!e.relatedTarget) pointerPosition = undefined; });
function deleteHovered() {
  if (!pointerPosition) return false;
  const target = document.elementFromPoint(pointerPosition.x, pointerPosition.y);
  if (target !== preview && target !== timeline) return false;
  if (spatialDrag || drag || selectionBox) return true;
  const box = target.getBoundingClientRect(), x = pointerPosition.x - box.left, y = pointerPosition.y - box.top;
  const hit = target === preview ? spatialPreview?.pick(x, y, 'notes') : timelineHit(x, y * timelineHeight / box.height, view());
  if (hit?.index !== undefined) {
    const kind = hit.kind, index = hit.index;
    mutate(() => {
      const group = kind === 'notes' ? items(project, kind)[index].groupId : undefined;
      ensureItems(project, kind).splice(index, 1); if (group) repairGroups(project, new Set([group]));
      selected = selected.filter(s => s.kind !== kind || s.index !== index).map(s => s.kind === kind && s.index > index ? { ...s, index: s.index - 1 } : s);
    });
  }
  return true;
}
function setShiftHeld(value: boolean) { shiftHeld = value; document.body.classList.toggle('shift-held', value); }
window.addEventListener('keydown', e => { if (e.key === 'Shift') setShiftHeld(true); }, { capture: true });
window.addEventListener('keyup', e => { if (e.key === 'Shift') setShiftHeld(false); }, { capture: true });
window.addEventListener('blur', () => { setShiftHeld(false); pointerPosition = undefined; });
$('camera-near').addEventListener('click', () => spatialPreview?.zoomCamera(.85));
$('camera-far').addEventListener('click', () => spatialPreview?.zoomCamera(1 / .85));
function showTimeline(open: boolean) {
  $('scene-workspace').classList.toggle('timeline-open', open);
  const panel = $('timeline-panel'); panel.classList.toggle('is-collapsed', !open); panel.inert = !open;
  $('toggle-timeline').setAttribute('aria-expanded', String(open));
  $('toggle-timeline').classList.toggle('active', open);
  $('toggle-timeline').querySelector('span')!.textContent = open ? '传统时间轴 ↓' : '传统时间轴 ↑';
  $('toggle-timeline').title = open ? '向下收起传统时间轴' : '展开传统时间轴';
  if (!open && panel.contains(document.activeElement)) $('toggle-timeline').focus();
  draw(); updateTransport();
}
$('toggle-timeline').onclick = () => showTimeline($('timeline-panel').inert);
$('hide-timeline').onclick = () => showTimeline(false);
$('toggle-tools').onclick = () => {
  const body = $('tools-body'), open = body.hidden; body.hidden = !open;
  $('toggle-tools').textContent = open ? '−' : '＋';
  $('toggle-tools').setAttribute('aria-expanded', String(open));
  $('toggle-tools').setAttribute('aria-label', open ? '收起编辑工具' : '展开编辑工具');
};
// Keep the floating editor inside the 3D workspace, including after a browser resize.
const toolsPanel = $('tools-panel'), toolsHandle = $('tools-handle'), sceneWorkspace = $('scene-workspace');
let toolsDrag: { x: number; y: number; left: number; top: number } | undefined;
function positionTools(left: number, top: number) {
  const maxX = Math.max(8, sceneWorkspace.clientWidth - toolsPanel.offsetWidth - 8);
  const maxY = Math.max(8, preview.clientHeight - toolsPanel.offsetHeight - (sceneWorkspace.classList.contains('timeline-open') ? 12 : 88));
  toolsPanel.style.left = `${Math.max(8, Math.min(maxX, left))}px`;
  toolsPanel.style.top = `${Math.max(8, Math.min(maxY, top))}px`; toolsPanel.style.right = 'auto';
}
toolsHandle.addEventListener('pointerdown', e => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
  toolsDrag = { x: e.clientX, y: e.clientY, left: toolsPanel.offsetLeft, top: toolsPanel.offsetTop };
  toolsHandle.setPointerCapture(e.pointerId); e.preventDefault();
});
toolsHandle.addEventListener('pointermove', e => { if (toolsDrag) positionTools(toolsDrag.left + e.clientX - toolsDrag.x, toolsDrag.top + e.clientY - toolsDrag.y); });
toolsHandle.addEventListener('pointerup', () => { toolsDrag = undefined; });
toolsHandle.addEventListener('pointercancel', () => { toolsDrag = undefined; });
toolsHandle.addEventListener('dblclick', () => { toolsPanel.removeAttribute('style'); });
new ResizeObserver(() => { if (toolsPanel.style.left) positionTools(toolsPanel.offsetLeft, toolsPanel.offsetTop); }).observe(preview);
$('camera-reset').addEventListener('click', () => spatialPreview?.resetCamera());
// Mouse-operated controls return keyboard focus to the editor; text entry stays local.
function focusEditor() { if (!$<HTMLDialogElement>('modal').open) preview.focus({ preventScroll: true }); }
app.addEventListener('click', e => {
  const button = (e.target as HTMLElement).closest('button');
  if (button && !button.closest('dialog')) queueMicrotask(focusEditor);
});
app.addEventListener('change', e => {
  const control = e.target as HTMLElement;
  if (control.matches('select,input[type="range"],input[type="checkbox"]') && !control.closest('dialog')) queueMicrotask(focusEditor);
});
$('modal').addEventListener('close', focusEditor);
window.addEventListener('keydown', e => {
  const target = e.target as HTMLElement;
  if ($<HTMLDialogElement>('modal').open || target.isContentEditable || target.matches('textarea,input:not([type=range]):not([type=checkbox]):not([type=button])')) {
    if (e.key === 'Enter' && target.matches('input') && !$<HTMLDialogElement>('modal').open) { target.blur(); focusEditor(); }
    return;
  }
  if (target.matches('select') && e.code !== 'Space') return;
  if (e.ctrlKey || e.metaKey) { const key = e.key.toLowerCase(); if (key === 'c' && window.getSelection()?.toString()) return; if (['s', 'z', 'y', 'c', 'v', 'a', 'b', 'f'].includes(key)) e.preventDefault(); if (key === 's') void saveProject(); if (key === 'z') undo(e.shiftKey); if (key === 'y') undo(true); if (key === 'c') copy(); if (key === 'v') paste(); if (key === 'a') select(spatialPreview?.visibleSelections() ?? []); if (key === 'b' && !e.repeat) addBookmark(); if (key === 'f' && !e.repeat) mirror('left-right'); return; }
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) { focusEditor(); void togglePlay(); } }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (!e.repeat && !spatialDrag && !drag && !selectionBox) { if (selected.length) removeSelected(); else deleteHovered(); } }
  if (!e.altKey && !e.shiftKey && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); setMode((['notes', 'obstacles', 'events'] as const)[Number(e.key) - 1]); }
  if (e.key.toLowerCase() === 'q' && !e.altKey && !e.repeat) { e.preventDefault(); togglePlacementColor(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setBeat(snap(beat + (e.key === 'ArrowRight' ? 1 : -1) / division, division)); }
  if (e.key === 'Escape') select([]);
});
document.addEventListener('copy', e => { const text = window.getSelection()?.toString(); if (text && e.clipboardData) { e.clipboardData.setData('text/plain', text); e.preventDefault(); } });
const positionSceneControls = () => { const song = document.querySelector<HTMLElement>('.scene-song')!, controls = document.querySelector<HTMLElement>('.scene-camera')!; controls.style.top = `${song.getBoundingClientRect().bottom - sceneWorkspace.getBoundingClientRect().top + 12}px`; const hud = document.querySelector<HTMLElement>('.preview-hud'); if (hud) hud.style.top = `${controls.offsetTop + controls.offsetHeight + 8}px`; };
new ResizeObserver(positionSceneControls).observe(document.querySelector('.scene-song')!);
new ResizeObserver(positionSceneControls).observe(document.querySelector('.scene-camera')!);
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
new ResizeObserver(() => { draw(); updateTransport(); }).observe($('timeline-panel') ?? timeline.parentElement!);
new ResizeObserver(draw).observe(preview);
const loginErrorText: Record<string, string> = {
  missing_pico_credentials: '尚未配置 PICO_CLIENT_ID / PICO_CLIENT_SECRET。请在项目根目录的 .env 中填写，并在 PICO 开发者平台登记回调地址。',
  missing_code: '登录回调缺少授权码。请确认 SSO 重定向地址与 PICO_REDIRECT_URI 一致。',
  exchange_failed: 'PICO 换票失败。请确认开发者平台已登记回调 http://127.0.0.1:5173/api/auth/pico/callback，且与 .env 中的 PICO_REDIRECT_URI 完全一致。',
};
type PicoAccount = { openId: string; nickname: string; avatar: string };
function showAccount(user: PicoAccount) {
  const account = $('account'); account.hidden = false;
  $('account-name').textContent = user.nickname;
  const avatar = $<HTMLImageElement>('account-avatar');
  avatar.hidden = !user.avatar; if (user.avatar) avatar.src = user.avatar;
  iconsRefresh();
}
async function ensureLogin() {
  const me = await api<{ user: PicoAccount | null; loginRequired: boolean; configured: boolean }>('/api/auth/me');
  const params = new URLSearchParams(location.search);
  const code = params.get('login_error');
  if (me.user) { showAccount(me.user); enterEditor(); return true; }
  if (!me.loginRequired) { enterEditor(); return true; }
  if (code) {
    const error = $('login-error');
    error.hidden = false;
    error.textContent = loginErrorText[code] ?? `登录未完成：${code}`;
    window.history.replaceState(null, '', location.pathname);
  }
  $('login-gate').hidden = false;
  return false;
}
function enterEditor() {
  $('login-gate').hidden = true;
  document.body.classList.add('editor-ready');
  spatialPreview?.resize();
  draw();
}
$('logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); location.reload(); }
  catch (e: any) { notify('退出失败：' + e.message); }
});
async function init() {
  iconsRefresh(); renderSummary(); renderInspector(); draw(); requestAnimationFrame(frame);
  if (!(await ensureLogin())) return;
  try { songs = await api<Song[]>('/api/catalog'); renderLibrary();
    const draft = localStorage.getItem('ringmapper-draft');
    if (draft) {
      const data = JSON.parse(draft);
      modal('恢复上次工作', `<p>发现「${escape(data.project.info.songName)}」的浏览器草稿。是否继续编辑？</p><p class="field-help">草稿保存谱面数据；未保存的本地音频和封面需要重新导入。</p><div class="modal-actions"><button id="restore-draft" class="primary">恢复草稿</button><button id="skip-draft">打开曲库</button></div>`);
      $('restore-draft').onclick = () => { project = data.project; activeSong = songs.find(s => s.id === project.songId); savedSignature = ''; selected = []; changed(); renderLibrary(); renderInspector(); if (activeSong?.audio) void loadAudio(asset(activeSong.id, activeSong.audio)); $<HTMLDialogElement>('modal').close(); };
      $('skip-draft').onclick = () => { localStorage.removeItem('ringmapper-draft'); $<HTMLDialogElement>('modal').close(); void openSong(songs.find(s => s.id === 'caocao') ?? songs[0]); };
    } else if (songs.length) await openSong(songs.find(s => s.id === 'caocao') ?? songs[0]);
  } catch (e: any) { $('song-list').innerHTML = '<div class="empty-library">本地曲库暂不可用<br>仍可新建或导入 ZIP 编辑</div>'; notify(e.message); }
}
void init();

async function blobBase64(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); }); }

async function blobText(blob: Blob) { return decodeText(new Uint8Array(await blob.arrayBuffer())); }

function chartEntries() {
  const entries = new Map((activeSong?.charts ?? []).map(c => [c.path, c]));
  for (const filename of [...localAssets.keys(), project.chartPath]) {
    if (!/\.yaml$/i.test(filename) || filename === 'Info.yaml' || /Event\.yaml$/i.test(filename)) continue;
    entries.set(filename, { path: filename, eventPath: filename.replace(/\.yaml$/, 'Event.yaml'), mode: filename.split('/')[0], difficulty: filename.split('/').pop()!.replace(/RingDance|Ring|\.yaml/g, '') });
  }
  return [...entries.values()];
}
async function openLocalChart(filename: string) {
  try {
    updateMetadata(project); localAssets.set(project.chartPath, new Blob([writeYaml(project.chart)])); localAssets.set(project.eventPath, new Blob([writeYaml(project.event)]));
    const chart = readYaml(await blobText(localAssets.get(filename)!));
    const entry = [...(project.info.difficultyCiphermapSets ?? []), ...(project.info.difficultyBeatmapSets ?? [])].flatMap((s: any) => s.difficultyCiphermaps ?? s.difficultyBeatmaps ?? []).find((e: any) => (e.ciphermapFilename ?? e.beatmapFilename) === filename);
    const eventPath = entry?.eventmapFilename ?? filename.replace(/\.yaml$/, 'Event.yaml');
    const event = localAssets.has(eventPath) ? readYaml(await blobText(localAssets.get(eventPath)!)) : { version: chart.version, events: [] };
    stop(); project.chart = chart; project.event = event; project.chartPath = filename; project.eventPath = eventPath; selected = []; history.clear();
    if (project.songId) project.revision = (await api<{ revision: string }>(`/api/revision?song=${encodeURIComponent(project.songId)}&chart=${encodeURIComponent(filename)}&event=${encodeURIComponent(eventPath)}`)).revision;
    changed(); renderInspector();
  } catch (e: any) { notify('切换难度失败：' + e.message); }
}
