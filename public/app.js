// ==============================================================================
// Antigravity Browser Studio - 前端核心交互应用
// ==============================================================================

const API_BASE = window.location.origin.startsWith('http')
  ? `${window.location.origin}/api/v1`
  : 'http://127.0.0.1:3000/api/v1';

// 当前状态
let state = {
  profiles: [],
  profilePage: 0,
  profilesPerPage: 50,
  profileFilter: '',
  proxies: [],
  workflows: [],
  rpaTasks: [],
  clusterTasks: [],
  workspaces: [],
  members: [],
  extensions: [],
  editingWorkflowId: null,
  activeSessions: new Map(), // profileId -> sessionId
  currentCookieProfileId: null,
};

// 全局错误捕获
window.addEventListener('error', (e) => {
  console.error('[BrowserStudio Global Error]', e);
  if (e.message && !e.message.includes('ResizeObserver')) {
    showToast(`系统提示: ${e.message}`, 'info');
  }
});

// 通用防抖函数，防止高频输入卡顿
function debounce(fn, delayMs = 150) {
  let timer = null;
  return function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, delayMs);
  };
}

// 指纹偏好库；User-Agent 由后端根据受管浏览器版本生成。
const FINGERPRINT_PRESETS = {
  resolutions: ['1920x1080', '2560x1440', '1440x900', '1680x1050'],
  cpus: ['8', '16', '12', '6', '4'],
  countries: {
    CN: { timezone: 'Asia/Shanghai', locale: 'zh-CN' },
    US: { timezone: 'America/New_York', locale: 'en-US' },
    HK: { timezone: 'Asia/Hong_Kong', locale: 'zh-HK' },
    JP: { timezone: 'Asia/Tokyo', locale: 'ja-JP' },
    SG: { timezone: 'Asia/Singapore', locale: 'en-SG' },
    GB: { timezone: 'Europe/London', locale: 'en-GB' },
  },
};

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
  try {
    initTabs();
    initModals();
    initQuickCrawler();
    initClusterTaskWorkspace();
    initGeoInteractions();
    initLocalBrowserMigration();
    initBridgeBrowserSection();
    initQuickUrlLauncher();
    initCsvModal();
    init2faModal();
    initProxyPool();
    initRpaStudio();
    initSynchronizerModal();
    initTileWindows();
    initTeamAdmin();
    initManagedExtensions();
    initLiveTakeoverModal();
    loadProfiles();
    loadBridgeBrowsers();
    loadProxyPool();
    loadRpaStudio();
    loadTeamAdmin();
    loadManagedExtensions();
  } catch (err) {
    console.error('Initialization error:', err);
    showToast(`初始化异常: ${err.message}`, 'error');
  }
  
  // 定时刷新状态
  setInterval(() => {
    loadSessions();
    if (document.getElementById('tab-tasks')?.classList.contains('active') && document.getElementById('cluster-task-auto-refresh')?.checked) void loadClusterTasks();
  }, 3000);
});

// 快速输入网址并在桌面弹出指纹浏览器
function initQuickUrlLauncher() {
  const btn = document.getElementById('btn-quick-launch-url');
  const input = document.getElementById('quick-url-input');
  if (!btn || !input) return;

  btn.onclick = async () => {
    let url = input.value.trim();
    if (!url) {
      showToast('请输入有效网址', 'error');
      return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    btn.textContent = '🚀 正在拉起...';
    btn.disabled = true;
    showToast(`正在以独立 Profile 打开浏览器窗口: ${url}`, 'info');

    try {
      // 1. 创建随机环境
      const randId = `quick-${Date.now().toString(36)}`;
      const pRes = await fetch(`${API_BASE}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: randId,
          name: `快速指纹环境-${new URL(url).hostname}`,
          tags: ['快速直达', new URL(url).hostname],
          engine: 'firefox',
        }),
      });

      // 2. 启动该环境并直达
      const sRes = await fetch(`${API_BASE}/profiles/${randId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headless: false }),
      });
      const sJson = await sRes.json();
      if (sJson.success) {
        showToast('隔离浏览器窗口已在桌面打开', 'success');
        loadProfiles();
        loadSessions();
      } else {
        showToast(`启动失败: ${sJson.message}`, 'error');
      }
    } catch (err) {
      showToast(`操作失败: ${err.message}`, 'error');
    } finally {
      btn.textContent = '立即启动隔离窗口';
      btn.disabled = false;
    }
  };
}

// 1. 选项卡切换
function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      navItems.forEach((n) => n.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-content').forEach((sec) => sec.classList.remove('active'));
      const targetSec = document.getElementById(`tab-${tabName}`);
      if (targetSec) targetSec.classList.add('active');

      // 更新 Header 标题
      const titles = {
        profiles: { title: '环境管理中心', sub: '管理独立 Profile、持久存储、代理绑定与一致性配置' },
        proxies: { title: '代理网络中心', sub: '检测与绑定 SOCKS5 / HTTP 代理，对齐真实出口 IP 与地理特征' },
        tasks: { title: '爬虫与自动化中心', sub: '管理已授权站点的采集任务与 RPA 工作流，遇到挑战自动暂停' },
        geo: { title: 'GEO (AI搜索优化) 矩阵中心', sub: '针对 DeepSeek、豆包、通义千问网页端进行多地域指纹多开与关键词占位监测' },
        migration: { title: '数据迁移与互通', sub: '一键导入日常浏览器 Cookie 或 AdsPower / 比特指纹浏览器配置' },
        team: { title: '团队与资源权限', sub: '管理工作区、成员、角色、Profile grants 与可撤销 API Key' },
        extensions: { title: '受管扩展中心', sub: '审核、锁定并按 Profile 授权 WebExtension，禁止任意本机路径加载' },
        settings: { title: '隔离与自动化策略', sub: '查看环境一致性、资源限制、挑战暂停和审计状态' },
      };
      if (titles[tabName]) {
        document.getElementById('page-title').textContent = titles[tabName].title;
        document.getElementById('page-subtitle').textContent = titles[tabName].sub;
      }

      if (tabName === 'migration') {
        loadBridgeBrowsers();
      }
    });
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    loadProfiles();
    showToast('已刷新环境列表与会话状态', 'info');
  });
}

// 2. 模态弹窗控制
function initModals() {
  const profileModal = document.getElementById('profile-modal');
  const btnCreate = document.getElementById('btn-create-profile');
  const btnClose = document.getElementById('btn-close-modal');
  const btnCancel = document.getElementById('btn-cancel-modal');

  btnCreate.addEventListener('click', () => {
    randomizeFingerprintForm();
    profileModal.classList.add('active');
  });

  const hideProfileModal = () => profileModal.classList.remove('active');
  btnClose.addEventListener('click', hideProfileModal);
  btnCancel.addEventListener('click', hideProfileModal);

  // Cookie 模态框
  const cookieModal = document.getElementById('cookie-modal');
  const btnCloseCookie = document.getElementById('btn-close-cookie-modal');
  btnCloseCookie.addEventListener('click', () => cookieModal.classList.remove('active'));
}

// 3. 表单与指纹随机生成
function initFormInteractions() {
  // 随机指纹按钮
  document.getElementById('btn-random-all-fingerprint').addEventListener('click', randomizeFingerprintForm);

  // 国家切换自动对齐时区与语言
  document.getElementById('p-country').addEventListener('change', (e) => {
    const country = e.target.value;
    const info = FINGERPRINT_PRESETS.countries[country];
    if (info) {
      document.getElementById('p-timezone').value = info.timezone;
      document.getElementById('p-locale').value = info.locale;
    }
  });

  // 代理类型切换显示账号密码
  document.getElementById('p-proxy-type').addEventListener('change', (e) => {
    const isDirect = e.target.value === 'direct';
    const authRow = document.querySelector('.proxy-auth-row');
    authRow.style.display = isDirect ? 'none' : 'flex';
  });

  // 保存环境表单提交
  document.getElementById('btn-save-profile').addEventListener('click', async () => {
    await saveProfileForm();
  });

  // 快捷测试单条代理
  document.getElementById('btn-test-single-proxy').addEventListener('click', async () => {
    await testSingleProxy();
  });

  // 一键生成 A股 预设模板环境
  document.getElementById('btn-quick-sample').addEventListener('click', async () => {
    await createFinanceSampleProfiles();
  });

  // 批量操作走单一受控端点，避免为每个 Profile 建立一次 HTTP 往返。
  const btnBatchStart = document.getElementById('btn-batch-start-all');
  if (btnBatchStart) {
    btnBatchStart.addEventListener('click', async () => {
      const profileIds = state.profiles
        .filter((profile) => !state.activeSessions.has(profile.profileId))
        .map((profile) => profile.profileId);
      if (profileIds.length === 0) {
        showToast('没有待启动的浏览器环境', 'info');
        return;
      }
      showToast(`正在批量拉起 ${profileIds.length} 个独立 Profile 窗口...`, 'info');
      btnBatchStart.disabled = true;
      btnBatchStart.textContent = '🚀 批量多开中...';
      try {
        const results = await runProfileBatch('start', profileIds);
        const failed = results.filter((result) => !result.success);
        showToast(`批量启动完成：成功 ${results.length - failed.length} 个，失败 ${failed.length} 个`, failed.length ? 'error' : 'success');
        loadSessions();
      } catch (err) {
        showToast(`批量多开异常: ${err.message}`, 'error');
      } finally {
        btnBatchStart.disabled = false;
        btnBatchStart.textContent = '▶ 批量多开窗口';
      }
    });
  }

  // 批量停止所有窗口
  const btnBatchStop = document.getElementById('btn-batch-stop-all');
  if (btnBatchStop) {
    btnBatchStop.addEventListener('click', async () => {
      const profileIds = [...state.activeSessions.keys()];
      if (profileIds.length === 0) {
        showToast('当前没有运行中的浏览器窗口', 'info');
        return;
      }
      btnBatchStop.disabled = true;
      btnBatchStop.textContent = '⏹ 停止中...';
      try {
        const results = await runProfileBatch('stop', profileIds);
        const failed = results.filter((result) => !result.success);
        showToast(`批量停止完成：成功 ${results.length - failed.length} 个，失败 ${failed.length} 个`, failed.length ? 'error' : 'info');
        loadSessions();
      } catch (err) {
        showToast(`停止异常: ${err.message}`, 'error');
      } finally {
        btnBatchStop.disabled = false;
        btnBatchStop.textContent = '⏹ 全部关闭';
      }
    });
  }

  // 搜索和分页只影响表格，不影响 RPA/扩展中心使用的完整 Profile 目录。
  const filterInput = document.getElementById('filter-profiles-input');
  if (filterInput) {
    const handleProfileFilter = debounce((val) => {
      state.profileFilter = val.toLowerCase().trim();
      state.profilePage = 0;
      renderProfilePage();
    }, 150);
    filterInput.addEventListener('input', (event) => {
      handleProfileFilter(event.target.value);
    });
  }
  document.getElementById('profiles-page-prev').addEventListener('click', () => {
    if (state.profilePage > 0) {
      state.profilePage -= 1;
      renderProfilePage();
    }
  });
  document.getElementById('profiles-page-next').addEventListener('click', () => {
    state.profilePage += 1;
    renderProfilePage();
  });
}

