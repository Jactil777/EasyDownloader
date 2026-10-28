import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, 'web');
const TOOLS = process.env.EASY_DOWNLOADER_TOOLS_DIR || path.join(ROOT, 'tools');
const WX_TOOL = path.join(TOOLS, 'wx-downloader', 'bin', 'wx-downloader.exe');
const DATA_DIR = process.env.EASY_DOWNLOADER_DATA_DIR || ROOT;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'task-history.json');
const PORT = Number(process.env.LOCAL_DOWNLOADER_PORT || 8765);
const HOST = '127.0.0.1';
const tasks = new Map();
const clients = new Set();
const HISTORY_LIMIT = 200;
let historySaveTimer;
let isShuttingDown = false;
const WX_HOME = path.join(process.env.LOCALAPPDATA || ROOT, 'LocalDownloader', 'wx-channels');

const defaults = {
  downloadDirectory: path.join(process.env.USERPROFILE || ROOT, 'Downloads', 'Reference'),
  cookieFilePath: ''
};

function readConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...defaults, downloadDirectory: saved.downloadDirectory || defaults.downloadDirectory, cookieFilePath: saved.cookieFilePath || '' };
  }
  catch { return { ...defaults }; }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 128 * 1024) reject(new Error('Request is too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')) }
    });
    req.on('error', reject);
  });
}

function publicTask(task) {
  const { process: _process, fallbackUsed: _fallbackUsed, ...safe } = task;
  return safe;
}

function pruneTaskHistory() {
  const finished = [...tasks.values()].filter(task => ['complete', 'error', 'cancelled'].includes(task.status));
  for (const task of finished.slice(0, Math.max(0, finished.length - HISTORY_LIMIT))) tasks.delete(task.id);
}

function saveTaskHistoryNow() {
  pruneTaskHistory();
  const all = [...tasks.values()];
  const active = all.filter(task => !['complete', 'error', 'cancelled'].includes(task.status));
  const finished = all.filter(task => ['complete', 'error', 'cancelled'].includes(task.status)).slice(-HISTORY_LIMIT);
  const snapshot = [...finished, ...active].map(({ process: _process, ...task }) => task);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temporary = `${HISTORY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(snapshot), 'utf8');
    fs.renameSync(temporary, HISTORY_FILE);
  } catch (error) {
    console.error(`Could not save task history: ${error.message}`);
  }
}

function saveTaskHistory() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    saveTaskHistoryNow();
  }, 250);
  historySaveTimer.unref?.();
}

function loadTaskHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(saved)) return;
    for (const task of saved.slice(-HISTORY_LIMIT)) {
      if (!task || typeof task.id !== 'string' || typeof task.url !== 'string') continue;
      if (!['complete', 'error', 'cancelled'].includes(task.status)) {
        task.status = 'error';
        task.message = '应用关闭前任务未完成';
        task.errorHint = task.message;
        task.finishedAt = new Date().toISOString();
        task.logs = [...(Array.isArray(task.logs) ? task.logs : []), 'Task interrupted when EasyDownloader closed.'].slice(-160);
      }
      tasks.set(task.id, task);
    }
    if (saved.some(task => task && !['complete', 'error', 'cancelled'].includes(task.status))) saveTaskHistory();
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not load task history: ${error.message}`);
  }
}

function broadcast() {
  pruneTaskHistory();
  const payload = `data: ${JSON.stringify([...tasks.values()].map(publicTask))}\n\n`;
  for (const client of clients) client.write(payload);
  saveTaskHistory();
}

loadTaskHistory();

function executable(name) {
  const local = path.join(TOOLS, `${name}.exe`);
  return fs.existsSync(local) ? local : `${name}.exe`;
}

function validUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch { return false; }
}

const galleryHosts = [
  'instagram.com', 'pinterest.com', 'pin.it', 'x.com', 'twitter.com',
  'flickr.com', 'deviantart.com', 'imgur.com', 'xiaohongshu.com'
];

