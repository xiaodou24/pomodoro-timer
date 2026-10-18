/* =========================================================
 * 番茄钟 · 纯静态前端逻辑
 * 零后端、零 AI 调用、零联网：全部在本地浏览器运行
 * 数据保存在浏览器 localStorage，音频由 Web Audio 本地合成
 * ========================================================= */

/* ============== 1. 状态与常量 ============== */
let mode = 'countdown';        // countdown=倒计时 | stopwatch=累计
let running = false;           // 计时会话进行中（含暂停态）
let paused = false;            // 是否暂停
let totalSeconds = 25 * 60;    // 倒计时剩余秒
let elapsedSeconds = 0;        // 累计已专注秒
let timerId = null;            // 每秒计时器
let audioType = 'off';         // off | forest | rain | piano
let noiseNodes = null;         // 白噪音节点引用（用于停止）
let pianoTimer = null;         // 钢琴音符定时器
let audioCtx = null;           // Web Audio 上下文
let statRange = 'today';       // 统计时间范围
let statTag = '';              // 统计标签筛选

const KEY_PROJECTS = 'pt2_projects';   // 大项目（含子任务、标签）
const KEY_RECORDS  = 'pt2_records';    // 专注记录
const KEY_NOTES    = 'pt2_notes';      // 心得笔记

/* ============== 2. 本地存储工具 ============== */
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch(e){ return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const loadProjects = () => load(KEY_PROJECTS, []);
const loadRecords  = () => load(KEY_RECORDS, []);
const loadNotes    = () => load(KEY_NOTES, []);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ============== 3. 通用工具 ============== */
const $ = id => document.getElementById(id);
// 转义用户输入，避免 HTML 注入
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// 日期字符串 YYYY-MM-DD（本地时区）
function dayStr(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
const todayStr = () => dayStr(new Date());
// 时长显示：X 小时 Y 分钟
function fmtDur(sec){
  const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60);
  return h > 0 ? (h + ' 小时 ' + m + ' 分钟') : (m + ' 分钟');
}

/* ============== 4. 背景切换（猫咪 / 书桌） ============== */
$('btnBg').onclick = () => {
  const cur = document.body.classList.contains('bg-desk');
  document.body.classList.toggle('bg-desk', !cur);
  $('btnBg').textContent = cur ? '🐱 切换背景' : '🌿 切换背景';
};

/* ============== 5. Tab 面板切换 ============== */
document.querySelectorAll('.tabs button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
    ['timer','tasks','stats','notes'].forEach(p => {
      $('panel-' + p).classList.toggle('hidden', p !== btn.dataset.panel);
    });
    // 进入任务/统计/笔记页时刷新数据
    if (btn.dataset.panel === 'tasks') renderProjects();
    if (btn.dataset.panel === 'stats') renderStats();
    if (btn.dataset.panel === 'notes') renderNotes();
  };
});

/* =========================================================
 * 6. 任务分级：大项目 + 子任务 + 标签
 * ========================================================= */