async function runProfileBatch(action, profileIds) {
  const results = [];
  for (let offset = 0; offset < profileIds.length; offset += 100) {
    const response = await fetch(`${API_BASE}/profiles/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds: profileIds.slice(offset, offset + 100), action, headless: false }),
    });
    const json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || '批量操作失败');
    if (Array.isArray(json.data)) results.push(...json.data);
  }
  return results;
}


// 随机生成指纹
function randomizeFingerprintForm() {
  const country = document.getElementById('p-country').value;
  document.getElementById('p-ua').value = '';

  const res = FINGERPRINT_PRESETS.resolutions[Math.floor(Math.random() * FINGERPRINT_PRESETS.resolutions.length)];
  document.getElementById('p-resolution').value = res;

  const cpu = FINGERPRINT_PRESETS.cpus[Math.floor(Math.random() * FINGERPRINT_PRESETS.cpus.length)];
  document.getElementById('p-cpu').value = cpu;

  const info = FINGERPRINT_PRESETS.countries[country];
  if (info) {
    document.getElementById('p-timezone').value = info.timezone;
    document.getElementById('p-locale').value = info.locale;
  }
}

// 4. 保存新环境
async function saveProfileForm() {
  const name = document.getElementById('p-name').value.trim();
  if (!name) {
    showToast('请输入环境名称', 'error');
    return;
  }

  const engine = document.getElementById('p-engine').value;
  const tags = document.getElementById('p-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const proxyType = document.getElementById('p-proxy-type').value;
  const proxyServer = document.getElementById('p-proxy-server').value.trim();
  const proxyUser = document.getElementById('p-proxy-user').value.trim();
  const proxyPass = document.getElementById('p-proxy-pass').value.trim();

  const country = document.getElementById('p-country').value;
  const timezone = document.getElementById('p-timezone').value.trim();
  const locale = document.getElementById('p-locale').value.trim();
  const userAgent = document.getElementById('p-ua').value.trim();
  const os = document.getElementById('p-os').value;
  const hardwareConcurrency = Number(document.getElementById('p-cpu').value);
  const [screenWidth, screenHeight] = document.getElementById('p-resolution').value
    .split('x')
    .map(Number);
  const initialCookies = document.getElementById('p-cookies').value.trim();
  const twoFactorSecret = document.getElementById('p-2fa-secret').value.trim();

  const payload = {
    name,
    engine,
    tags,
    ...(userAgent ? { userAgent } : {}),
    fingerprint: {
      os,
      hardwareConcurrency,
      screen: {
        width: screenWidth,
        height: screenHeight,
        availWidth: screenWidth,
        availHeight: Math.max(240, screenHeight - 40),
      },
    },
    geo: {
      countryCode: country,
      timezone,
      locale,
    },
    ...(proxyType !== 'direct' && proxyServer ? {
      proxy: {
        server: `${proxyType}://${proxyServer}`,
        ...(proxyUser ? { username: proxyUser } : {}),
        ...(proxyPass ? { password: proxyPass } : {}),
      }
    } : {}),
    ...(initialCookies ? { initialCookies } : {}),
    ...(twoFactorSecret ? { twoFactorSecret } : {}),
  };

  try {
    const res = await fetch(`${API_BASE}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (json.success) {
      showToast(`环境【${name}】创建成功！`, 'success');
      document.getElementById('profile-modal').classList.remove('active');
      document.getElementById('profile-form').reset();
      loadProfiles();
    } else {
      showToast(`创建失败: ${json.message || '未知错误'}`, 'error');
    }
  } catch (err) {
    showToast(`网络请求失败: ${err.message}`, 'error');
  }
}

// 5. 加载所有环境
async function loadProfiles() {
  try {
    const res = await fetch(`${API_BASE}/profiles`);
    const json = await res.json();
    if (json.success) {
      state.profiles = json.data || [];
      document.getElementById('profiles-count').textContent = state.profiles.length;
      document.getElementById('stat-total-profiles').textContent = state.profiles.length;
      const proxyCount = state.profiles.filter(p => p.proxyServer).length;
      document.getElementById('stat-proxy-count').textContent = proxyCount;
      renderProfilePage();
      refreshRpaProfileOptions();
      renderExtensionAssignments();
      loadSessions();
    }
  } catch (err) {
    console.error('Failed to load profiles', err);
  }
}

function getFilteredProfiles() {
  const query = state.profileFilter;
  if (!query) return state.profiles;
  return state.profiles.filter((profile) =>
    profile.name.toLowerCase().includes(query)
    || profile.profileId.toLowerCase().includes(query)
    || profile.tags?.some((tag) => tag.toLowerCase().includes(query))
  );
}

function renderProfilePage() {
  const filtered = getFilteredProfiles();
  const pageCount = Math.max(1, Math.ceil(filtered.length / state.profilesPerPage));
  state.profilePage = Math.min(state.profilePage, pageCount - 1);
  const start = state.profilePage * state.profilesPerPage;
  renderProfilesTable(filtered.slice(start, start + state.profilesPerPage), start);
  const first = filtered.length ? start + 1 : 0;
  const last = Math.min(start + state.profilesPerPage, filtered.length);
  document.getElementById('profiles-page-summary').textContent = `${first}-${last} / ${filtered.length}`;
  document.getElementById('profiles-page-info').textContent = `第 ${state.profilePage + 1} / ${pageCount} 页`;
  document.getElementById('profiles-page-prev').disabled = state.profilePage === 0;
  document.getElementById('profiles-page-next').disabled = state.profilePage >= pageCount - 1;
}

// 加载活跃会话状态
async function loadSessions() {
  try {
    const res = await fetch(`${API_BASE}/sessions`);
    if (res.ok) {
      const json = await res.json();
      const sessions = json.data || [];
      state.activeSessions.clear();
      sessions.forEach(s => {
        if (s.profileId) state.activeSessions.set(s.profileId, s.sessionId);
      });
      document.getElementById('active-sessions-text').textContent = `${sessions.length} 个活动窗口`;
      document.getElementById('stat-running-sessions').textContent = sessions.length;
      updateTableStatusButtons();
    }
  } catch {
    // 静默忽略
  }
}

// 渲染表格
function renderProfilesTable(list, offset = 0) {
  const tbody = document.getElementById('profiles-tbody');
  tbody.innerHTML = '';

  if (list.length === 0) {
    const emptyMessage = state.profiles.length
      ? '没有匹配的浏览器环境，请修改搜索条件'
      : '暂无浏览器环境，请点击右上角【新建浏览器环境】或【一键生成A股投研模板环境】';
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: var(--text-dim);">${emptyMessage}</td></tr>`;
    return;
  }

  list.forEach((p, idx) => {
    const tr = document.createElement('tr');
    const isRunning = state.activeSessions.has(p.profileId);

    tr.innerHTML = `
      <td style="color: var(--text-dim); font-family: var(--font-mono);">${offset + idx + 1}</td>
      <td>
        <div style="font-weight: 600; color: var(--text-main);">${escapeHtml(p.name)}</div>
        <div class="profile-id-cell">${escapeHtml(p.profileId)}</div>
      </td>
      <td>
        <span class="tag-badge" style="text-transform: capitalize;">${escapeHtml(p.engine || 'firefox')}</span>
      </td>
      <td>
        <div>${p.proxyServer ? `🌐 ${escapeHtml(p.proxyServer)}` : '⚪ 本地直连'}</div>
        <div style="font-size: 11px; color: var(--text-dim);">${p.country ? `🌐 ${escapeHtml(p.country)}` : '未验证出口'}</div>
      </td>
      <td>
        <span class="tag-badge" style="color: #34d399;">Canvas微扰</span>
        <span class="tag-badge" style="color: #38bdf8;">WebGL对齐</span>
      </td>
      <td>
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-xs btn-secondary btn-manage-cookie" data-id="${escapeHtml(p.profileId)}">🍪 Cookie</button>
          <button class="btn btn-xs btn-outline btn-open-2fa" data-id="${escapeHtml(p.profileId)}" data-name="${escapeHtml(p.name)}">🔑 2FA</button>
        </div>
      </td>
      <td style="font-size: 12px; color: var(--text-dim);">
        ${new Date(p.createdAt).toLocaleDateString()}
      </td>
      <td style="text-align: right;">
        <div class="row-actions">
          ${isRunning ? `
            <button class="btn btn-sm btn-warning btn-live-takeover" data-id="${escapeHtml(p.profileId)}" data-sid="${escapeHtml(state.activeSessions.get(p.profileId))}" title="实时画面回传与反向接管操作">🎮 实时接管</button>
            <button class="btn btn-sm btn-info btn-nav-window" data-id="${escapeHtml(p.profileId)}" data-sid="${escapeHtml(state.activeSessions.get(p.profileId))}" title="控制此窗口打开指定网页">🌐 网址导航</button>
            <button class="btn btn-sm btn-danger btn-stop-window" data-id="${escapeHtml(p.profileId)}">⏹ 停止窗口</button>
          ` : `
            <button class="btn btn-sm btn-success btn-open-window" data-id="${escapeHtml(p.profileId)}">▶ 打开窗口</button>
          `}
          <button class="btn btn-sm btn-outline btn-edit-profile" data-id="${escapeHtml(p.profileId)}" title="修改名称和标签">✏️</button>
          <button class="btn btn-sm btn-outline btn-clone-profile" data-id="${escapeHtml(p.profileId)}" title="克隆环境">📋</button>
          <button class="btn btn-sm btn-outline btn-rotate-proxy" data-id="${escapeHtml(p.profileId)}" title="从健康代理池轮换">🔄</button>
          <button class="btn btn-sm btn-secondary btn-delete-profile" data-id="${escapeHtml(p.profileId)}" title="删除环境">🗑️</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  attachTableEvents();
}

function updateTableStatusButtons() {
  renderProfilePage();
}

// 绑定表格操作事件
function attachTableEvents() {
  // 打开真实窗口
  document.querySelectorAll('.btn-open-window').forEach(btn => {
    btn.onclick = async () => {
      const profileId = btn.getAttribute('data-id');
      btn.textContent = '🚀 启动中...';
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/profiles/${profileId}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headless: false }), // 拉起真实有头窗口
        });
        const json = await res.json();
        if (json.success) {
          showToast(`已在桌面拉起独立指纹浏览器窗口！`, 'success');
          loadSessions();
        } else {
          showToast(`启动失败: ${json.message}`, 'error');
          btn.disabled = false;
          btn.textContent = '▶ 打开窗口';
        }
      } catch (err) {
        showToast(`网络错误: ${err.message}`, 'error');
        btn.disabled = false;
        btn.textContent = '▶ 打开窗口';
      }
    };
  });

  // 实时反向接管控制台
  document.querySelectorAll('.btn-live-takeover').forEach(btn => {
    btn.onclick = () => {
      const sessionId = btn.getAttribute('data-sid');
      const profileId = btn.getAttribute('data-id');
      if (!sessionId) {
        showToast('会话未就绪', 'error');
        return;
      }
      openLiveTakeoverModal(sessionId, profileId);
    };
  });

  // 控制窗口网址导航
  document.querySelectorAll('.btn-nav-window').forEach(btn => {
    btn.onclick = async () => {
      const sessionId = btn.getAttribute('data-sid');
      if (!sessionId) {
        showToast('会话未就绪', 'error');
        return;
      }
      const target = prompt('请输入要在此指纹窗口中打开的网址 (例如: https://www.google.com 或 https://chat.deepseek.com):', 'https://chat.deepseek.com/');
      if (!target) return;
      let targetUrl = target.trim();
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }
      btn.textContent = '🚀 正在打开...';
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/navigate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: targetUrl }),
        });
        const json = await res.json();
        if (json.success) {
          showToast(`已成功在指纹窗口中打开: ${targetUrl}`, 'success');
        } else {
          showToast(`导航失败: ${json.message}`, 'error');
        }
      } catch (err) {
        showToast(`网络错误: ${err.message}`, 'error');
      } finally {
        btn.textContent = '🌐 网址导航';
        btn.disabled = false;
      }
    };
  });
  document.querySelectorAll('.btn-stop-window').forEach(btn => {
    btn.onclick = async () => {
      const profileId = btn.getAttribute('data-id');
      btn.textContent = '⏹ 停止中...';
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/profiles/${profileId}/stop`, { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast(`窗口已安全关闭`, 'info');
          loadSessions();
        }
      } catch (err) {
        showToast(`操作失败: ${err.message}`, 'error');
      }
    };
  });

  // 管理 Cookie
  document.querySelectorAll('.btn-manage-cookie').forEach(btn => {
    btn.onclick = async () => {
      const profileId = btn.getAttribute('data-id');
      state.currentCookieProfileId = profileId;
      openCookieModal(profileId);
    };
  });

  document.querySelectorAll('.btn-edit-profile').forEach(btn => {
    btn.onclick = async () => {
      const profileId = btn.getAttribute('data-id');
      try {
        const currentResponse = await fetch(`${API_BASE}/profiles/${encodeURIComponent(profileId)}`);
        const currentJson = await currentResponse.json();
        if (!currentJson.success) throw new Error(currentJson.message || '读取失败');
        const name = prompt('环境名称：', currentJson.data.name);
        if (name === null || !name.trim()) return;
        const tagsText = prompt('标签（逗号分隔）：', (currentJson.data.tags || []).join(','));
        if (tagsText === null) return;
        const response = await fetch(`${API_BASE}/profiles/${encodeURIComponent(profileId)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), tags: tagsText.split(/[,，]/).map(value => value.trim()).filter(Boolean) }),
        });
        const json = await response.json();
        if (!json.success) throw new Error(json.message || '更新失败');
        showToast('环境信息已更新', 'success');
        await loadProfiles();
      } catch (error) { showToast(`更新失败: ${error.message}`, 'error'); }
    };
  });

  document.querySelectorAll('.btn-clone-profile').forEach(btn => {
    btn.onclick = async () => {
      const profileId = btn.getAttribute('data-id');
      const source = state.profiles.find(profile => profile.profileId === profileId);
      const name = prompt('克隆环境名称：', `${source?.name || profileId} - 副本`);
      if (!name?.trim()) return;
      try {
        const response = await fetch(`${API_BASE}/profiles/${encodeURIComponent(profileId)}/clone`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), includeCookies: true }),
        });
        const json = await response.json();
        if (!json.success) throw new Error(json.message || '克隆失败');
        showToast('环境与 Cookie 已克隆（生成了新的指纹种子）', 'success');
        await loadProfiles();
      } catch (error) { showToast(`克隆失败: ${error.message}`, 'error'); }
    };
  });

  document.querySelectorAll('.btn-rotate-proxy').forEach(btn => {
    btn.onclick = async () => {
      const profileId = btn.getAttribute('data-id');
      const tagsText = prompt('代理标签筛选（逗号分隔，留空表示任意已健康代理）：', '');
      if (tagsText === null) return;
      const tags = tagsText.split(/[,，]/).map(value => value.trim()).filter(Boolean);
      try {
        const response = await fetch(`${API_BASE}/profiles/${encodeURIComponent(profileId)}/rotate-proxy`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }),
        });
        const json = await response.json();
        if (!json.success) throw new Error(json.message || '没有可用代理');
        showToast(`已绑定代理: ${json.data.proxy.name}`, 'success');
        await loadProfiles();
      } catch (error) { showToast(`代理轮换失败: ${error.message}`, 'error'); }
    };
  });

  // 删除环境
  document.querySelectorAll('.btn-delete-profile').forEach(btn => {
    btn.onclick = async () => {
      const profileId = btn.getAttribute('data-id');
      if (confirm(`确定要彻底删除环境 [${profileId}] 及其所有隔离存储吗？`)) {
        try {
          const res = await fetch(`${API_BASE}/profiles/${profileId}`, { method: 'DELETE' });
          const json = await res.json();
          if (json.success) {
            showToast('环境已删除', 'info');
            loadProfiles();
          }
        } catch (err) {
          showToast(`删除失败: ${err.message}`, 'error');
        }
      }
    };
  });
}

// 6. 打开 Cookie 模态框
async function openCookieModal(profileId) {
  const modal = document.getElementById('cookie-modal');
  const textarea = document.getElementById('cookie-content');
  textarea.value = '正在读取持久化 Cookie...';
  modal.classList.add('active');

  try {
    const res = await fetch(`${API_BASE}/profiles/${profileId}/cookies?format=json`);
    const json = await res.json();
    if (json.success) {
      textarea.value = JSON.stringify(json.data || [], null, 2);
    } else {
      textarea.value = '';
    }
  } catch {
    textarea.value = '[]';
  }

  // 保存 Cookie
  document.getElementById('btn-save-cookie').onclick = async () => {
    const content = textarea.value.trim();
    try {
      const res = await fetch(`${API_BASE}/profiles/${profileId}/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: content }),
      });
      const json = await res.json();
      if (json.success) {
        showToast('Cookie 注入并保存成功！', 'success');
        modal.classList.remove('active');
      } else {
        showToast(`注入失败: ${json.message}`, 'error');
      }
    } catch (err) {
      showToast(`保存失败: ${err.message}`, 'error');
    }
  };

  // 复制
  document.getElementById('btn-copy-cookie').onclick = () => {
    navigator.clipboard.writeText(textarea.value);
    showToast('Cookie 已复制到剪贴板', 'success');
  };
}