function isGalleryUrl(value) {
  const host = new URL(value).hostname.replace(/^www\./, '');
  return galleryHosts.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function isWeixinChannelsUrl(value) {
  const parsed = new URL(value);
  return ['weixin.qq.com', 'www.weixin.qq.com'].includes(parsed.hostname.toLowerCase())
    && parsed.pathname.startsWith('/sph/');
}

function isDirectUrl(value) {
  return /\.(?:jpe?g|png|gif|webp|svg|bmp|tiff?|mp4|webm|mov|m4v|mkv|avi|mp3|m4a|wav|flac|aac|ogg|pdf|zip|rar|7z|tar|gz|txt|csv|docx?|xlsx?|pptx?|epub|exe|msi)(?:$|[?#])/i.test(value);
}

function qualityFormat() {
  return 'bestvideo+bestaudio/best';
}

function appendLog(task, engine, line) {
  const clean = String(line).replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!clean) return;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = `[${time}] [${engine}] ${clean}`;
  task.logs ??= [];
  task.logs.push(entry);
  if (task.logs.length > 160) task.logs.shift();
  console.log(`[${task.id.slice(0, 8)}] ${entry}`);
}

function friendlyError(detail, task) {
  const text = String(detail || '');
  const isBilibili = /(?:bilibili\.com|b23\.tv)/i.test(task.url);
  if (/wx-downloader\.exe|wx-downloader.*not found|视频号支持组件未安装/i.test(text)) {
    return '微信视频号组件尚未安装. 请在项目目录运行 install-tools.ps1, 完成后重启本程序.';
  }
  if (/元宝.*登录|hy_user|hy_token|请运行 wx-downloader login|等待登录超时/i.test(text)) {
    return '元宝登录未完成或已过期. 请在弹出的元宝窗口完成登录, 然后重新下载.';
  }
  if (/元宝解析失败|视频号预览失败|视频详情缺少|链接不是可下载的视频/i.test(text)) {
    return '元宝暂时无法解析此视频号内容. 请确认链接可正常打开且内容仍可见, 再查看详细日志.';
  }
  if (/Could not copy Chrome cookie database|PermissionError.*Cookies|cookie database/i.test(text)) {
    return '无法读取浏览器 Cookie. 请使用“选择 cookies.txt”导入目标网站的登录 Cookie 后重试.';
  }
  if (/Youku server reported error -3007|观看此节目[,，]?请先登录/i.test(text)) {
    return '优酷仍未接受当前登录状态. Cookie 文件已可被读取, 但 yt-dlp 对优酷登录/VIP 内容的支持有限; 请先用公开视频测试. 若仅会员视频失败, 可能是优酷接口限制, 反复导出 Cookie 通常无法解决.';
  }
  if (/WinError 10013|forbidden by its access permissions|套接字.*权限/i.test(text)) {
    return '网络连接被 Windows 阻止 (WinError 10013). 请允许 Node.js 和 yt-dlp 通过防火墙, 然后重试.';
  }
  if (/EOF occurred in violation of protocol|SSL_connect|SSL_ERROR_SYSCALL|ConnectionResetError|Connection (?:was )?reset|10054|连接.*重置/i.test(text)) {
    return isBilibili
      ? '本机到 B 站的连接被强制关闭 (10054). 请将 v2rayN 切换为全局代理或为 bilibili.com 设置代理规则, 确认浏览器能打开该链接后重试.'
      : '目标网站的 TLS 连接被提前断开. 请检查代理/VPN、防火墙或安全软件后重试.';
  }
  if (/login|log in|cookie|premium|会员|大会员|购买|付费/i.test(text)) {
    return isBilibili
      ? '该 B 站内容需要登录或会员权限. 请导入已登录 B 站后导出的 cookies.txt 再试.'
      : '目标页面需要登录. 请先在浏览器登录该网站, 导出 cookies.txt 并在页面中选择后重试.';
  }
  if (/HTTP Error 403|HTTP 403|Forbidden/i.test(text)) {
    return '目标网站拒绝了访问 (HTTP 403). 如页面需要登录, 请导入该网站的 cookies.txt, 或稍后重试.';
  }
  if (/Unsupported URL/i.test(text)) return '当前解析器不支持这个链接. 请展开详细日志查看原始信息.';
  return '解析下载失败. 请展开详细日志查看完整原因.';
}

function runWeixinChannels(task, config) {
  task.engine = '微信视频号 / 腾讯元宝';
  task.status = 'starting';
  task.message = '正在连接视频号解析服务...';
  appendLog(task, '微信视频号', 'Share link will be sent to Tencent Yuanbao for parsing.');
  appendLog(task, '微信视频号', `Starting parser for ${task.url}`);
  broadcast();

  if (!fs.existsSync(WX_TOOL)) {
    finishTask(task, '微信视频号', config, 1, '视频号支持组件未安装');
    return;
  }
  const cacheDirectory = path.join(process.env.LOCALAPPDATA || ROOT, 'LocalDownloader', 'wx-cache');
  let child;
  try {
    child = spawn(WX_TOOL, [
      'download', task.url, '--output', config.downloadDirectory,
      '--cache-dir', cacheDirectory, '--quality', 'h264', '--json'
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        WX_CHANNELS_HOME: WX_HOME,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
    });
  } catch (error) {
    finishTask(task, '微信视频号', config, 1, error.message);
    return;
  }
  task.process = child;
  let stdout = '';
  let stderr = '';
  let settled = false;
  const consumeLog = chunk => {
    const text = chunk.toString();
    stderr = `${stderr}${text}`.slice(-5000);
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      appendLog(task, '微信视频号', line);
      if (/已打开元宝|完成扫码|手机号登录/.test(line)) {
        task.status = 'waiting-login';
        task.message = '请在新打开的腾讯元宝窗口完成登录';
      } else if (/已下载|MiB|正在解析|已保存/.test(line)) {
        task.status = 'downloading';
        task.message = line.slice(0, 500);
        const progress = line.match(/\((\d{1,3})%\)/);
        if (progress) task.progress = Math.min(99, Number(progress[1]));
      }
      broadcast();
    }
  };
  const settle = (code, detail) => {
    if (settled) return;
    settled = true;
    try {
      const result = JSON.parse(stdout);
      const item = result.results?.[0];
      if (item?.path) task.resultPath = item.path;
      if (item?.description) task.title = item.description;
      if (item?.path && code === 0) appendLog(task, '微信视频号', `Saved to ${item.path}`);
    } catch { /* Keep the parser's stderr as the actionable error. */ }
    finishTask(task, '微信视频号', config, code, detail);
  };
  child.stdout.on('data', chunk => { stdout = `${stdout}${chunk.toString()}`.slice(-20000); });
  child.stderr.on('data', consumeLog);
  child.on('error', error => settle(1, error.message));
  child.on('close', code => settle(code ?? 1, stderr || stdout));
}

function buildCommand(engine, task, config) {
  const cookies = config.cookieFilePath ? ['--cookies', config.cookieFilePath] : [];
  if (engine === 'gallery-dl') {
    return {
      command: executable('gallery-dl'),
      args: ['--dest', config.downloadDirectory, '--no-mtime', ...cookies, task.url]
    };
  }
  return {
    command: executable('yt-dlp'),
    args: [
      '--newline', '--progress', '--no-colors', '--encoding', 'utf-8', '--no-playlist', '--restrict-filenames',
      '--ffmpeg-location', TOOLS, '-P', config.downloadDirectory,
      '-f', qualityFormat(), '--merge-output-format', 'mp4',
      ...cookies, task.url
    ]
  };
}

function setProgress(task, line) {
  appendLog(task, task.engine || 'system', line);
  const match = line.match(/\[download\]\s+([\d.]+)%/i) || line.match(/(\d{1,3})%/);
  if (match) task.progress = Math.min(100, Number(match[1]));
  if (/Destination:|Downloading|\[download\]/i.test(line)) task.status = 'downloading';
  task.message = line.slice(0, 500);
  broadcast();
}

function runTask(task, engine, config) {
  if (engine === 'direct') return runDirect(task, config);
  if (engine === 'wx-downloader') return runWeixinChannels(task, config);
  const spec = buildCommand(engine, task, config);
  task.engine = engine;
  task.status = 'starting';
  task.message = `Starting ${engine}...`;
  appendLog(task, engine, `Starting parser for ${task.url}`);
  if (config.cookieFilePath) appendLog(task, engine, 'Using the selected local Cookie file.');
  broadcast();

  let child;
  try {
    child = spawn(spec.command, spec.args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });
  } catch (error) {
    finishTask(task, engine, config, 1, error.message);
    return;
  }
  task.process = child;
  let stderr = '';
  let settled = false;
  const settle = (code, detail) => {
    if (settled) return;
    settled = true;
    finishTask(task, engine, config, code, detail);
  };
  const consume = chunk => {
    const text = chunk.toString();
    stderr = `${stderr}${text}`.slice(-5000);
    for (const line of text.split(/\r?\n/).filter(Boolean)) setProgress(task, line);
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('error', error => settle(1, error.message));
  child.on('close', code => settle(code ?? 1, stderr));
}

function runDirect(task, config, redirectCount = 0) {
  task.engine = 'direct';
  task.status = 'downloading';
  task.message = 'Downloading direct file...';
  broadcast();
  const parsed = new URL(task.url);
  const client = parsed.protocol === 'https:' ? https : http;
  const request = client.get(parsed, { headers: { 'User-Agent': 'Mozilla/5.0 EasyDownloader/0.1' } }, response => {
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirectCount < 5) {
      response.resume();
      task.url = new URL(response.headers.location, parsed).href;
      return runDirect(task, config, redirectCount + 1);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.resume();
      return finishTask(task, 'direct', config, 1, `HTTP ${response.statusCode}`);
    }
    const rawName = decodeURIComponent(path.basename(parsed.pathname)) || `download-${task.id}`;
    const filename = rawName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const target = path.join(config.downloadDirectory, filename);
    const total = Number(response.headers['content-length'] || 0);
    let received = 0;
    const output = fs.createWriteStream(target);
    task.process = { pid: null, kill: () => request.destroy() };
    response.on('data', chunk => {
      received += chunk.length;
      if (total) task.progress = Math.min(99, Math.round(received / total * 100));
      task.message = total ? `${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` : `${(received / 1048576).toFixed(1)} MB`;
      broadcast();
    });
    response.pipe(output);
    output.on('finish', () => { output.close(); finishTask(task, 'direct', config, 0, ''); });
    output.on('error', error => finishTask(task, 'direct', config, 1, error.message));
  });
  request.on('error', error => {
    if (task.status !== 'cancelled') finishTask(task, 'direct', config, 1, error.message);
  });
}