// 新建大项目
$('btnAddProj').onclick = () => {
  const name = $('projInput').value.trim();
  if (!name) { alert('请输入大项目名称'); return; }
  // 拆分标签：逗号（中英文）分隔，去空去重
  const tags = [...new Set($('tagInput').value.trim().split(/[,，]/).map(t => t.trim()).filter(Boolean))];
  const projs = loadProjects();
  if (projs.some(p => p.name === name)) { alert('该项目已存在'); return; }
  projs.push({ id: uid(), name, tags, tasks: [], createdAt: Date.now() });
  save(KEY_PROJECTS, projs);
  $('projInput').value = ''; $('tagInput').value = '';
  renderProjects(); refreshSelects();
};
// 快捷标签：点选追加到标签输入框
document.querySelectorAll('.qtag').forEach(b => {
  b.onclick = () => {
    const cur = $('tagInput').value;
    const arr = cur.split(/[,，]/).map(t => t.trim()).filter(Boolean);
    if (!arr.includes(b.dataset.tag)) arr.push(b.dataset.tag);
    $('tagInput').value = arr.join(',');
  };
});
// 删除大项目（历史记录保留）
function removeProject(id){
  if (!confirm('确定删除这个大项目及其全部子任务吗？历史专注记录会保留。')) return;
  save(KEY_PROJECTS, loadProjects().filter(p => p.id !== id));
  renderProjects(); refreshSelects();
}
// 添加子任务
function addSubtask(pid, name){
  const projs = loadProjects();
  const p = projs.find(x => x.id === pid);
  if (!p) return;
  p.tasks.push({ id: uid(), name, done: false });
  save(KEY_PROJECTS, projs);
  renderProjects();
}
// 切换子任务完成状态
function toggleSubtask(pid, tid){
  const projs = loadProjects();
  const p = projs.find(x => x.id === pid);
  const t = p && p.tasks.find(x => x.id === tid);
  if (!t) return;
  t.done = !t.done;
  save(KEY_PROJECTS, projs);
  renderProjects();
}
// 删除子任务
function removeSubtask(pid, tid){
  const projs = loadProjects();
  const p = projs.find(x => x.id === pid);
  if (!p) return;
  p.tasks = p.tasks.filter(x => x.id !== tid);
  save(KEY_PROJECTS, projs);
  renderProjects();
}
// 渲染大项目列表（支持按大项目筛选子任务）
function renderProjects(){
  const projs = loadProjects();
  const filterVal = $('projFilter').value;
  const list = $('projList');
  if (projs.length === 0) {
    list.innerHTML = '<div class="card"><div class="empty">还没有大项目，先在上面创建一个吧～</div></div>';
    return;
  }
  list.innerHTML = '';
  projs.forEach(p => {
    if (filterVal && p.id !== filterVal) return;   // 筛选：只显示选中的大项目
    const doneCount = p.tasks.filter(t => t.done).length;
    const card = document.createElement('div');
    card.className = 'card proj-card';
    card.innerHTML =
      '<div class="proj-head">' +
        '<div class="proj-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="proj-tags">' + (p.tags || []).map(t => '<span class="proj-tag">' + escapeHtml(t) + '</span>').join('') + '</div>' +
        '<button class="del-proj">✕</button>' +
      '</div>' +
      '<div class="progress">子任务 ' + doneCount + ' / ' + p.tasks.length + ' 已完成</div>' +
      '<div class="sub-list">' +
        (p.tasks.length === 0 ? '<div class="empty" style="padding:8px 0;">暂无子任务</div>' : '') +
        p.tasks.map(t =>
          '<div class="sub-item' + (t.done ? ' done' : '') + '">' +
            '<input type="checkbox" ' + (t.done ? 'checked' : '') + ' data-act="toggle" data-tid="' + t.id + '">' +
            '<span class="sub-name">' + escapeHtml(t.name) + '</span>' +
            '<button class="del-sub" data-act="delSub" data-tid="' + t.id + '">✕</button>' +
          '</div>'
        ).join('') +
      '</div>' +
      '<div class="add-sub">' +
        '<input placeholder="添加子任务，回车确认" maxlength="20">' +
        '<button>＋</button>' +
      '</div>';
    // 子任务勾选 / 删除
    card.querySelectorAll('.sub-item').forEach(item => {
      item.querySelector('input').onchange = () => toggleSubtask(p.id, item.querySelector('input').dataset.tid);
      item.querySelector('.del-sub').onclick = () => removeSubtask(p.id, item.querySelector('.del-sub').dataset.tid);
    });
    // 添加子任务
    const inp = card.querySelector('.add-sub input');
    const addBtn = card.querySelector('.add-sub button');
    const doAdd = () => { const v = inp.value.trim(); if (v) { addSubtask(p.id, v); } };
    addBtn.onclick = doAdd;
    inp.onkeydown = e => { if (e.key === 'Enter') doAdd(); };
    // 删除大项目
    card.querySelector('.del-proj').onclick = () => removeProject(p.id);
    list.appendChild(card);
  });
  if (list.children.length === 0) list.innerHTML = '<div class="card"><div class="empty">该大项目下没有内容</div></div>';
}

/* =========================================================
 * 7. 计时下拉选择：大项目 / 子任务
 * ========================================================= */