// 7. 测试单条代理
async function testSingleProxy() {
  const input = document.getElementById('quick-proxy-input').value.trim();
  if (!input) {
    showToast('请输入代理地址', 'error');
    return;
  }
  const btn = document.getElementById('btn-test-single-proxy');
  const resultBox = document.getElementById('proxy-test-result');
  btn.textContent = '🧪 正在测速...';
  btn.disabled = true;
  resultBox.style.display = 'block';
  resultBox.innerHTML = '<div style="color: var(--text-dim);">正在发起代理握手与真实出口探测...</div>';

  try {
    const res = await fetch(`${API_BASE}/proxy/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy: input }),
    });
    const json = await res.json();
    if (json.success && json.data?.success) {
      const verified = json.data.verified === true;
      resultBox.innerHTML = `
        <div style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 14px; color: #34d399;">
          <strong>${verified ? '✅ 已验证真实代理出口' : '⚠️ 代理端口可达，出口尚未验证'}</strong><br>
          • 真实出口 IP: <code>${escapeHtml(json.data.outboundIp || '未取得')}</code><br>
          • 归属国家/地区: <code>${escapeHtml(json.data.country || '未取得')}</code><br>
          • 检测耗时: <code>${Number.isFinite(json.data.latencyMs) ? json.data.latencyMs : '-'} ms</code>
          ${json.data.probeError ? `<br>• 出口探测说明: ${escapeHtml(json.data.probeError)}` : ''}
        </div>
      `;
    } else {
      resultBox.innerHTML = `
        <div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; padding: 14px; color: #f87171;">
          <strong>❌ 代理连接失败 / 超时</strong><br>
          • 错误原因: ${json.data?.error || json.message || '连接被拒绝'}
        </div>
      `;
    }
  } catch (err) {
    resultBox.innerHTML = `<div style="color: #f87171;">测试异常: ${err.message}</div>`;
  } finally {
    btn.textContent = '🧪 立即测试连通性';
    btn.disabled = false;
  }
}
const CLUSTER_TASK_STATE_LABELS = {
  PENDING: '排队中',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  RETRYING: '重试中',
  CANCELLED: '已取消',
};

const CLUSTER_TASK_PAGE_SIZE = 50;
let clusterTaskRefreshInFlight = false;
let clusterTaskPage = 0;
let clusterTaskHasMore = false;
let clusterTaskPreflightTimer;

function initClusterTaskWorkspace() {
  const submitButton = document.getElementById('btn-submit-cluster-task');
  const refreshButton = document.getElementById('btn-refresh-cluster-tasks');
  const list = document.getElementById('cluster-task-list');
  if (!submitButton || !refreshButton || !list) return;

  submitButton.addEventListener('click', submitClusterTask);
  refreshButton.addEventListener('click', () => { void loadClusterTasks(); });
  document.getElementById('cluster-task-url')?.addEventListener('input', () => {
    window.clearTimeout(clusterTaskPreflightTimer);
    clusterTaskPreflightTimer = window.setTimeout(() => { void preflightClusterTaskUrl(); }, 300);
  });
  ['cluster-filter-project', 'cluster-filter-run', 'cluster-filter-state', 'cluster-filter-mode', 'cluster-filter-priority', 'cluster-filter-after', 'cluster-filter-before']
    .forEach((id) => {
      const element = document.getElementById(id);
      element?.addEventListener(element.tagName === 'INPUT' && !['cluster-filter-after', 'cluster-filter-before'].includes(id) ? 'input' : 'change', () => {
        clusterTaskPage = 0;
        void loadClusterTasks();
      });
    });
  document.getElementById('btn-clear-cluster-filters')?.addEventListener('click', () => {
    ['cluster-filter-project', 'cluster-filter-run', 'cluster-filter-after', 'cluster-filter-before'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.value = '';
    });
    ['cluster-filter-state', 'cluster-filter-mode', 'cluster-filter-priority'].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.value = '';
    });
    clusterTaskPage = 0;
    void loadClusterTasks();
  });
  document.getElementById('btn-cluster-task-prev')?.addEventListener('click', () => {
    if (clusterTaskPage > 0) { clusterTaskPage -= 1; void loadClusterTasks(); }
  });
  document.getElementById('btn-cluster-task-next')?.addEventListener('click', () => {
    if (clusterTaskHasMore) { clusterTaskPage += 1; void loadClusterTasks(); }
  });
  document.getElementById('btn-close-cluster-task-detail')?.addEventListener('click', closeClusterTaskDetail);
  document.getElementById('btn-batch-cancel-cluster-tasks')?.addEventListener('click', () => { void runClusterTaskAction('cancel', selectedClusterTaskIds()); });
  document.getElementById('btn-batch-retry-cluster-tasks')?.addEventListener('click', () => { void runClusterTaskAction('retry', selectedClusterTaskIds()); });
  document.getElementById('btn-batch-export-cluster-tasks')?.addEventListener('click', exportClusterTasks);
  list.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-task-select]')) updateClusterTaskBatchbar();
  });
  list.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-task-action]') : null;
    if (!(target instanceof HTMLElement)) return;
    const taskId = target.dataset.taskId;
    const action = target.dataset.taskAction;
    if (!taskId) return;
    if (action === 'detail') void openClusterTaskDetail(taskId);
    if (action === 'cancel' || action === 'retry') void runClusterTaskAction(action, [taskId]);
    if (action === 'copy-url') void navigator.clipboard?.writeText(target.dataset.url || '');
  });
  void loadClusterTasks();
}

async function submitClusterTask() {
  const submitButton = document.getElementById('btn-submit-cluster-task');
  const url = document.getElementById('cluster-task-url')?.value.trim();
  if (!submitButton || !url) { showToast('请输入目标 URL', 'error'); return; }
  const authorization = document.getElementById('cluster-task-authorized');
  if (!(authorization instanceof HTMLInputElement) || !authorization.checked) {
    showToast('请确认目标站点和数据采集已获授权', 'error');
    return;
  }
  const preflight = await preflightClusterTaskUrl();
  if (!preflight?.allowed) { showToast('URL 未通过安全预检，任务未提交', 'error'); return; }
  const payload = {
    url,
    projectId: document.getElementById('cluster-task-project')?.value.trim(),
    runId: document.getElementById('cluster-task-run')?.value.trim(),
    mode: document.getElementById('cluster-task-mode')?.value,
    priority: document.getElementById('cluster-task-priority')?.value,
  };
  submitButton.disabled = true;
  submitButton.textContent = '提交中...';
  try {
    const response = await fetch(`${API_BASE}/cluster/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([, value]) => value))) });
    const json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || '任务提交失败');
    document.getElementById('cluster-task-url').value = '';
    document.getElementById('cluster-task-authorized').checked = false;
    showToast(`任务已提交：${json.data.id}`, 'success');
    await loadClusterTasks();
  } catch (error) {
    showToast(`任务提交失败: ${error.message}`, 'error');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '提交任务';
  }
}

