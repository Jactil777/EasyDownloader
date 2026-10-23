const $ = selector => document.querySelector(selector);
const elements = {
  urls: $('#urls'), urlCount: $('#urlCount'), folderPath: $('#folderPath'),
  chooseFolder: $('#chooseFolder'), chooseCookies: $('#chooseCookies'), clearCookies: $('#clearCookies'), cookieFilePath: $('#cookieFilePath'),
  pasteButton: $('#pasteButton'), downloadButton: $('#downloadButton'),
  openFolder: $('#openFolder'), taskList: $('#taskList'), emptyState: $('#emptyState'),
  taskSummary: $('#taskSummary'), toolWarning: $('#toolWarning'), toast: $('#toast')
};
let config = {};

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作失败');
  return value;
}

function refreshCount() {
  const count = elements.urls.value.split(/\r?\n/).filter(value => value.trim()).length;
  elements.urlCount.textContent = `${count} / 10`;
  elements.urlCount.style.color = count > 10 ? '#fb7185' : '';
}

function settings() {
  return {
    downloadDirectory: config.downloadDirectory,
    cookieFilePath: config.cookieFilePath || ''
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function renderTasks(tasks) {
  elements.emptyState.hidden = tasks.length > 0;
  elements.taskList.innerHTML = tasks.slice().reverse().map(task => {
    const running = !['complete', 'error', 'cancelled'].includes(task.status);
    const icon = task.status === 'complete' ? '✓' : task.status === 'error' ? '!' : task.status === 'cancelled' ? '×' : '↓';
    const engineName = task.engine === '微信视频号 / 腾讯元宝' ? '微信视频号 / 元宝' : task.engine || '等待';
    const statusName = ({ queued: '排队中', starting: '启动中', downloading: '下载中', 'waiting-login': '等待登录', complete: '已完成', error: '失败', cancelled: '已取消' })[task.status] || task.status;
    const logs = Array.isArray(task.logs) ? task.logs : [];
    return `<article class="task ${escapeHtml(task.status)}">
      <div class="task-top"><div class="task-status">${icon}</div><div class="task-info">
      <div class="task-url" title="${escapeHtml(task.url)}">${escapeHtml(task.url)}</div>
      <div class="task-meta">${escapeHtml(engineName)} · ${escapeHtml(statusName)}</div></div>
      ${running ? `<button class="cancel-button" data-cancel="${task.id}">取消</button>` : ''}</div>
      <div class="progress-track"><i style="width:${Number(task.progress) || 0}%"></i></div>
      <div class="task-message" title="${escapeHtml(task.message)}">${escapeHtml(task.message)}</div>
      ${logs.length ? `<details class="task-log"><summary>查看详细日志 (${logs.length})</summary><pre>${escapeHtml(logs.join('\n'))}</pre></details>` : ''}</article>`;
  }).join('');
  const active = tasks.filter(task => !['complete', 'error', 'cancelled'].includes(task.status)).length;
  elements.taskSummary.textContent = tasks.length ? `${tasks.length} 个任务${active ? `, ${active} 个进行中` : ''}` : '还没有任务';
}

async function init() {
  try {
    const data = await api('/api/config');
    config = data.config;
    elements.folderPath.textContent = config.downloadDirectory;
    elements.cookieFilePath.textContent = config.cookieFilePath || '需要登录的网站, 请先在浏览器登录并导出 cookies.txt';
    elements.clearCookies.hidden = !config.cookieFilePath;
    const missing = Object.entries(data.tools).filter(([name, ready]) => name !== 'wechatChannels' && !ready).map(([name]) => ({ ytDlp: 'yt-dlp', galleryDl: 'gallery-dl', ffmpeg: 'FFmpeg' })[name]);
    if (missing.length) {
      elements.toolWarning.hidden = false;
      elements.toolWarning.textContent = `尚未安装 ${missing.join(', ')}. 请先运行 install-tools.ps1.`;
    }
    if (!data.tools.wechatChannels) {
      elements.toolWarning.hidden = false;
      elements.toolWarning.textContent = `${missing.length ? `尚未安装 ${missing.join(', ')}. ` : ''}微信视频号支持尚未安装. 请运行一次 install-tools.ps1 后重启.`;
    }
    const events = new EventSource('/api/events');
    events.onmessage = event => renderTasks(JSON.parse(event.data));
  } catch (error) { toast(error.message); }
}

elements.urls.addEventListener('input', refreshCount);
elements.pasteButton.addEventListener('click', async () => {
  try { elements.urls.value = await navigator.clipboard.readText(); refreshCount(); }
  catch { toast('浏览器没有授予剪贴板权限, 请手动粘贴'); }
});
elements.chooseFolder.addEventListener('click', async () => {
  try {
    const result = await api('/api/select-folder', { method: 'POST', body: '{}' });
    if (result.path) { config.downloadDirectory = result.path; elements.folderPath.textContent = result.path; }
  } catch (error) { toast(error.message); }
});
elements.chooseCookies.addEventListener('click', async () => {
  try {
    const result = await api('/api/select-cookies', { method: 'POST', body: '{}' });
    if (result.path) {
      config.cookieFilePath = result.path;
      elements.cookieFilePath.textContent = result.path;
      elements.clearCookies.hidden = false;
      toast('Cookie 文件已设置, 文件仅保存在本机');
    }
  } catch (error) { toast(error.message); }
});
elements.clearCookies.addEventListener('click', () => {
  config.cookieFilePath = '';
  elements.cookieFilePath.textContent = '需要登录的网站, 请先在浏览器登录并导出 cookies.txt';
  elements.clearCookies.hidden = true;
  toast('已取消使用 Cookie 文件');
});
elements.downloadButton.addEventListener('click', async () => {
  if (!elements.urls.value.trim()) return toast('请先粘贴一个链接');
  elements.downloadButton.disabled = true;
  try {
    await api('/api/downloads', { method: 'POST', body: JSON.stringify({ urls: elements.urls.value, settings: settings() }) });
    elements.urls.value = '';
    refreshCount();
    toast('任务已加入下载队列');
  } catch (error) { toast(error.message); }
  finally { elements.downloadButton.disabled = false; }
});
elements.openFolder.addEventListener('click', () => api('/api/open-folder', { method: 'POST', body: '{}' }).catch(error => toast(error.message)));
elements.taskList.addEventListener('click', event => {
  const id = event.target.dataset.cancel;
  if (id) api(`/api/tasks/${id}/cancel`, { method: 'POST', body: '{}' }).catch(error => toast(error.message));
});

refreshCount();
$('#copyrightYear').textContent = new Date().getFullYear();
init();