function finishTask(task, engine, config, code, detail) {
  if (task.status === 'cancelled') return;
  task.process = null;
  if (code === 0) {
    task.status = 'complete';
    task.progress = 100;
    task.message = 'Saved successfully';
    appendLog(task, engine, 'Task completed successfully.');
  } else if (engine === 'gallery-dl' && !task.fallbackUsed) {
    task.fallbackUsed = true;
    const fallback = 'yt-dlp';
    task.message = `${engine} failed, trying ${fallback}...`;
    appendLog(task, engine, `Parser exited with code ${code}. Trying ${fallback}.`);
    broadcast();
    runTask(task, fallback, config);
    return;
  } else {
    task.status = 'error';
    task.errorHint = friendlyError(detail, task);
    task.message = task.errorHint;
    appendLog(task, engine, `Parser exited with code ${code}.`);
  }
  task.finishedAt = new Date().toISOString();
  broadcast();
}

function startDownload(input) {
  const savedConfig = readConfig();
  const settings = input.settings || {};
  const config = {
    ...savedConfig,
    downloadDirectory: settings.downloadDirectory || savedConfig.downloadDirectory,
    cookieFilePath: typeof settings.cookieFilePath === 'string' ? settings.cookieFilePath : savedConfig.cookieFilePath
  };
  const urls = String(input.urls || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!urls.length || urls.length > 10 || urls.some(value => !validUrl(value))) {
    throw new Error('Enter between 1 and 10 valid http/https links.');
  }
  if (config.cookieFilePath && (!fs.existsSync(config.cookieFilePath) || !fs.statSync(config.cookieFilePath).isFile())) {
    throw new Error('Cookie 文件不存在, 请重新选择 cookies.txt.');
  }
  if (!fs.existsSync(config.downloadDirectory)) fs.mkdirSync(config.downloadDirectory, { recursive: true });
  writeConfig(config);
  const created = urls.map(url => {
    const task = {
      id: randomUUID(), url, status: 'queued', progress: 0,
      message: 'Waiting...', engine: '', logs: [], createdAt: new Date().toISOString()
    };
    tasks.set(task.id, task);
    const engine = isWeixinChannelsUrl(url) ? 'wx-downloader'
      : isDirectUrl(url) ? 'direct'
      : isGalleryUrl(url) ? 'gallery-dl' : 'yt-dlp';
    setImmediate(() => runTask(task, engine, config));
    return publicTask(task);
  });
  broadcast();
  return created;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
    let output = '';
    let error = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => error += chunk);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(error || 'PowerShell failed')));
  });
}