async function preflightClusterTaskUrl() {
  const url = document.getElementById('cluster-task-url')?.value.trim();
  const status = document.getElementById('cluster-preflight-status');
  const origin = document.getElementById('cluster-preflight-origin');
  const policy = document.getElementById('cluster-preflight-policy');
  if (!status || !origin || !policy || !url) {
    if (status) status.textContent = '输入 URL 后自动检查';
    return null;
  }
  status.textContent = '检查中...';
  try {
    const response = await fetch(`${API_BASE}/cluster/tasks/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || '预检失败');
    const result = json.data || {};
    origin.textContent = `目标 Origin：${result.origin || '-'}`;
    policy.textContent = `URL 策略：${result.allowed ? '已通过' : '拒绝'}（${result.reason || '未知原因'}）`;
    status.textContent = result.allowed ? '可以提交' : '不可提交';
    document.getElementById('cluster-task-safety')?.classList.toggle('is-denied', !result.allowed);
    return result;
  } catch (error) {
    status.textContent = `预检失败：${error.message}`;
    document.getElementById('cluster-task-safety')?.classList.add('is-denied');
    return null;
  }
}

async function loadClusterTasks() {
  const list = document.getElementById('cluster-task-list');
  if (!list || clusterTaskRefreshInFlight) return;
  clusterTaskRefreshInFlight = true;
  const params = new URLSearchParams({ limit: String(CLUSTER_TASK_PAGE_SIZE), offset: String(clusterTaskPage * CLUSTER_TASK_PAGE_SIZE) });
  const queryMap = {
    projectId: 'cluster-filter-project', runId: 'cluster-filter-run', state: 'cluster-filter-state',
    mode: 'cluster-filter-mode', priority: 'cluster-filter-priority',
  };
  Object.entries(queryMap).forEach(([key, id]) => {
    const value = document.getElementById(id)?.value.trim();
    if (value) params.set(key, value);
  });
  const after = document.getElementById('cluster-filter-after')?.value;
  const before = document.getElementById('cluster-filter-before')?.value;
  if (after) params.set('createdAfter', String(new Date(`${after}T00:00:00`).getTime()));
  if (before) params.set('createdBefore', String(new Date(`${before}T23:59:59.999`).getTime()));
  try {
    const response = await fetch(`${API_BASE}/cluster/tasks?${params.toString()}`);
    const json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || '任务加载失败');
    state.clusterTasks = Array.isArray(json.data) ? json.data : [];
    clusterTaskHasMore = response.headers.get('X-Has-More') === 'true';
    renderClusterTaskList();
  } catch (error) {
    list.innerHTML = `<div class="task-list-empty task-list-error"><strong>加载失败</strong><span>${escapeHtml(error.message)}</span><button class="btn btn-sm btn-outline" data-task-action="reload">重试</button></div>`;
    list.querySelector('[data-task-action="reload"]')?.addEventListener('click', () => { void loadClusterTasks(); });
    document.getElementById('cluster-task-summary').textContent = '加载失败';
  } finally {
    clusterTaskRefreshInFlight = false;
  }
}

function renderClusterTaskList() {
  const list = document.getElementById('cluster-task-list');
  const summary = document.getElementById('cluster-task-summary');
  if (!list || !summary) return;
  summary.textContent = state.clusterTasks.length ? `显示 ${state.clusterTasks.length} 个任务 · 第 ${clusterTaskPage + 1} 页` : '暂无匹配任务';
  document.getElementById('cluster-task-pager').hidden = clusterTaskPage === 0 && !clusterTaskHasMore;
  document.getElementById('cluster-task-page-label').textContent = `第 ${clusterTaskPage + 1} 页`;
  document.getElementById('btn-cluster-task-prev').disabled = clusterTaskPage === 0;
  document.getElementById('btn-cluster-task-next').disabled = !clusterTaskHasMore;
  if (!state.clusterTasks.length) {
    const hasFilters = ['cluster-filter-project', 'cluster-filter-run', 'cluster-filter-state', 'cluster-filter-mode', 'cluster-filter-priority', 'cluster-filter-after', 'cluster-filter-before'].some((id) => document.getElementById(id)?.value);
    list.innerHTML = `<div class="task-list-empty">${hasFilters ? '没有匹配任务。' : '还没有任务。填写 URL、项目和运行批次后提交。'}${hasFilters ? '<button class="btn btn-sm btn-outline" data-task-action="clear-filters">清除筛选</button>' : ''}</div>`;
    list.querySelector('[data-task-action="clear-filters"]')?.addEventListener('click', () => document.getElementById('btn-clear-cluster-filters')?.click());
    updateClusterTaskBatchbar();
    return;
  }
  list.innerHTML = state.clusterTasks.map((task) => {
    const taskState = CLUSTER_TASK_STATE_LABELS[task.state] || task.state || '未知';
    const canCancel = task.state === 'PENDING' || task.state === 'RETRYING';
    const canRetry = task.state === 'FAILED' || task.state === 'CANCELLED';
    return `<article class="cluster-task-row">
      <div class="cluster-task-select"><input type="checkbox" data-task-select value="${escapeHtml(task.id)}" aria-label="选择任务 ${escapeHtml(task.id)}" /></div>
      <div class="cluster-task-main">
        <div class="cluster-task-title"><strong>${escapeHtml(task.projectId || '未分组')} / ${escapeHtml(task.runId || '未命名运行')}</strong><span class="status-pill ${String(task.state || '').toLowerCase()}">${escapeHtml(taskState)}</span></div>
        <div class="cluster-task-url" title="${escapeHtml(task.url)}">${escapeHtml(task.url)}</div>
        <div class="cluster-task-meta"><span>${escapeHtml(task.id)}</span><span>${task.mode === 'browser' ? 'Firefox Browser' : 'HTTP Fetch'}</span><span>${formatClusterTaskDate(task.createdAt)}</span><span>重试 ${task.retries}/${task.maxRetries}</span></div>
        ${task.error ? `<div class="task-error"><strong>${escapeHtml(task.errorCode || '执行错误')}</strong> ${escapeHtml(task.error)}</div>` : ''}
      </div>
      <div class="cluster-task-side"><span class="tag-badge">${escapeHtml(task.priority || 'NORMAL')}</span><div class="cluster-task-actions"><button class="btn btn-sm btn-outline" data-task-action="detail" data-task-id="${escapeHtml(task.id)}">详情</button><button class="btn btn-sm btn-outline" data-task-action="copy-url" data-task-url="${escapeHtml(task.url)}">复制 URL</button>${canCancel ? `<button class="btn btn-sm btn-outline" data-task-action="cancel" data-task-id="${escapeHtml(task.id)}">取消</button>` : ''}${canRetry ? `<button class="btn btn-sm btn-primary" data-task-action="retry" data-task-id="${escapeHtml(task.id)}">重试</button>` : ''}</div></div>
      ${task.result !== undefined ? `<details class="cluster-task-result"><summary>查看结构化结果</summary>${renderClusterTaskResult(task.result)}</details>` : ''}
    </article>`;
  }).join('');
  updateClusterTaskBatchbar();
}

function renderClusterTaskResult(result) {
  const json = JSON.stringify(result, null, 2);
  if (!Array.isArray(result) || !result.length || typeof result[0] !== 'object') return `<pre>${escapeHtml(json)}</pre>`;
  const keys = Object.keys(result[0]).slice(0, 8);
  return `<div class="cluster-result-table-wrap"><table class="cluster-result-table"><thead><tr>${keys.map((key) => `<th>${escapeHtml(key)}</th>`).join('')}</tr></thead><tbody>${result.slice(0, 20).map((row) => `<tr>${keys.map((key) => `<td>${escapeHtml(typeof row[key] === 'string' ? row[key] : JSON.stringify(row[key]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><details><summary>JSON</summary><pre>${escapeHtml(json)}</pre></details>`;
}

function formatClusterTaskDate(value) {
  return Number.isFinite(value) ? new Date(value).toLocaleString() : '-';
}

function selectedClusterTaskIds() {
  return [...document.querySelectorAll('#cluster-task-list [data-task-select]:checked')].map((input) => input.value);
}

function updateClusterTaskBatchbar() {
  const ids = selectedClusterTaskIds();
  document.getElementById('cluster-task-batchbar').hidden = !ids.length;
  document.getElementById('cluster-task-selected-count').textContent = String(ids.length);
}

async function runClusterTaskAction(action, ids) {
  if (!ids.length) { showToast('请先选择任务', 'info'); return; }
  try {
    const response = await fetch(`${API_BASE}/cluster/tasks/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ids }) });
    const json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || '任务操作失败');
    const failed = (json.data || []).filter((item) => !item.success);
    showToast(failed.length ? `${action === 'cancel' ? '取消' : '重试'}完成，${failed.length} 个任务未处理` : `${action === 'cancel' ? '取消' : '重试'}完成`, failed.length ? 'info' : 'success');
    await loadClusterTasks();
  } catch (error) {
    showToast(`任务操作失败: ${error.message}`, 'error');
  }
}

async function openClusterTaskDetail(taskId) {
  const panel = document.getElementById('cluster-task-detail');
  const body = document.getElementById('cluster-task-detail-body');
  if (!panel || !body) return;
  panel.hidden = false;
  body.innerHTML = '<div class="task-detail-loading">加载详情...</div>';
  try {
    const response = await fetch(`${API_BASE}/cluster/tasks/${encodeURIComponent(taskId)}`);
    const json = await response.json();
    if (!response.ok || !json.success) throw new Error(json.message || '详情加载失败');
    const task = json.data;
    document.getElementById('cluster-task-detail-title').textContent = `任务详情 · ${task.id}`;
    document.getElementById('cluster-task-detail-subtitle').textContent = `${task.projectId || '未分组'} / ${task.runId || '未命名运行'} · ${task.mode === 'browser' ? 'Firefox Browser' : 'HTTP Fetch'}`;
    const events = Array.isArray(task.events) ? task.events : [];
    body.innerHTML = `<div class="task-detail-grid"><span>状态：${escapeHtml(CLUSTER_TASK_STATE_LABELS[task.state] || task.state)}</span><span>优先级：${escapeHtml(task.priority)}</span><span>租户：${escapeHtml(task.tenantId || '-')}</span><span>Worker：${escapeHtml(task.workerId || '-')}</span><span>Session：${escapeHtml(task.sessionId || '-')}</span><span>Trace：任务 ID 关联审计</span></div><div class="task-detail-section"><h5>执行时间线</h5>${events.length ? `<ol class="task-timeline">${events.map((event) => `<li><time>${formatClusterTaskDate(event.at)}</time><strong>${escapeHtml(event.phase)}</strong><span>${escapeHtml(event.message)}</span></li>`).join('')}</ol>` : '<div class="task-detail-muted">暂无持久化事件</div>'}</div><div class="task-detail-section"><h5>结果</h5>${task.result === undefined ? '<div class="task-detail-muted">暂无结果</div>' : renderClusterTaskResult(task.result)}</div>${task.error ? `<div class="task-detail-section task-detail-error"><h5>错误</h5><code>${escapeHtml(task.errorCode || 'EXECUTION_ERROR')}</code><p>${escapeHtml(task.error)}</p></div>` : ''}`;
  } catch (error) {
    body.innerHTML = `<div class="task-detail-error">${escapeHtml(error.message)}</div>`;
  }
}

function closeClusterTaskDetail() {
  document.getElementById('cluster-task-detail').hidden = true;
}

function exportClusterTasks() {
  const tasks = selectedClusterTaskIds().map((id) => state.clusterTasks.find((task) => task.id === id)).filter(Boolean);
  if (!tasks.length) { showToast('请先选择任务', 'info'); return; }
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `cluster-tasks-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}


// 8. 自动化快速爬取
function initQuickCrawler() {
  document.querySelectorAll('.btn-run-crawler').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const card = e.target.closest('.crawler-preset-card');
      const siteName = card.querySelector('h4').textContent;
      const url = card.getAttribute('data-url');
      const panel = document.getElementById('crawler-result-panel');
      const body = document.getElementById('crawler-result-body');
      const title = document.getElementById('crawler-result-title');

      panel.style.display = 'block';
      title.textContent = `正在调度隔离浏览器读取【${siteName}】...`;
      body.textContent = '🚀 正在初始化隔离 Profile...\n📡 正在按站点策略导航；若出现挑战将暂停...\n';

      try {
        const res = await fetch(`${API_BASE}/tasks/scrape`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, name: siteName }),
        });
        const json = await res.json();
        if (json.success) {
          title.textContent = `【${siteName}】数据抽取成功 (耗时: ${json.data.elapsedMs}ms)`;
          body.textContent = `✅ 页面标题: ${json.data.title}\n✅ 最终URL: ${json.data.url}\n✅ 提取到数据节点: ${json.data.nodesCount} 个\n\n--- 提取文本摘要 ---\n${json.data.snippet}\n\n--- 结构化数据预览 ---\n${JSON.stringify(json.data.sampleData || [], null, 2)}`;
        } else {
          title.textContent = `【${siteName}】采集异常`;
          body.textContent = `❌ 错误: ${json.message}`;
        }
      } catch (err) {
        body.textContent = `❌ 请求异常: ${err.message}`;
      }
    });
  });

  document.getElementById('btn-close-crawler-result').addEventListener('click', () => {
    document.getElementById('crawler-result-panel').style.display = 'none';
  });

  // AI 深度投研推理调用
  document.getElementById('btn-run-ai-analysis').addEventListener('click', async () => {
    const provider = document.getElementById('ai-provider-select').value;
    const apiKey = document.getElementById('ai-key-input').value.trim();
    const content = document.getElementById('crawler-result-body').textContent;
    const aiBox = document.getElementById('ai-result-box');
    const btnAi = document.getElementById('btn-run-ai-analysis');

    if (!content) {
      showToast('暂无有效采集内容，请先启动采集', 'error');
      return;
    }

    btnAi.textContent = '🧠 正在深度思考中...';
    btnAi.disabled = true;
    aiBox.style.display = 'block';
    aiBox.textContent = `🚀 正在调用【${provider.toUpperCase()}】大模型进行深度金融逻辑推理与排雷拆解...`;

    try {
      const res = await fetch(`${API_BASE}/ai/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiKey,
          prompt: '对采集到的财经数据进行逻辑拆解、潜在受益标的分析与严格风控排雷',
          content,
        }),
      });
      const json = await res.json();
      if (json.success) {
        aiBox.textContent = json.data.analysis;
        showToast(`【${provider.toUpperCase()}】投研推理完成！`, 'success');
      } else {
        aiBox.textContent = `❌ AI 调用失败: ${json.message}`;
      }
    } catch (err) {
      aiBox.textContent = `❌ 网络异常: ${err.message}`;
    } finally {
      btnAi.textContent = '⚡ 立即深度推理';
      btnAi.disabled = false;
    }
  });
}

// 9. 一键生成 A股 投研专用模板环境
async function createFinanceSampleProfiles() {
  const samples = [
    { name: '问财量化扫盘-01', engine: 'firefox', tags: ['问财', '选股', '资金流向'] },
    { name: '巨潮信披监控-02', engine: 'firefox', tags: ['巨潮', '公告', '财报'] },
    { name: '集思录套利轮动-03', engine: 'chromium', tags: ['集思录', '可转债', 'ETF'] },
    { name: '东财股吧情绪雷达-04', engine: 'firefox', tags: ['股吧', '情绪', '龙虎榜'] },
    { name: '证券之星基本面-05', engine: 'firefox', tags: ['证券之星', '估值', '财务'] },
    { name: '萝卜AI投研拆解-06', engine: 'chromium', tags: ['萝卜投研', 'AI拆解', '盈利预测'] },
    { name: '星桥资产轮动-07', engine: 'firefox', tags: ['星桥', '资产轮动', '周报'] },
    { name: '迈博券商研报-08', engine: 'firefox', tags: ['迈博汇金', '券商研报', '调研'] },
    { name: '统计局大周期-09', engine: 'firefox', tags: ['统计局', '宏观', 'PMI/社融'] },
    { name: '同花顺iFinD监控-10', engine: 'chromium', tags: ['iFinD', '北向资金', '两融'] },
  ];

  showToast('正在为您批量生成 10 大 A股 投研预设指纹环境...', 'info');
  for (const s of samples) {
    await fetch(`${API_BASE}/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
  }
  showToast('10 大 A股 投研指纹环境已生成完毕！', 'success');
  loadProfiles();
}

// 10. GEO (Generative Engine Optimization) 核心交互逻辑
function initGeoInteractions() {
  // 一键批量生成 AI 网页多地域沙箱
  const btnGeoGen = document.getElementById('btn-generate-geo-profiles');
  if (btnGeoGen) {
    btnGeoGen.onclick = async () => {
      showToast('正在批量创建 DeepSeek / 豆包 / 千问 多地域隔离沙箱...', 'info');
      const geoProfiles = [
        { name: 'DeepSeek网页端-北京', engine: 'firefox', tags: ['DeepSeek', 'GEO', '北京'], geo: { countryCode: 'CN', timezone: 'Asia/Shanghai', locale: 'zh-CN' } },
        { name: 'DeepSeek网页端-香港', engine: 'chromium', tags: ['DeepSeek', 'GEO', '香港'], geo: { countryCode: 'HK', timezone: 'Asia/Hong_Kong', locale: 'zh-HK' } },
        { name: '豆包网页端-上海', engine: 'firefox', tags: ['豆包', 'GEO', '上海'], geo: { countryCode: 'CN', timezone: 'Asia/Shanghai', locale: 'zh-CN' } },
        { name: '豆包网页端-广东', engine: 'chromium', tags: ['豆包', 'GEO', '广东'], geo: { countryCode: 'CN', timezone: 'Asia/Shanghai', locale: 'zh-CN' } },
        { name: '通义千问网页端-杭州', engine: 'firefox', tags: ['通义千问', 'GEO', '浙江'], geo: { countryCode: 'CN', timezone: 'Asia/Shanghai', locale: 'zh-CN' } },
        { name: '通义千问网页端-海外US', engine: 'chromium', tags: ['通义千问', 'GEO', '美国'], geo: { countryCode: 'US', timezone: 'America/New_York', locale: 'en-US' } },
      ];

      for (const p of geoProfiles) {
        await fetch(`${API_BASE}/profiles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p),
        });
      }
      showToast('6 个 GEO 多地域 AI 网页沙箱已生成完毕！', 'success');
      loadProfiles();
    };
  }

  // 打开 AI 独立网页窗口
  document.querySelectorAll('.btn-open-ai-web').forEach(btn => {
    btn.onclick = async () => {
      const url = btn.getAttribute('data-url');
      showToast(`正在以独立 Profile 打开浏览器窗口: ${url}`, 'info');
      try {
        const res = await fetch(`${API_BASE}/browser/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            headless: false,
            fingerprint: true,
            inputProfile: 'paced',
            countryCode: 'CN',
          }),
        });
        const json = await res.json();
        if (json.success) {
          showToast('AI 网页端独立窗口已在桌面弹出！', 'success');
        }
      } catch (err) {
        showToast(`启动失败: ${err.message}`, 'error');
      }
    };
  });

  // 运行 GEO 自动化关键词占位与提及率监测
  const btnRunTracker = document.getElementById('btn-run-geo-tracker');
  if (btnRunTracker) {
    btnRunTracker.onclick = async () => {
      const prompt = document.getElementById('geo-prompt-input').value.trim();
      const targetWord = document.getElementById('geo-target-word').value.trim();
      const platform = document.getElementById('geo-platform-select').value;
      const resultPanel = document.getElementById('geo-result-panel');
      const resultBody = document.getElementById('geo-result-body');
      const resultTitle = document.getElementById('geo-result-title');

      if (!prompt) {
        showToast('请输入目标 Prompt 提问词', 'error');
        return;
      }

      btnRunTracker.textContent = '🚀 正在自动向 AI 提问与监测中...';
      btnRunTracker.disabled = true;
      resultPanel.style.display = 'block';
      resultTitle.textContent = `GEO 监测报告 - ${platform.toUpperCase()} 对关键词【${targetWord || '目标词'}】的采信与推荐率`;
      resultBody.textContent = `⏳ 正在准备【${platform.toUpperCase()}】分析请求...\n🛡️ 正在使用受控服务端接口...\n📡 正在等待模型响应...`;

      try {
        // 调用配置了真实 API Key 的 AI 分析接口
        const res = await fetch(`${API_BASE}/ai/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: platform,
            prompt: `请以真实生成式搜索引擎的口吻客观详尽回答：${prompt}`,
            content: `用户提问关键词：${prompt}。重点监测品牌/标的：${targetWord}`,
          }),
        });
        const json = await res.json();
        if (json.success) {
          const reply = json.data.analysis || '';
          const isMentioned = targetWord ? reply.toLowerCase().includes(targetWord.toLowerCase()) : true;
          
          let rankScore = isMentioned ? 'TOP 1~3 (核心推荐)' : '未首屏推荐 (需加强语料铺设)';

          resultBody.textContent = `================================================================================
📊 GEO (生成式引擎优化) 自动化诊断与品牌占位报告
================================================================================
• 目标 AI 引擎: ${platform.toUpperCase()} (网页端对齐)
• 提问 Prompt: "${prompt}"
• 监测目标词: "${targetWord}"
• 品牌提及状态: ${isMentioned ? '✅ 成功被 AI 推荐采信 (Positive Mention)' : '⚪ 未在首要列表中提及 (No Direct Mention)'}
• AI 推荐排名预估: ${rankScore}
• 语义情感倾向: ${isMentioned ? '正面推荐 / 核心特征突出' : '中性'}

--------------------------------------------------------------------------------
📝 AI 实际生成的完整回答快照 (Snapshot):
--------------------------------------------------------------------------------
${reply}

--------------------------------------------------------------------------------
💡 GEO 优化实操建议:
1. 在知乎、微信公众号、主流科技门户及专业论坛中增加包含【${targetWord}】核心技术优势的长文本铺设；
2. 保持多地域环境定期向 ${platform.toUpperCase()} 提问，持续提升模型权重与知识库抓取概率！
================================================================================`;
          showToast('GEO 监测与占位分析完成！', 'success');
        } else {
          resultBody.textContent = `❌ 监测失败: ${json.message}`;
        }
      } catch (err) {
        resultBody.textContent = `❌ 网络异常: ${err.message}`;
      } finally {
        btnRunTracker.textContent = '🚀 启动 GEO 自动化提问与占位监测';
        btnRunTracker.disabled = false;
      }
    };
  }

  const btnCloseGeo = document.getElementById('btn-close-geo-result');
  if (btnCloseGeo) {
    btnCloseGeo.onclick = () => {
      document.getElementById('geo-result-panel').style.display = 'none';
    };
  }
}