function refreshSelects(){
  const projs = loadProjects();
  // 大项目下拉（计时面板）
  const ps = $('projSelect');
  const curProj = ps.value;
  ps.innerHTML = '<option value="">未选择大项目</option>' +
    projs.map(p => '<option value="' + p.id + '"' + (p.id === curProj ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
  // 子任务下拉：跟随大项目
  const ts = $('taskSelect');
  const curTask = ts.value;
  const p = projs.find(x => x.id === ps.value);
  ts.innerHTML = '<option value="">子任务 · 通用</option>' +
    (p ? p.tasks.map(t => '<option value="' + t.id + '"' + (t.id === curTask ? ' selected' : '') + '>' + escapeHtml(t.name) + '</option>').join('') : '');
  // 统计面板下拉（用于展示渲染，筛选）
  const pf = $('projFilter');
  const curFilter = pf.value;
  pf.innerHTML = '<option value="">全部大项目</option>' +
    projs.map(p => '<option value="' + p.id + '"' + (p.id === curFilter ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
}
$('projSelect').onchange = refreshSelects;   // 切换大项目时刷新子任务下拉

/* =========================================================
 * 8. 计时逻辑（倒计时 / 累计）
 * ========================================================= */
function renderTime(){
  const secs = mode === 'countdown' ? totalSeconds : elapsedSeconds;
  const h = Math.floor(secs/3600), m = Math.floor(secs%3600/60), s = secs%60;
  const mm = String(m).padStart(2,'0'), ss = String(s).padStart(2,'0');
  $('timeDisplay').innerHTML = h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
}
// 当前选中的记录归属（大项目名 / 子任务名 / 标签）
function currentTarget(){
  const projs = loadProjects();
  const p = projs.find(x => x.id === $('projSelect').value);
  const t = p && p.tasks.find(x => x.id === $('taskSelect').value);
  return {
    project: p ? p.name : '',
    subtask: t ? t.name : '',
    tags: p && p.tags ? p.tags.slice() : []
  };
}
// 保存一条专注记录
function saveRecord(sec){
  if (sec <= 0) return;
  const t = currentTarget();
  const recs = loadRecords();
  recs.push({
    project: t.project || '未分类',
    subtask: t.subtask,
    tags: t.tags,
    sec: Math.round(sec),
    date: todayStr(),
    ts: Date.now()
  });
  save(KEY_RECORDS, recs);
}
// 每秒心跳
function tick(){
  if (mode === 'countdown') {
    totalSeconds--;
    renderTime();
    if (totalSeconds <= 0) finishCountdown();
  } else {
    elapsedSeconds++;
    renderTime();
  }
}
// 倒计时完成：保存记录 + 提示音 + 停止音频
function finishCountdown(){
  clearInterval(timerId);
  running = false; paused = false;
  const dur = Math.max(1, parseInt($('minInput').value || '25', 10)) * 60;
  saveRecord(dur);
  totalSeconds = dur;
  renderTime();
  stopAudio();
  playChime();
  updateButtons();
}
// 开始 / 继续
$('btnStart').onclick = () => {
  if (running && !paused) return;
  if (mode === 'countdown' && totalSeconds <= 0)
    totalSeconds = Math.max(1, parseInt($('minInput').value || '25', 10)) * 60;
  running = true; paused = false;
  timerId = setInterval(tick, 1000);
  updateButtons();
  if (audioType !== 'off') startAudio(audioType);   // 恢复/开启音频
};
// 暂停：计时与音频同步暂停
$('btnPause').onclick = () => {
  if (!running || paused) return;
  paused = true;
  clearInterval(timerId);
  stopAudio();
  updateButtons();
};
// 重置：累计模式先保存已累计的专注段，再清零
$('btnReset').onclick = () => {
  clearInterval(timerId);
  running = false; paused = false;
  if (mode === 'stopwatch' && elapsedSeconds > 0) saveRecord(elapsedSeconds);
  elapsedSeconds = 0;
  totalSeconds = Math.max(1, parseInt($('minInput').value || '25', 10)) * 60;
  renderTime();
  stopAudio();
  updateButtons();
};
// 倒计时模式修改分钟：未计时时立即生效
$('minInput').oninput = () => {
  let v = parseInt($('minInput').value || '1', 10);
  if (v < 1) v = 1;
  if (v > 180) v = 180;
  $('minInput').value = v;
  if (!running && mode === 'countdown') { totalSeconds = v * 60; renderTime(); }
};

/* ============== 9. 模式切换 ============== */
function switchMode(m){
  mode = m;
  $('modeCountdown').classList.toggle('active', m === 'countdown');
  $('modeStopwatch').classList.toggle('active', m === 'stopwatch');
  clearInterval(timerId); running = false; paused = false;
  stopAudio();
  $('setRow').style.display = m === 'countdown' ? 'flex' : 'none';
  if (m === 'countdown') totalSeconds = Math.max(1, parseInt($('minInput').value || '25', 10)) * 60;
  else elapsedSeconds = 0;
  renderTime();
  updateButtons();
}
$('modeCountdown').onclick = () => switchMode('countdown');
$('modeStopwatch').onclick = () => switchMode('stopwatch');

/* =========================================================
 * 10. 音频：森林白噪音 / 雨声白噪音 / 钢琴轻音乐
 *     全部用 Web Audio 本地合成，无任何音频文件与联网
 * ========================================================= */
function getCtx(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// 钢琴：柔和琶音（正弦波随机 C 大调音符）
function playPianoNote(){
  const ctx = getCtx();
  const notes = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25];
  const freq = notes[Math.floor(Math.random() * notes.length)];
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.06, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t); osc.stop(t + 2.3);
}
// 白噪音：森林=低频沙沙，雨声=中高频淅沥
function startNoise(type){
  const ctx = getCtx();
  const bufferSize = ctx.sampleRate * 4;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer; src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = type === 'forest' ? 500 : 1400;
  const gain = ctx.createGain();
  gain.gain.value = type === 'forest' ? 0.14 : 0.10;
  src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  src.start();
  noiseNodes = { src, gain };
}
// 启动当前音频类型
function startAudio(type){
  stopAudio();
  if (type === 'piano') {
    playPianoNote();
    pianoTimer = setInterval(playPianoNote, 2000);
  } else if (type === 'forest' || type === 'rain') {
    startNoise(type);
  }
}
// 停止音频（白噪音做快速淡出避免咔哒声）
function stopAudio(){
  if (pianoTimer) { clearInterval(pianoTimer); pianoTimer = null; }
  if (noiseNodes) {
    try {
      const ctx = audioCtx;
      const t = ctx.currentTime;
      noiseNodes.gain.gain.setTargetAtTime(0, t, 0.02);
      noiseNodes.src.stop(t + 0.2);
    } catch(e) {}
    noiseNodes = null;
  }
}
// 音频类型 chips：选择即切换（计时进行中立即生效；暂停/不计时不出声）
document.querySelectorAll('.audio-btn').forEach(btn => {
  btn.onclick = () => {
    audioType = btn.dataset.audio;
    document.querySelectorAll('.audio-btn').forEach(b => b.classList.toggle('active', b === btn));
    stopAudio();
    if (running && !paused && audioType !== 'off') startAudio(audioType);
  };
});

/* ============== 11. 结束提示音（轻柔两声叮） ============== */
function playChime(){
  const ctx = getCtx();
  [[659.25, 0], [880.00, 0.35]].forEach(([freq, delay]) => {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t); osc.stop(t + 1.5);
  });
}

/* ============== 12. 按钮状态 ============== */
function updateButtons(){
  $('btnStart').disabled = running && !paused;
  $('btnPause').disabled = !(running && !paused);
}

/* =========================================================
 * 13. 数据统计：今日 / 本周 / 本月 + 标签筛选 + 导出
 * ========================================================= */
// 时间范围起点（字符串可比较）
function rangeStart(range){
  const now = new Date();
  if (range === 'today') return todayStr();
  if (range === 'week') {
    const d = new Date(now);
    const day = (now.getDay() + 6) % 7;   // 周一起
    d.setDate(now.getDate() - day);
    return dayStr(d);
  }
  return dayStr(new Date(now.getFullYear(), now.getMonth(), 1)); // 本月1号
}
function renderStats(){
  const rangeLabel = { today:'今日总专注', week:'本周总专注', month:'本月总专注' };
  $('rangeLabel').textContent = rangeLabel[statRange];
  const start = rangeStart(statRange);
  const end = todayStr();
  let recs = loadRecords().filter(r => r.date >= start && r.date <= end);
  if (statTag) recs = recs.filter(r => (r.tags || []).includes(statTag));
  // 总时长
  const total = recs.reduce((a, b) => a + b.sec, 0);
  $('totalTime').textContent = fmtDur(total);
  // 分项目统计（按大项目分组）
  const byProj = {};
  recs.forEach(r => { byProj[r.project] = (byProj[r.project] || 0) + r.sec; });
  const list = $('statList');
  if (recs.length === 0) {
    list.innerHTML = '<div class="empty">该范围内还没有专注记录</div>';
    return;
  }
  list.innerHTML = '';
  Object.entries(byProj).sort((a, b) => b[1] - a[1]).forEach(([name, sec]) => {
    const div = document.createElement('div');
    div.className = 'stat-item';
    div.innerHTML = '<span class="si-name">' + escapeHtml(name) + '</span><b>' + fmtDur(sec) + '</b>';
    list.appendChild(div);
  });
}
// 时间范围 Tab
document.querySelectorAll('.stat-tabs button').forEach(btn => {
  btn.onclick = () => {
    statRange = btn.dataset.range;
    document.querySelectorAll('.stat-tabs button').forEach(b => b.classList.toggle('active', b === btn));
    renderStats();
  };
});
// 标签筛选 chips（从项目与记录中收集所有标签）
function renderStatTags(){
  const tags = new Set();
  loadProjects().forEach(p => (p.tags || []).forEach(t => tags.add(t)));
  loadRecords().forEach(r => (r.tags || []).forEach(t => tags.add(t)));
  const box = $('statTagChips');
  box.innerHTML = '<button class="tag-chip' + (statTag === '' ? ' active' : '') + '" data-tag="">全部</button>' +
    [...tags].map(t => '<button class="tag-chip' + (statTag === t ? ' active' : '') + '" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>').join('');
  box.querySelectorAll('.tag-chip').forEach(btn => {
    btn.onclick = () => {
      statTag = btn.dataset.tag;
      renderStatTags();
      renderStats();
    };
  });
}
// 一键导出学习记录文本
$('btnExport').onclick = () => {
  const recs = loadRecords().slice().sort((a, b) => b.ts - a.ts);
  const projs = loadProjects();
  const notes = loadNotes();
  const lines = [];
  lines.push('🍅 番茄钟学习记录导出');
  lines.push('导出时间：' + new Date().toLocaleString('zh-CN'));
  lines.push('');
  // 统计摘要
  ['today','week','month'].forEach(rg => {
    const start = rangeStart(rg);
    const inRange = recs.filter(r => r.date >= start && r.date <= todayStr());
    const total = inRange.reduce((a, b) => a + b.sec, 0);
    const byProj = {};
    inRange.forEach(r => { byProj[r.project] = (byProj[r.project] || 0) + r.sec; });
    const label = rg === 'today' ? '今日' : (rg === 'week' ? '本周' : '本月');
    lines.push('【' + label + '】总专注：' + fmtDur(total));
    Object.entries(byProj).forEach(([n, s]) => lines.push('  · ' + n + '：' + fmtDur(s)));
    lines.push('');
  });
  // 专注明细
  lines.push('===== 专注明细（新→旧） =====');
  if (recs.length === 0) lines.push('（暂无记录）');
  recs.forEach(r => {
    const d = new Date(r.ts);
    const hm = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    lines.push('[' + r.date + ' ' + hm + '] ' + r.project + (r.subtask ? ' / ' + r.subtask : '') +
      ((r.tags && r.tags.length) ? '（' + r.tags.join('、') + '）' : '') + '：' + fmtDur(r.sec));
  });
  lines.push('');
  // 任务列表
  lines.push('===== 任务清单 =====');
  if (projs.length === 0) lines.push('（暂无任务）');
  projs.forEach(p => {
    lines.push('【' + p.name + '】' + ((p.tags && p.tags.length) ? '标签：' + p.tags.join('、') : ''));
    p.tasks.forEach(t => lines.push('  - [' + (t.done ? 'x' : ' ') + '] ' + t.name));
  });
  lines.push('');
  // 心得笔记
  lines.push('===== 心得笔记 =====');
  if (notes.length === 0) lines.push('（暂无笔记）');
  notes.forEach(n => lines.push('[' + new Date(n.ts).toLocaleString('zh-CN') + '] ' + n.text));
  // 下载 .txt
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '番茄钟学习记录_' + todayStr() + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
};

/* =========================================================
 * 14. 心得感悟笔记
 * ========================================================= */
$('btnSaveNote').onclick = () => {
  const text = $('noteInput').value.trim();
  if (!text) { alert('请输入笔记内容'); return; }
  const notes = loadNotes();
  notes.push({ id: uid(), text, ts: Date.now() });
  save(KEY_NOTES, notes);
  $('noteInput').value = '';
  renderNotes();
};
function removeNote(id){
  save(KEY_NOTES, loadNotes().filter(n => n.id !== id));
  renderNotes();
}
function renderNotes(){
  const notes = loadNotes().sort((a, b) => b.ts - a.ts);
  const list = $('noteList');
  if (notes.length === 0) {
    list.innerHTML = '<div class="empty">还没有笔记，记录第一条心得吧～</div>';
    return;
  }
  list.innerHTML = '';
  notes.forEach(n => {
    const div = document.createElement('div');
    div.className = 'note-item';
    div.innerHTML =
      '<div class="note-head">' +
        '<span class="note-time">' + new Date(n.ts).toLocaleString('zh-CN') + '</span>' +
        '<button class="del-note">✕</button>' +
      '</div>' +
      '<div class="note-text">' + escapeHtml(n.text) + '</div>';
    div.querySelector('.del-note').onclick = () => removeNote(n.id);
    list.appendChild(div);
  });
}

/* =========================================================
 * 15. 初始化
 * ========================================================= */
renderTime();
updateButtons();
refreshSelects();
renderProjects();
renderStatTags();
renderStats();
renderNotes();