function serveFile(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(WEB, requested));
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { config: readConfig(), tools: { ytDlp: fs.existsSync(path.join(TOOLS, 'yt-dlp.exe')), galleryDl: fs.existsSync(path.join(TOOLS, 'gallery-dl.exe')), ffmpeg: fs.existsSync(path.join(TOOLS, 'ffmpeg.exe')), wechatChannels: fs.existsSync(WX_TOOL) } });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(res);
      res.write(`data: ${JSON.stringify([...tasks.values()].map(publicTask))}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/tasks/history') {
      for (const [id, task] of tasks) {
        if (['complete', 'error', 'cancelled'].includes(task.status)) tasks.delete(id);
      }
      saveTaskHistoryNow();
      broadcast();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/downloads') return json(res, 202, { tasks: startDownload(await body(req)) });
    if (req.method === 'POST' && url.pathname === '/api/select-folder') {
      const selected = await runPowerShell("Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose download folder'; if($d.ShowDialog() -eq 'OK'){[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Write-Output $d.SelectedPath}");
      return json(res, 200, { path: selected });
    }
    if (req.method === 'POST' && url.pathname === '/api/select-cookies') {
      const selected = await runPowerShell("Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='Choose Netscape cookies.txt'; $d.Filter='Cookie files (cookies.txt)|*.txt|All files (*.*)|*.*'; if($d.ShowDialog() -eq 'OK'){[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; Write-Output $d.FileName}");
      if (selected && !fs.statSync(selected).isFile()) throw new Error('Selected Cookie path is not a file.');
      return json(res, 200, { path: selected });
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      const config = readConfig();
      if (!fs.existsSync(config.downloadDirectory)) fs.mkdirSync(config.downloadDirectory, { recursive: true });
      spawn('explorer.exe', [config.downloadDirectory], { detached: true, windowsHide: false }).unref();
      return json(res, 200, { ok: true });
    }
    const cancel = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancel) {
      const task = tasks.get(cancel[1]);
      if (!task) return json(res, 404, { error: 'Task not found' });
      task.status = 'cancelled';
      task.message = 'Cancelled';
      if (task.process?.pid) spawn('taskkill.exe', ['/pid', String(task.process.pid), '/t', '/f'], { windowsHide: true });
      else task.process?.kill?.();
      broadcast();
      return json(res, 200, { task: publicTask(task) });
    }
    if (req.method === 'GET' && serveFile(res, url.pathname)) return;
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    json(res, 400, { error: error.message || 'Request failed' });
  }
});

server.listen(PORT, HOST, () => {
  const appUrl = `http://${HOST}:${PORT}`;
  console.log(`EasyDownloader is running at ${appUrl}`);
  if (process.env.EASY_DOWNLOADER_NO_BROWSER !== '1') {
    setTimeout(() => spawn('cmd.exe', ['/c', 'start', '', appUrl], { detached: true, windowsHide: true }).unref(), 350);
  }
});

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  clearTimeout(historySaveTimer);
  for (const task of tasks.values()) {
    if (['complete', 'error', 'cancelled'].includes(task.status)) continue;
    task.status = 'cancelled';
    task.message = '客户端关闭，任务已停止';
    task.finishedAt = new Date().toISOString();
  }
  saveTaskHistoryNow();
  const stopping = [...tasks.values()].map(task => new Promise(resolve => {
    const pid = task.process?.pid;
    if (process.platform === 'win32' && pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { task.process?.kill?.(); resolve(); });
      killer.once('close', () => resolve());
    } else {
      task.process?.kill?.();
      resolve();
    }
  }));
  Promise.all(stopping).finally(() => server.close(() => process.exit(0)));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