// 11. 本地常用浏览器 (Chrome / Edge / Firefox) 扫描与一键导入
function initLocalBrowserMigration() {
  const btnScan = document.getElementById('btn-scan-local-browsers');
  const panel = document.getElementById('local-browser-scan-panel');
  const list = document.getElementById('local-browser-list');
  const btnClose = document.getElementById('btn-close-scan-panel');

  if (btnScan) {
    btnScan.onclick = async () => {
      btnScan.textContent = '🔍 正在扫描系统浏览器...';
      btnScan.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/migration/local-browsers`);
        const json = await res.json();
        if (json.success && json.data.length > 0) {
          panel.style.display = 'block';
          list.innerHTML = '';

          json.data.forEach((b) => {
            b.profiles.forEach((p) => {
              const dataBadges = [
                p.hasCookies ? 'Cookie' : '',
                p.hasLocalStorage ? 'Local Storage' : '',
                p.hasIndexedDb ? 'IndexedDB' : '',
              ].filter(Boolean);
              const item = document.createElement('div');
              item.style.display = 'flex';
              item.style.justifyContent = 'space-between';
              item.style.alignItems = 'center';
              item.style.padding = '10px 14px';
              item.style.background = 'var(--bg-surface)';
              item.style.border = '1px solid var(--border-color)';
              item.style.borderRadius = '6px';

              item.innerHTML = `
                <div>
                  <div style="font-weight: 600; color: #fff; display: flex; align-items: center; gap: 8px;">
                    <span>${b.type === 'chrome' ? '🌐 Google Chrome' : (b.type === 'edge' ? '🌊 Microsoft Edge' : '🦊 Firefox')}</span>
                    <span style="font-size: 11px; background: rgba(99, 102, 241, 0.2); color: #818cf8; padding: 2px 6px; border-radius: 4px;">${escapeHtml(p.name)}</span>
                    ${dataBadges.length ? `<span style="font-size: 11px; background: rgba(34, 197, 94, 0.2); color: #4ade80; padding: 2px 6px; border-radius: 4px;">🟢 ${escapeHtml(dataBadges.join(' / '))}</span>` : ''}
                    ${p.inUse ? '<span style="font-size: 11px; background: rgba(245, 158, 11, 0.2); color: #fbbf24; padding: 2px 6px; border-radius: 4px;">⚠️ 浏览器运行中</span>' : ''}
                  </div>
                  <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">${escapeHtml(p.path)}</div>
                  ${p.hasSavedPasswords ? '<div style="font-size: 11px; color: var(--text-dim); margin-top: 3px;">检测到密码库；为保护凭据，密码不会导入</div>' : ''}
                </div>
                <button class="btn btn-sm btn-primary btn-do-import" data-source-id="${p.sourceId}" data-browser="${escapeHtml(b.name)}" data-profile="${escapeHtml(p.name)}" ${p.inUse ? 'disabled' : ''}>
                  ${p.inUse ? '请先完全退出浏览器' : '📥 导入网站会话数据'}
                </button>
              `;

              list.appendChild(item);
            });
          });

          // 绑定一键导入事件
          list.querySelectorAll('.btn-do-import').forEach((importBtn) => {
            importBtn.onclick = async () => {
              const browserName = importBtn.getAttribute('data-browser');
              const profileName = importBtn.getAttribute('data-profile');
              const sourceId = importBtn.getAttribute('data-source-id');
              if (!window.confirm(`请先完全退出【${browserName}】，再导入 ${profileName}。\n\n将复制 Cookie、Local Storage、IndexedDB 和 Service Worker 存储；不会复制密码、历史记录或扩展。是否继续？`)) return;
              importBtn.textContent = '⏳ 正在导入...';
              importBtn.disabled = true;

              try {
                const impRes = await fetch(`${API_BASE}/migration/import-local`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sourceId, confirmBrowserClosed: true }),
                });
                const impJson = await impRes.json();
                if (impJson.success) {
                  const result = impJson.data;
                  showToast(`已导入 ${result.copiedFiles} 个会话文件：${(result.importedData || []).join('、') || '未发现可迁移数据'}`, 'success');
                  if (result.warnings?.length) showToast(result.warnings.join('；'), 'info');
                  importBtn.textContent = '✅ 已成功导入';
                  loadProfiles();
                } else {
                  showToast(`导入失败: ${impJson.message}`, 'error');
                  importBtn.textContent = '📥 导入网站会话数据';
                  importBtn.disabled = false;
                }
              } catch (err) {
                showToast(`请求异常: ${err.message}`, 'error');
                importBtn.disabled = false;
              }
            };
          });

          showToast(`已成功扫描到 ${json.data.length} 款浏览器的配置文件！`, 'success');
        } else {
          showToast('未在系统默认路径扫描到浏览器配置文件', 'info');
        }
      } catch (err) {
        showToast(`扫描失败: ${err.message}`, 'error');
      } finally {
        btnScan.textContent = '🔍 扫描本机常用浏览器';
        btnScan.disabled = false;
      }
    };
  }

  if (btnClose) {
    btnClose.onclick = () => {
      panel.style.display = 'none';
    };
  }
}

// 11.5 实时已连接 Bridge 浏览器与标签页拉取管理 (OpenCLI 架构)
function initBridgeBrowserSection() {
  const btnRefresh = document.getElementById('btn-refresh-bridge-browsers');
  const btnGuide = document.getElementById('btn-show-bridge-guide');
  const guideBox = document.getElementById('bridge-install-guide');

  if (btnRefresh) {
    btnRefresh.onclick = () => {
      loadBridgeBrowsers(true);
    };
  }

  if (btnGuide && guideBox) {
    btnGuide.onclick = () => {
      guideBox.style.display = guideBox.style.display === 'none' ? 'block' : 'none';
    };
  }
}

async function loadBridgeBrowsers(showNotice = false) {
  const container = document.getElementById('bridge-browsers-container');
  const badge = document.getElementById('bridge-browser-count-badge');
  if (!container) return;

  try {
    const res = await fetch(`${API_BASE}/bridge/browsers`);
    const json = await res.json();
    if (!json.success) throw new Error(json.message || '获取失败');

    const browsers = json.data?.items || [];
    if (badge) {
      badge.textContent = `${browsers.length} 个浏览器在线`;
      badge.style.background = browsers.length > 0 ? 'rgba(34, 197, 94, 0.2)' : 'rgba(148, 163, 184, 0.2)';
      badge.style.color = browsers.length > 0 ? '#4ade80' : '#94a3b8';
    }

    if (browsers.length === 0) {
      container.innerHTML = `
        <div style="color: var(--text-dim); font-size: 12px; padding: 16px; text-align: center; background: rgba(15, 23, 42, 0.4); border-radius: 6px; border: 1px dashed rgba(148, 163, 184, 0.2);">
          暂无已连接的宿主浏览器。<br>
          <span style="font-size: 11px; margin-top: 4px; display: inline-block;">
            请在常用的 Google Chrome 或 Microsoft Edge 浏览器加载 <code>browser-bridge-extension</code> 扩展，扩展将自动探测并建立免密码有界连接。
          </span>
        </div>
      `;
      if (showNotice) showToast('当前无在线 Bridge 浏览器，请先启动扩展', 'info');
      return;
    }

    container.innerHTML = '';
    browsers.forEach((b) => {
      const card = document.createElement('div');
      card.style.background = 'var(--bg-surface)';
      card.style.border = '1px solid rgba(99, 102, 241, 0.3)';
      card.style.borderRadius = '8px';
      card.style.padding = '14px';

      const activeTabInfo = b.activeTab ? `
        <div style="font-size: 12px; color: #a5b4fc; background: rgba(99, 102, 241, 0.1); padding: 4px 8px; border-radius: 4px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <strong>当前活动页面：</strong>${escapeHtml(b.activeTab.title || b.activeTab.url || '未知页面')}
        </div>
      ` : '';

      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <div style="font-weight: 600; color: #fff; font-size: 14px; display: flex; align-items: center; gap: 8px;">
              <span>🌐 ${escapeHtml(b.name || b.id)}</span>
              <span style="font-size: 10px; background: rgba(34, 197, 94, 0.2); color: #4ade80; padding: 2px 6px; border-radius: 4px;">🟢 ${b.state}</span>
              ${b.contextId ? `<span style="font-size: 10px; background: rgba(148, 163, 184, 0.2); color: #cbd5e1; padding: 2px 6px; border-radius: 4px;">ID: ${escapeHtml(b.contextId)}</span>` : ''}
            </div>
            <div style="font-size: 11px; color: var(--text-dim); margin-top: 4px;">
              浏览器内核: ${b.engine} · 连接时间: ${new Date(b.bridgeConnectedAt || b.updatedAt).toLocaleTimeString()}
            </div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-sm btn-primary btn-pull-tabs" data-id="${b.id}">📋 拉取所有标签页</button>
            <button class="btn btn-sm btn-secondary btn-snap-page" data-id="${b.id}">👁️ 提取快照</button>
            <button class="btn btn-sm btn-outline btn-open-url" data-id="${b.id}">➕ 打开网页</button>
          </div>
        </div>
        ${activeTabInfo}
        <div class="tabs-display-area" id="tabs-area-${b.id}" style="display: none; margin-top: 12px; padding: 10px; background: rgba(15, 23, 42, 0.6); border-radius: 6px;">
          <div style="font-size: 12px; font-weight: 600; margin-bottom: 8px; color: #cbd5e1; display: flex; justify-content: space-between;">
            <span>已打开的标签页列表（实时拉取自 Chrome 宿主）：</span>
            <span class="tabs-count" style="color: #94a3b8; font-weight: normal;"></span>
          </div>
          <div class="tabs-list-container" style="display: flex; flex-direction: column; gap: 6px;"></div>
        </div>
      `;

      // 绑定拉取标签页按钮
      const btnPull = card.querySelector('.btn-pull-tabs');
      const tabsArea = card.querySelector(`#tabs-area-${b.id}`);
      const tabsList = tabsArea.querySelector('.tabs-list-container');
      const tabsCount = tabsArea.querySelector('.tabs-count');

      btnPull.onclick = async () => {
        btnPull.textContent = '⏳ 正在拉取…';
        btnPull.disabled = true;
        try {
          const tRes = await fetch(`${API_BASE}/bridge/browsers/${encodeURIComponent(b.id)}/tabs`);
          const tJson = await tRes.json();
          if (!tJson.success) throw new Error(tJson.message || '拉取标签页失败');

          const tabs = tJson.data?.tabs || [];
          tabsArea.style.display = 'block';
          tabsCount.textContent = `共 ${tabs.length} 个标签`;
          tabsList.innerHTML = '';

          if (tabs.length === 0) {
            tabsList.innerHTML = '<div style="font-size: 12px; color: #94a3b8;">未拉取到任何标签页</div>';
          } else {
            tabs.forEach((t) => {
              const tabItem = document.createElement('div');
              tabItem.style.display = 'flex';
              tabItem.style.justifyContent = 'space-between';
              tabItem.style.alignItems = 'center';
              tabItem.style.padding = '8px 10px';
              tabItem.style.background = t.active ? 'rgba(99, 102, 241, 0.15)' : 'rgba(30, 41, 59, 0.8)';
              tabItem.style.border = t.active ? '1px solid rgba(99, 102, 241, 0.4)' : '1px solid rgba(148, 163, 184, 0.1)';
              tabItem.style.borderRadius = '4px';

              tabItem.innerHTML = `
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 65%;">
                  <div style="font-size: 12px; font-weight: ${t.active ? '600' : 'normal'}; color: #fff;">
                    ${t.active ? '🟢 ' : ''}${escapeHtml(t.title || '无标题网页')}
                  </div>
                  <div style="font-size: 11px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${escapeHtml(t.url)}
                  </div>
                </div>
                <div style="display: flex; gap: 6px; align-items: center;">
                  ${t.active ? '<span style="font-size: 10px; color: #818cf8; background: rgba(99, 102, 241, 0.2); padding: 2px 6px; border-radius: 4px;">当前活动</span>' : ''}
                  <button class="btn btn-xs btn-primary btn-bind-tab" data-tab-id="${t.tabId}">📌 绑定此页面</button>
                  <button class="btn btn-xs btn-secondary btn-close-tab" data-tab-id="${t.tabId}">✕ 关闭</button>
                </div>
              `;

              // 绑定此页面
              tabItem.querySelector('.btn-bind-tab').onclick = async (e) => {
                const targetBtn = e.target;
                targetBtn.disabled = true;
                targetBtn.textContent = '…';
                try {
                  const bRes = await fetch(`${API_BASE}/bridge/browsers/${encodeURIComponent(b.id)}/tabs/bind`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tabId: t.tabId }),
                  });
                  const bJson = await bRes.json();
                  if (bJson.success) {
                    showToast(`已成功将控制权绑定到页面：${t.title || t.url}`, 'success');
                    await loadBridgeBrowsers();
                  } else {
                    showToast(`绑定失败: ${bJson.message}`, 'error');
                  }
                } catch (err) {
                  showToast(`请求异常: ${err.message}`, 'error');
                }
              };

              // 关闭标签
              tabItem.querySelector('.btn-close-tab').onclick = async () => {
                if (!window.confirm(`确定要关闭标签页【${t.title || t.url}】吗？`)) return;
                try {
                  const cRes = await fetch(`${API_BASE}/bridge/browsers/${encodeURIComponent(b.id)}/tabs/close`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tabId: t.tabId }),
                  });
                  const cJson = await cRes.json();
                  if (cJson.success) {
                    showToast('标签页已关闭', 'success');
                    tabItem.remove();
                  }
                } catch (err) {
                  showToast(`关闭失败: ${err.message}`, 'error');
                }
              };

              tabsList.appendChild(tabItem);
            });
          }
        } catch (err) {
          showToast(`拉取标签页失败: ${err.message}`, 'error');
        } finally {
          btnPull.textContent = '📋 拉取所有标签页';
          btnPull.disabled = false;
        }
      };

      // 提取快照按钮
      card.querySelector('.btn-snap-page').onclick = async () => {
        showToast('正在从宿主浏览器拉取当前页面快照…', 'info');
        try {
          const sRes = await fetch(`${API_BASE}/bridge/browsers/${encodeURIComponent(b.id)}/snapshot`);
          const sJson = await sRes.json();
          if (sJson.success) {
            const data = sJson.data || {};
            const targetsCount = (data.targets || []).length;
            const previewText = (data.text || '').slice(0, 200);
            window.alert(`✅ 页面快照提取成功！\n\n网址: ${data.url}\n标题: ${data.title}\n可交互元素: ${targetsCount} 个\n\n正文片段预览:\n${previewText}...`);
          } else {
            showToast(`快照提取失败: ${sJson.message}`, 'error');
          }
        } catch (err) {
          showToast(`提取快照异常: ${err.message}`, 'error');
        }
      };

      // 打开新网页
      card.querySelector('.btn-open-url').onclick = async () => {
        const url = window.prompt('请输入要在该宿主浏览器中打开的完整网址（如 https://www.taobao.com）：');
        if (!url || !url.trim()) return;
        try {
          const oRes = await fetch(`${API_BASE}/bridge/browsers/${encodeURIComponent(b.id)}/tabs/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url.trim(), active: true }),
          });
          const oJson = await oRes.json();
          if (oJson.success) {
            showToast('已成功在宿主浏览器打开新标签页！', 'success');
            await loadBridgeBrowsers();
          } else {
            showToast(`打开失败: ${oJson.message}`, 'error');
          }
        } catch (err) {
          showToast(`请求异常: ${err.message}`, 'error');
        }
      };

      container.appendChild(card);
    });

    if (showNotice) showToast(`已刷新，当前 ${browsers.length} 个宿主浏览器在线`, 'success');
  } catch (err) {
    if (showNotice) showToast(`刷新 Bridge 浏览器失败: ${err.message}`, 'error');
  }
}

// 12. CSV 批量导入与导出
function initCsvModal() {
  const modal = document.getElementById('csv-modal');
  const btnOpenImport = document.getElementById('btn-import-csv');
  const btnClose = document.getElementById('btn-close-csv-modal');
  const btnCancel = document.getElementById('btn-cancel-csv-modal');
  const btnSubmit = document.getElementById('btn-submit-csv-import');
  const btnExport = document.getElementById('btn-export-csv');
  const btnDownloadTemplate = document.getElementById('btn-download-csv-template');
  const textarea = document.getElementById('csv-import-content');

  if (btnOpenImport) {
    btnOpenImport.onclick = () => {
      modal.classList.add('active');
    };
  }
  const hideCsvModal = () => modal.classList.remove('active');
  if (btnClose) btnClose.onclick = hideCsvModal;
  if (btnCancel) btnCancel.onclick = hideCsvModal;

  // 下载标准模板
  if (btnDownloadTemplate) {
    btnDownloadTemplate.onclick = () => {
      const template = `环境名称,分组标签,内核类型,代理类型,代理服务器,代理账号,代理密码,2FA秘钥,Cookie\n亚马逊店铺-US-01,跨境电商/美区,firefox,socks5,127.0.0.1:10808,,,JBSWY3DPEHPK3PXP,\nTikTok矩阵-02,社媒矩阵/东南亚,chromium,http,user:pass@114.114.114.114:8080,,,,\nGoogle测试-03,授权测试,firefox,direct,,,,`;
      const blob = new Blob(['\uFEFF' + template], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '指纹环境批量导入标准模板.csv';
      a.click();
    };
  }

  // 提交批量导入
  if (btnSubmit) {
    btnSubmit.onclick = async () => {
      const content = textarea.value.trim();
      if (!content) {
        showToast('请粘贴或输入 CSV 文本内容', 'error');
        return;
      }
      btnSubmit.textContent = '⏳ 正在解析并创建沙箱...';
      btnSubmit.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/profiles/batch-import-csv`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: content }),
        });
        const json = await res.json();
        if (json.success) {
          showToast(`🎉 成功批量导入并生成了 ${json.data.totalImported} 个独立指纹环境！`, 'success');
          hideCsvModal();
          loadProfiles();
        } else {
          showToast(`导入失败: ${json.message}`, 'error');
        }
      } catch (err) {
        showToast(`网络异常: ${err.message}`, 'error');
      } finally {
        btnSubmit.textContent = '🚀 立即批量导入环境';
        btnSubmit.disabled = false;
      }
    };
  }

  // 导出 CSV
  if (btnExport) {
    btnExport.onclick = () => {
      window.open(`${API_BASE}/profiles/batch-export-csv`, '_blank');
      showToast('正在导出当前所有环境为 CSV 表格...', 'info');
    };
  }
}

// 13. 2FA (TOTP) 谷歌身份验证器动态计算
let active2faTimer = null;
function init2faModal() {
  const modal = document.getElementById('2fa-modal');
  const btnClose = document.getElementById('btn-close-2fa-modal');
  const codeDisplay = document.getElementById('2fa-code-display');
  const timerDisplay = document.getElementById('2fa-timer');
  const secretInput = document.getElementById('2fa-secret-input');
  const btnCopy = document.getElementById('btn-copy-2fa-code');

  if (btnClose) btnClose.onclick = () => {
    modal.classList.remove('active');
    if (active2faTimer) clearInterval(active2faTimer);
  };

  // 挂钩表格中的 🔑 2FA 按钮
  document.addEventListener('click', async (e) => {
    const target = e.target.closest('.btn-open-2fa');
    if (!target) return;
    const name = target.getAttribute('data-name');
    const profileId = target.getAttribute('data-id');

    document.getElementById('2fa-profile-name').textContent = `当前环境: ${name}`;
    secretInput.value = '••••••••（服务端保管）';
    modal.classList.add('active');

    const updateCode = async () => {
      try {
        const res = await fetch(`${API_BASE}/2fa/generate?profileId=${encodeURIComponent(profileId)}`);
        const json = await res.json();
        if (json.success) {
          codeDisplay.textContent = json.data.code;
          timerDisplay.textContent = `${json.data.remainingSeconds}s`;
        } else {
          codeDisplay.textContent = '未配置';
          timerDisplay.textContent = '--';
        }
      } catch (_) {}
    };

    await updateCode();
    if (active2faTimer) clearInterval(active2faTimer);
    active2faTimer = setInterval(updateCode, 1000);
  });

  if (btnCopy) {
    btnCopy.onclick = () => {
      const code = codeDisplay.textContent.trim();
      navigator.clipboard.writeText(code);
      showToast(`2FA 验证码【${code}】已复制到剪贴板`, 'success');
    };
  }
}

// 持久代理池
function initProxyPool() {
  const addButton = document.getElementById('btn-add-pool-proxy');
  if (!addButton) return;
  addButton.onclick = async () => {
    const name = document.getElementById('pool-proxy-name').value.trim();
    const server = document.getElementById('pool-proxy-server').value.trim();
    const tags = document.getElementById('pool-proxy-tags').value.split(/[,，]/).map(v => v.trim()).filter(Boolean);
    if (!name || !server) return showToast('请填写代理名称和地址', 'error');
    try {
      const res = await fetch(`${API_BASE}/proxies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, server, tags }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message || '保存失败');
      document.getElementById('pool-proxy-name').value = '';
      document.getElementById('pool-proxy-server').value = '';
      document.getElementById('pool-proxy-tags').value = '';
      showToast('代理已加入持久代理池', 'success');
      await loadProxyPool();
    } catch (error) { showToast(`代理保存失败: ${error.message}`, 'error'); }
  };
}

async function loadProxyPool() {
  const container = document.getElementById('proxy-pool-list');
  if (!container) return;
  try {
    const res = await fetch(`${API_BASE}/proxies`);
    const json = await res.json();
    if (!json.success) return;
    state.proxies = json.data || [];
    container.innerHTML = state.proxies.length ? state.proxies.map(proxy => `
      <div class="settings-card" style="margin-bottom:8px;display:flex;align-items:center;gap:10px">
        <div style="flex:1"><strong>${escapeHtml(proxy.name)}</strong><div style="font-size:12px;color:var(--text-dim)">${escapeHtml(proxy.server)} · ${escapeHtml((proxy.tags || []).join(', '))}</div></div>
        <span class="tag-badge">${proxy.enabled ? 'enabled' : 'disabled'} / ${escapeHtml(proxy.health || 'unknown')}</span>
        <button class="btn btn-xs btn-outline" data-proxy-edit="${proxy.proxyId}">编辑</button>
        <button class="btn btn-xs btn-outline" data-proxy-toggle="${proxy.proxyId}">${proxy.enabled ? '停用' : '启用'}</button>
        <button class="btn btn-xs btn-outline" data-proxy-check="${proxy.proxyId}">检查</button>
        <button class="btn btn-xs btn-danger" data-proxy-delete="${proxy.proxyId}">删除</button>
      </div>`).join('') : '<div style="color:var(--text-dim)">代理池为空</div>';
    container.querySelectorAll('[data-proxy-check]').forEach(button => button.onclick = async () => {
      button.disabled = true;
      try {
        const response = await fetch(`${API_BASE}/proxies/${encodeURIComponent(button.dataset.proxyCheck)}/check`, { method: 'POST' });
        const result = await response.json();
        showToast(result.success ? `检查完成: ${result.data.health}` : (result.message || '检查失败'), result.success ? 'success' : 'error');
      } finally { button.disabled = false; await loadProxyPool(); }
    });
    container.querySelectorAll('[data-proxy-edit]').forEach(button => button.onclick = async () => {
      const proxy = state.proxies.find(item => item.proxyId === button.dataset.proxyEdit);
      if (!proxy) return;
      const name = prompt('代理名称：', proxy.name);
      if (name === null || !name.trim()) return;
      const tagsText = prompt('标签（逗号分隔）：', (proxy.tags || []).join(','));
      if (tagsText === null) return;
      await fetch(`${API_BASE}/proxies/${encodeURIComponent(proxy.proxyId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), tags: tagsText.split(/[,，]/).map(value => value.trim()).filter(Boolean) }),
      });
      await loadProxyPool();
    });
    container.querySelectorAll('[data-proxy-toggle]').forEach(button => button.onclick = async () => {
      const proxy = state.proxies.find(item => item.proxyId === button.dataset.proxyToggle);
      if (!proxy) return;
      await fetch(`${API_BASE}/proxies/${encodeURIComponent(proxy.proxyId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !proxy.enabled }),
      });
      await loadProxyPool();
    });
    container.querySelectorAll('[data-proxy-delete]').forEach(button => button.onclick = async () => {
      if (!confirm('确定从代理池删除该代理？')) return;
      await fetch(`${API_BASE}/proxies/${encodeURIComponent(button.dataset.proxyDelete)}`, { method: 'DELETE' });
      await loadProxyPool();
    });
  } catch (error) { container.innerHTML = `<div style="color:var(--danger)">${escapeHtml(error.message)}</div>`; }
}

// 声明式 RPA 工作流与任务
function initRpaStudio() {
  const saveButton = document.getElementById('btn-save-rpa');
  if (!saveButton) return;
  saveButton.onclick = async () => {
    const name = document.getElementById('rpa-name').value.trim();
    try {
      const steps = JSON.parse(document.getElementById('rpa-steps').value);
      const editingId = state.editingWorkflowId;
      const res = await fetch(editingId ? `${API_BASE}/rpa/workflows/${encodeURIComponent(editingId)}` : `${API_BASE}/rpa/workflows`, {
        method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, steps }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message || '工作流保存失败');
      state.editingWorkflowId = null;
      saveButton.textContent = '保存工作流';
      showToast(editingId ? '工作流已更新' : '工作流已保存', 'success');
      await loadRpaStudio();
    } catch (error) { showToast(`工作流无效: ${error.message}`, 'error'); }
  };
}

function refreshRpaProfileOptions() {
  const select = document.getElementById('rpa-profile-select');
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">请选择 Profile</option>' + state.profiles.map(profile => `<option value="${profile.profileId}">${escapeHtml(profile.name)}</option>`).join('');
  if (state.profiles.some(profile => profile.profileId === selected)) select.value = selected;
}

async function loadRpaStudio() {
  const workflowsContainer = document.getElementById('rpa-workflow-list');
  const tasksContainer = document.getElementById('rpa-task-list');
  if (!workflowsContainer || !tasksContainer) return;
  try {
    const [workflowResponse, taskResponse] = await Promise.all([fetch(`${API_BASE}/rpa/workflows`), fetch(`${API_BASE}/rpa/tasks`)]);
    const [workflowJson, taskJson] = await Promise.all([workflowResponse.json(), taskResponse.json()]);
    state.workflows = workflowJson.success ? workflowJson.data || [] : [];
    state.rpaTasks = taskJson.success ? taskJson.data || [] : [];
    workflowsContainer.innerHTML = state.workflows.length ? state.workflows.map(workflow => `
      <div class="settings-card" style="margin-bottom:8px;display:flex;align-items:center;gap:10px">
        <div style="flex:1"><strong>${escapeHtml(workflow.name)}</strong><div style="font-size:12px;color:var(--text-dim)">${workflow.steps.length} 个受策略约束的步骤</div></div>
        <button class="btn btn-xs btn-success" data-rpa-run="${workflow.workflowId}">运行</button>
        <button class="btn btn-xs btn-outline" data-rpa-edit="${workflow.workflowId}">编辑</button>
        <button class="btn btn-xs btn-danger" data-rpa-delete="${workflow.workflowId}">删除</button>
      </div>`).join('') : '<div style="color:var(--text-dim)">暂无工作流</div>';
    tasksContainer.innerHTML = state.rpaTasks.length ? '<h4>最近任务</h4>' + state.rpaTasks.slice(0, 20).map(task => `
      <div class="settings-card" style="margin-bottom:6px;display:flex;align-items:center;gap:10px">
        <div style="flex:1"><strong>${escapeHtml(task.taskId)}</strong><div style="font-size:12px;color:var(--text-dim)">${escapeHtml(task.profileId)} · ${task.completedSteps} 步</div></div>
        <span class="tag-badge">${escapeHtml(task.state)}</span>
        ${['QUEUED','RUNNING'].includes(task.state) ? `<button class="btn btn-xs btn-danger" data-rpa-cancel="${task.taskId}">取消</button>` : ''}
        <details style="width:100%"><summary style="cursor:pointer">日志</summary><pre style="white-space:pre-wrap;font-size:11px">${escapeHtml((task.logs || []).map(log => `${new Date(log.at).toLocaleString()} ${log.event}${log.step === undefined ? '' : ` step=${log.step}`}`).join('\n'))}</pre></details>
      </div>`).join('') : '';
    workflowsContainer.querySelectorAll('[data-rpa-run]').forEach(button => button.onclick = async () => {
      const profileId = document.getElementById('rpa-profile-select').value;
      if (!profileId) return showToast('请先选择运行环境', 'error');
      const scheduledValue = document.getElementById('rpa-scheduled-at').value;
      const intervalMinutes = Number(document.getElementById('rpa-interval-minutes').value);
      const scheduledAt = scheduledValue ? new Date(scheduledValue).getTime() : undefined;
      const intervalMs = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes * 60_000 : undefined;
      const response = await fetch(`${API_BASE}/rpa/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: button.dataset.rpaRun, profileId, headless: false, ...(scheduledAt ? { scheduledAt } : {}), ...(intervalMs ? { intervalMs } : {}) }),
      });
      const result = await response.json();
      showToast(result.success ? 'RPA 任务已进入队列' : (result.message || '任务创建失败'), result.success ? 'success' : 'error');
      await loadRpaStudio();
    });
    workflowsContainer.querySelectorAll('[data-rpa-delete]').forEach(button => button.onclick = async () => {
      if (!confirm('确定删除该工作流？')) return;
      await fetch(`${API_BASE}/rpa/workflows/${encodeURIComponent(button.dataset.rpaDelete)}`, { method: 'DELETE' });
      await loadRpaStudio();
    });
    workflowsContainer.querySelectorAll('[data-rpa-edit]').forEach(button => button.onclick = () => {
      const workflow = state.workflows.find(item => item.workflowId === button.dataset.rpaEdit);
      if (!workflow) return;
      state.editingWorkflowId = workflow.workflowId;
      document.getElementById('rpa-name').value = workflow.name;
      document.getElementById('rpa-steps').value = JSON.stringify(workflow.steps, null, 2);
      document.getElementById('btn-save-rpa').textContent = '更新工作流';
      document.getElementById('rpa-name').focus();
    });
    tasksContainer.querySelectorAll('[data-rpa-cancel]').forEach(button => button.onclick = async () => {
      await fetch(`${API_BASE}/rpa/tasks/${encodeURIComponent(button.dataset.rpaCancel)}/cancel`, { method: 'POST' });
      await loadRpaStudio();
    });
  } catch (error) { tasksContainer.innerHTML = `<div style="color:var(--danger)">${escapeHtml(error.message)}</div>`; }
}

// 受管扩展中心
function initManagedExtensions() {
  const importButton = document.getElementById('btn-import-managed-extension');
  const profileSelect = document.getElementById('extension-profile-select');
  const saveButton = document.getElementById('btn-save-extension-assignment');
  if (importButton) importButton.onclick = async () => {
    const file = document.getElementById('managed-extension-file').files?.[0];
    if (!file) return showToast('请选择 ZIP 或 XPI 扩展包', 'error');
    if (file.size > 12 * 1024 * 1024) return showToast('扩展包不能超过 12 MiB', 'error');
    importButton.disabled = true;
    try {
      const packageBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      const response = await fetch(`${API_BASE}/extensions/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageBase64, approveHighRisk: document.getElementById('managed-extension-risk-approval').checked }) });
      const result = await response.json();
      if (!result.success) throw new Error(result.message || result.code || '导入失败');
      document.getElementById('managed-extension-file').value = '';
      document.getElementById('managed-extension-risk-approval').checked = false;
      showToast(`扩展 ${result.data.name} ${result.data.version} 已校验并入库`, 'success'); await loadManagedExtensions();
    } catch (error) { showToast(`扩展导入失败: ${error.message}`, 'error'); }
    finally { importButton.disabled = false; }
  };
  if (profileSelect) profileSelect.onchange = renderExtensionAssignments;
  if (saveButton) saveButton.onclick = async () => {
    const profileId = profileSelect.value; if (!profileId) return showToast('请选择 Profile', 'error');
    const extensionIds = Array.from(document.getElementById('extension-assignment-select').selectedOptions).map(option => option.value);
    const response = await fetch(`${API_BASE}/profiles/${encodeURIComponent(profileId)}/extensions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extensionIds }) });
    const result = await response.json(); if (!result.success) return showToast(result.message || '分配失败', 'error');
    const index = state.profiles.findIndex(profile => profile.profileId === profileId); if (index >= 0) state.profiles[index] = { ...state.profiles[index], extensionIds: result.data.extensionIds || [] };
    showToast('扩展分配已保存，重启该 Profile 后生效', 'success'); renderExtensionAssignments();
  };
}

async function loadManagedExtensions() {
  const container = document.getElementById('managed-extension-list'); if (!container) return;
  try {
    const response = await fetch(`${API_BASE}/extensions`); const result = await response.json();
    if (!result.success) throw new Error(result.message || '加载失败'); state.extensions = result.data || [];
    container.innerHTML = state.extensions.length ? state.extensions.map(extension => `<div class="settings-card" style="margin-bottom:8px;display:flex;align-items:center;gap:10px"><div style="flex:1"><strong>${escapeHtml(extension.name)} ${escapeHtml(extension.version)}</strong><div style="font-size:12px;color:var(--text-dim)">${escapeHtml(extension.extensionId)} · MV${extension.manifestVersion} · ${escapeHtml((extension.engines || []).join('/'))} · SHA-256 ${escapeHtml(extension.sha256.slice(0, 12))}…</div><div style="font-size:12px;color:${extension.highRiskPermissions?.length ? 'var(--warning)' : 'var(--text-dim)'}">权限: ${escapeHtml([...(extension.permissions || []), ...(extension.hostPermissions || [])].join(', ') || '无')}</div><div style="font-size:12px;color:var(--text-dim)">Firefox: ${extension.firefoxSignaturePresent ? '已识别 Mozilla 签名结构，启动时原生复验' : '不可用（需要固定 Gecko ID 与 Mozilla 签名）'}</div></div><span class="tag-badge">${extension.enabled ? 'enabled' : 'disabled'}</span><button class="btn btn-xs btn-outline" data-extension-toggle="${extension.extensionId}">${extension.enabled ? '停用' : '启用'}</button><button class="btn btn-xs btn-danger" data-extension-delete="${extension.extensionId}">删除</button></div>`).join('') : '<div style="color:var(--text-dim)">扩展中心为空</div>';
    container.querySelectorAll('[data-extension-toggle]').forEach(button => button.onclick = async () => { const extension = state.extensions.find(item => item.extensionId === button.dataset.extensionToggle); const response = await fetch(`${API_BASE}/extensions/${encodeURIComponent(extension.extensionId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !extension.enabled }) }); const result = await response.json(); if (!result.success) return showToast(result.message || '更新失败', 'error'); await loadManagedExtensions(); });
    container.querySelectorAll('[data-extension-delete]').forEach(button => button.onclick = async () => { if (!confirm('删除前必须先从所有 Profile 取消分配，确定继续？')) return; const response = await fetch(`${API_BASE}/extensions/${encodeURIComponent(button.dataset.extensionDelete)}`, { method: 'DELETE' }); const result = await response.json(); if (!result.success) return showToast(result.message || '删除失败', 'error'); await loadManagedExtensions(); });
    renderExtensionAssignments();
  } catch (error) { container.innerHTML = `<div style="color:var(--danger)">${escapeHtml(error.message)}</div>`; }
}

function renderExtensionAssignments() {
  const profileSelect = document.getElementById('extension-profile-select'); const assignment = document.getElementById('extension-assignment-select');
  if (!profileSelect || !assignment) return;
  const previous = profileSelect.value;
  profileSelect.innerHTML = state.profiles.map(profile => `<option value="${escapeHtml(profile.profileId)}">${escapeHtml(profile.name)} (${escapeHtml(profile.engine || 'firefox')})</option>`).join('');
  if (state.profiles.some(profile => profile.profileId === previous)) profileSelect.value = previous;
  const profile = state.profiles.find(item => item.profileId === profileSelect.value); const assigned = new Set(profile?.extensionIds || []);
  assignment.innerHTML = state.extensions.filter(extension => extension.engines?.includes(profile?.engine || 'firefox')).map(extension => `<option value="${escapeHtml(extension.extensionId)}" ${assigned.has(extension.extensionId) ? 'selected' : ''}>${escapeHtml(extension.name)} ${escapeHtml(extension.version)}${extension.enabled ? '' : '（已停用）'}</option>`).join('');
}

function bytesToBase64(bytes) { let binary = ''; const chunk = 0x8000; for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk)); return btoa(binary); }

// 团队、工作区、资源授权与 API Key
function initTeamAdmin() {
  const createWorkspace = document.getElementById('btn-create-workspace');
  const createMember = document.getElementById('btn-create-team-member');
  if (createWorkspace) createWorkspace.onclick = async () => {
    const name = document.getElementById('team-workspace-name').value.trim();
    if (!name) return showToast('请输入工作区名称', 'error');
    const response = await fetch(`${API_BASE}/team/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const result = await response.json(); if (!result.success) return showToast(result.message || '创建失败', 'error');
    document.getElementById('team-workspace-name').value = ''; await loadTeamAdmin(); showToast('工作区已创建', 'success');
  };
  if (createMember) createMember.onclick = async () => {
    const workspaceId = document.getElementById('team-member-workspace').value;
    const name = document.getElementById('team-member-name').value.trim();
    const role = document.getElementById('team-member-role').value;
    const profileText = document.getElementById('team-member-profiles').value;
    const extensionText = document.getElementById('team-member-extensions').value;
    if (!workspaceId || !name) return showToast('请选择工作区并填写成员名称', 'error');
    const profile = profileText.split(/[,，]/).map(value => value.trim()).filter(Boolean);
    const extension = extensionText.split(/[,，]/).map(value => value.trim()).filter(Boolean);
    const response = await fetch(`${API_BASE}/team/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, name, role, grants: { profile, extension } }) });
    const result = await response.json(); if (!result.success) return showToast(result.message || '成员创建失败', 'error');
    await loadTeamAdmin(); showToast('成员已添加', 'success');
  };
}

async function loadTeamAdmin() {
  const list = document.getElementById('team-member-list');
  if (!list) return;
  try {
    const [workspaceResponse, memberResponse] = await Promise.all([fetch(`${API_BASE}/team/workspaces`), fetch(`${API_BASE}/team/members`)]);
    const [workspaces, members] = await Promise.all([workspaceResponse.json(), memberResponse.json()]);
    if (!workspaces.success || !members.success) throw new Error(workspaces.message || members.message || '权限不足');
    state.workspaces = workspaces.data || []; state.members = members.data || [];
    const select = document.getElementById('team-member-workspace');
    select.innerHTML = state.workspaces.map(item => `<option value="${escapeHtml(item.workspaceId)}">${escapeHtml(item.name)}</option>`).join('');
    list.innerHTML = state.members.length ? state.members.map(member => `<div class="settings-card" style="margin-bottom:8px;display:flex;gap:10px;align-items:center"><div style="flex:1"><strong>${escapeHtml(member.name)}</strong><div style="font-size:12px;color:var(--text-dim)">${escapeHtml(member.memberId)} · ${escapeHtml(member.workspaceId)} · ${escapeHtml(member.role)} · ${escapeHtml(member.state)}</div></div><button class="btn btn-xs btn-primary" data-issue-member-key="${escapeHtml(member.memberId)}">签发 API Key</button></div>`).join('') : '<div style="color:var(--text-dim)">尚无团队成员</div>';
    list.querySelectorAll('[data-issue-member-key]').forEach(button => button.onclick = async () => {
      const response = await fetch(`${API_BASE}/team/members/${encodeURIComponent(button.dataset.issueMemberKey)}/api-keys`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Studio generated' }) });
      const result = await response.json(); if (!result.success) return showToast(result.message || '签发失败', 'error');
      const box = document.getElementById('team-issued-key'); box.style.display = 'block'; box.innerHTML = `<strong>请立即保存，此 Token 不会再次显示：</strong><br><code style="word-break:break-all">${escapeHtml(result.data.token)}</code>`;
    });
  } catch (error) { list.innerHTML = `<div style="color:var(--danger)">${escapeHtml(error.message)}</div>`; }
}

// 多窗口主从群控同步器
function initSynchronizerModal() {
  const modal = document.getElementById('synchronizer-modal');
  const btnOpen = document.getElementById('btn-open-synchronizer');
  const btnClose = document.getElementById('btn-close-sync-modal');
  const btnCancel = document.getElementById('btn-cancel-sync-modal');
  const masterSelect = document.getElementById('sync-master-select');
  const btnNavigate = document.getElementById('btn-sync-navigate');
  const urlInput = document.getElementById('sync-url-input');
  const btnReload = document.getElementById('btn-sync-reload-all');
  const btnScrollDown = document.getElementById('btn-sync-scroll-down');
  const btnScrollUp = document.getElementById('btn-sync-scroll-up');
  const btnStartCapture = document.getElementById('btn-sync-start-capture');
  const btnStopCapture = document.getElementById('btn-sync-stop-capture');
  let activeCaptureId = null;

  const hideModal = () => modal.classList.remove('active');
  if (btnClose) btnClose.onclick = hideModal;
  if (btnCancel) btnCancel.onclick = hideModal;

  if (btnOpen) {
    btnOpen.onclick = () => {
      if (state.activeSessions.size === 0) {
        showToast('当前没有运行中的浏览器窗口，请先打开 2 个以上窗口再开启群控同步', 'info');
        return;
      }
      masterSelect.innerHTML = '';
      for (const [profileId, sid] of state.activeSessions.entries()) {
        const opt = document.createElement('option');
        opt.value = sid;
        opt.textContent = `主控环境: ${profileId} (${sid})`;
        masterSelect.appendChild(opt);
      }
      modal.classList.add('active');
    };
  }

  const broadcastAction = async (action) => {
    const allSessionIds = Array.from(state.activeSessions.values());
    if (allSessionIds.length === 0) return;
    showToast(`正在向 ${allSessionIds.length} 个窗口广播群控动作...`, 'info');
    try {
      const res = await fetch(`${API_BASE}/synchronizer/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSessionIds: allSessionIds, action, jitterMs: 50 }),
      });
      const json = await res.json();
      if (json.success) {
        showToast('全体窗口动作同步执行完毕！', 'success');
      }
    } catch (err) {
      showToast(`广播异常: ${err.message}`, 'error');
    }
  };

  if (btnNavigate) {
    btnNavigate.onclick = () => {
      let u = urlInput.value.trim();
      if (!u.startsWith('http')) u = `https://${u}`;
      broadcastAction({ type: 'navigate', url: u });
    };
  }
  if (btnReload) btnReload.onclick = () => broadcastAction({ type: 'reload' });
  if (btnScrollDown) btnScrollDown.onclick = () => broadcastAction({ type: 'scroll', deltaY: 500 });
  if (btnScrollUp) btnScrollUp.onclick = () => broadcastAction({ type: 'scroll', deltaY: -500 });
  if (btnStartCapture) btnStartCapture.onclick = async () => {
    const masterSessionId = masterSelect.value;
    const targetSessionIds = Array.from(state.activeSessions.values()).filter(id => id !== masterSessionId);
    if (!masterSessionId || !targetSessionIds.length) return showToast('实时同步至少需要 1 个主控和 1 个从窗口', 'error');
    const response = await fetch(`${API_BASE}/synchronizer/captures`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ masterSessionId, targetSessionIds, jitterMs: 40 }) });
    const result = await response.json();
    if (!result.success) return showToast(result.message || '实时同步启动失败', 'error');
    activeCaptureId = result.data.synchronizerId; btnStartCapture.disabled = true; btnStopCapture.disabled = false;
    showToast('已开始捕获主控窗口的导航、点击、输入与滚动动作', 'success');
  };
  if (btnStopCapture) btnStopCapture.onclick = async () => {
    if (!activeCaptureId) return;
    await fetch(`${API_BASE}/synchronizer/captures/${encodeURIComponent(activeCaptureId)}`, { method: 'DELETE' });
    activeCaptureId = null; btnStartCapture.disabled = false; btnStopCapture.disabled = true; showToast('实时同步已停止', 'info');
  };
}

// 15. 一键窗口九宫格平铺
function initTileWindows() {
  const btnTile = document.getElementById('btn-tile-windows');
  if (!btnTile) return;

  btnTile.onclick = async () => {
    const count = state.activeSessions.size;
    if (count === 0) {
      showToast('当前没有运行中的浏览器窗口，请先打开窗口', 'info');
      return;
    }
    showToast(`正在将 ${count} 个活动窗口以九宫格矩阵平铺排列在屏幕上...`, 'info');
    try {
      const res = await fetch(`${API_BASE}/synchronizer/tile-layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowCount: count, screenWidth: window.screen.availWidth || 1920, screenHeight: window.screen.availHeight || 1080 }),
      });
      const json = await res.json();
      if (json.success) {
        showToast(`已成功计算 ${count} 窗口的最佳九宫格分辨率与排布！`, 'success');
      }
    } catch (err) {
      showToast(`平铺失败: ${err.message}`, 'error');
    }
  };
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${escapeHtml(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==============================================================================
// 实时反向接管控制台 (Live Takeover / Web-VNC / 过盾交互)
// ==============================================================================
let activeTakeoverSession = null;
let takeoverStreamTimer = null;
let isStreamingActive = true;

function initLiveTakeoverModal() {
  const modal = document.getElementById('takeover-modal');
  const btnClose = document.getElementById('btn-close-takeover-modal');
  const btnCancel = document.getElementById('btn-cancel-takeover-modal');
  const btnRefresh = document.getElementById('btn-takeover-refresh-frame');
  const btnToggleStream = document.getElementById('btn-takeover-toggle-stream');
  const btnResume = document.getElementById('btn-takeover-resume');
  const btnSendText = document.getElementById('btn-takeover-send-text');
  const btnSendEnter = document.getElementById('btn-takeover-send-enter');
  const btnScrollDown = document.getElementById('btn-takeover-scroll-down');
  const btnScrollUp = document.getElementById('btn-takeover-scroll-up');
  const input = document.getElementById('takeover-type-input');
  const canvasWrapper = document.getElementById('takeover-canvas-wrapper');
  const screenImg = document.getElementById('takeover-screen-img');
  const coordsDisplay = document.getElementById('takeover-coords-display');

  if (!modal) return;

  const closeTakeover = () => {
    modal.classList.remove('active');
    stopTakeoverStream();
    activeTakeoverSession = null;
  };

  btnClose.onclick = closeTakeover;
  btnCancel.onclick = closeTakeover;

  btnRefresh.onclick = () => {
    if (activeTakeoverSession) fetchSingleTakeoverFrame(activeTakeoverSession);
  };

  btnToggleStream.onclick = () => {
    isStreamingActive = !isStreamingActive;
    if (isStreamingActive) {
      btnToggleStream.textContent = '📹 连续推流中';
      btnToggleStream.classList.remove('btn-secondary');
      btnToggleStream.classList.add('btn-outline');
      startTakeoverStream();
    } else {
      btnToggleStream.textContent = '⏸️ 已暂停推流';
      btnToggleStream.classList.remove('btn-outline');
      btnToggleStream.classList.add('btn-secondary');
      stopTakeoverStream();
    }
  };

  // 一键 Resume 恢复自动化
  btnResume.onclick = async () => {
    if (!activeTakeoverSession) return;
    btnResume.disabled = true;
    btnResume.textContent = '⏳ 正在检测挑战并恢复...';
    try {
      const res = await fetch(`${API_BASE}/sessions/${activeTakeoverSession}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ humanConfirmed: true }),
      });
      const json = await res.json();
      if (json.success) {
        showToast('🎉 人机验证/挑战已成功通过，会话已恢复为 READY 状态！', 'success');
        updateTakeoverStateBadge(json.data.state || 'READY');
      } else {
        showToast(`恢复提示: ${json.message || '检测到挑战仍未完成，请在画面中完成验证后再点击'}`, 'error');
      }
    } catch (err) {
      showToast(`恢复失败: ${err.message}`, 'error');
    } finally {
      btnResume.disabled = false;
      btnResume.textContent = '🛡️ 过盾完成 (Resume)';
      fetchSingleTakeoverFrame(activeTakeoverSession);
    }
  };

  // 发送文本
  const sendTextAction = async () => {
    const text = input.value;
    if (!text || !activeTakeoverSession) return;
    try {
      await fetch(`${API_BASE}/sessions/${activeTakeoverSession}/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'keyboard', action: 'type', text }),
      });
      input.value = '';
      setTimeout(() => fetchSingleTakeoverFrame(activeTakeoverSession), 150);
    } catch (err) {
      showToast(`发送按键失败: ${err.message}`, 'error');
    }
  };
  btnSendText.onclick = sendTextAction;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendTextAction();
    }
  };

  // 发送回车
  btnSendEnter.onclick = async () => {
    if (!activeTakeoverSession) return;
    await fetch(`${API_BASE}/sessions/${activeTakeoverSession}/interact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'keyboard', action: 'press', key: 'Enter' }),
    }).catch(() => {});
    setTimeout(() => fetchSingleTakeoverFrame(activeTakeoverSession), 150);
  };

  // 滚轮控制
  btnScrollDown.onclick = async () => {
    if (!activeTakeoverSession) return;
    await fetch(`${API_BASE}/sessions/${activeTakeoverSession}/interact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'scroll', deltaY: 300 }),
    }).catch(() => {});
    setTimeout(() => fetchSingleTakeoverFrame(activeTakeoverSession), 100);
  };
  btnScrollUp.onclick = async () => {
    if (!activeTakeoverSession) return;
    await fetch(`${API_BASE}/sessions/${activeTakeoverSession}/interact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'scroll', deltaY: -300 }),
    }).catch(() => {});
    setTimeout(() => fetchSingleTakeoverFrame(activeTakeoverSession), 100);
  };

  // 视口鼠标点击与移动映射
  canvasWrapper.onmousemove = (e) => {
    if (!screenImg.naturalWidth) return;
    const rect = screenImg.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      return;
    }
    const scaleX = screenImg.naturalWidth / rect.width;
    const scaleY = screenImg.naturalHeight / rect.height;
    const pageX = Math.round((e.clientX - rect.left) * scaleX);
    const pageY = Math.round((e.clientY - rect.top) * scaleY);
    coordsDisplay.textContent = `X: ${pageX}, Y: ${pageY}`;
  };

  canvasWrapper.onclick = async (e) => {
    if (!activeTakeoverSession || !screenImg.naturalWidth) return;
    const rect = screenImg.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      return;
    }
    const scaleX = screenImg.naturalWidth / rect.width;
    const scaleY = screenImg.naturalHeight / rect.height;
    const pageX = Math.round((e.clientX - rect.left) * scaleX);
    const pageY = Math.round((e.clientY - rect.top) * scaleY);

    // 显示点击波纹
    const ripple = document.getElementById('takeover-click-ripple');
    if (ripple) {
      const wrapperRect = canvasWrapper.getBoundingClientRect();
      ripple.style.left = `${e.clientX - wrapperRect.left}px`;
      ripple.style.top = `${e.clientY - wrapperRect.top}px`;
      ripple.style.transform = 'translate(-50%, -50%) scale(1.8)';
      ripple.style.opacity = '1';
      setTimeout(() => {
        ripple.style.transform = 'translate(-50%, -50%) scale(0)';
        ripple.style.opacity = '0';
      }, 300);
    }

    try {
      await fetch(`${API_BASE}/sessions/${activeTakeoverSession}/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'mouse', action: 'click', x: pageX, y: pageY, button: 'left' }),
      });
      // 延迟后获取最新画面
      setTimeout(() => {
        if (activeTakeoverSession) fetchSingleTakeoverFrame(activeTakeoverSession);
      }, 150);
    } catch (err) {
      console.error('Click forward error:', err);
    }
  };

  // 支持在画面上直接滚轮滚动
  canvasWrapper.onwheel = (e) => {
    e.preventDefault();
    if (!activeTakeoverSession) return;
    const delta = Math.max(-400, Math.min(400, e.deltaY));
    fetch(`${API_BASE}/sessions/${activeTakeoverSession}/interact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'scroll', deltaY: delta }),
    }).catch(() => {});
  };
}

function openLiveTakeoverModal(sessionId, profileId) {
  activeTakeoverSession = sessionId;
  const modal = document.getElementById('takeover-modal');
  modal.classList.add('active');
  document.getElementById('takeover-placeholder').style.display = 'block';
  document.getElementById('takeover-screen-img').style.display = 'none';
  fetchSingleTakeoverFrame(sessionId);
  if (isStreamingActive) startTakeoverStream();
}

function updateTakeoverStateBadge(stateName) {
  const badge = document.getElementById('takeover-state-badge');
  const dot = document.getElementById('takeover-status-dot');
  if (!badge || !dot) return;
  badge.textContent = stateName;
  if (stateName === 'PAUSED_CHALLENGE') {
    badge.style.background = 'rgba(239, 68, 68, 0.2)';
    badge.style.color = '#ef4444';
    dot.style.background = '#ef4444';
  } else if (stateName === 'HUMAN_TAKEOVER' || stateName === 'USER_CONTROLLED') {
    badge.style.background = 'rgba(245, 158, 11, 0.2)';
    badge.style.color = '#f59e0b';
    dot.style.background = '#f59e0b';
  } else {
    badge.style.background = 'rgba(56, 189, 248, 0.2)';
    badge.style.color = '#38bdf8';
    dot.style.background = '#34d399';
  }
}

async function fetchSingleTakeoverFrame(sessionId) {
  if (!sessionId) return;
  try {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/live-view`);
    const json = await res.json();
    if (json.success && json.data?.image) {
      const img = document.getElementById('takeover-screen-img');
      const placeholder = document.getElementById('takeover-placeholder');
      const urlText = document.getElementById('takeover-url-text');
      img.src = `data:image/png;base64,${json.data.image}`;
      img.style.display = 'block';
      placeholder.style.display = 'none';
      if (json.data.url) urlText.textContent = json.data.url;
      if (json.data.state) updateTakeoverStateBadge(json.data.state);
    }
  } catch (err) {
    console.warn('Takeover frame fetch error:', err);
  }
}

function startTakeoverStream() {
  stopTakeoverStream();
  takeoverStreamTimer = setInterval(() => {
    if (activeTakeoverSession && isStreamingActive) {
      fetchSingleTakeoverFrame(activeTakeoverSession);
    }
  }, 250);
}

function stopTakeoverStream() {
  if (takeoverStreamTimer) {
    clearInterval(takeoverStreamTimer);
    takeoverStreamTimer = null;
  }
}
