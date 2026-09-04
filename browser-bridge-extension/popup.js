const endpointInput = document.querySelector('#endpoint');
const browserIdInput = document.querySelector('#browserId');
const tokenInput = document.querySelector('#token');
const profileNameInput = document.querySelector('#profileName');
const connBadge = document.querySelector('#conn-badge');
const connText = document.querySelector('#conn-text');
const browserIdText = document.querySelector('#browser-id-text');
const endpointText = document.querySelector('#endpoint-text');
const boundTabText = document.querySelector('#bound-tab-text');
const tabsContainer = document.querySelector('#tabs-container');
const tabsList = document.querySelector('#tabs-list');
const btnPullTabs = document.querySelector('#btn-pull-tabs');

async function refresh() {
  const config = await chrome.storage.local.get({
    endpoint: '',
    browserId: '',
    token: '',
    profileName: '',
  });

  endpointInput.value = config.endpoint || '';
  browserIdInput.value = config.browserId || '';
  tokenInput.value = config.token || '';
  profileNameInput.value = config.profileName || '';

  const state = await chrome.runtime.sendMessage({ type: 'status' });
  if (state.connected) {
    connBadge.className = 'badge-status badge-on';
    connBadge.textContent = '已连接';
    connText.textContent = '已连接到本机服务 (READY)';
    browserIdText.textContent = state.activeBrowserId || '(自动分配中)';
    endpointText.textContent = state.activeEndpoint || '自动发现';
    boundTabText.textContent = state.boundTabId ? `Tab #${state.boundTabId}` : '未绑定特定标签';
  } else {
    connBadge.className = 'badge-status badge-off';
    connBadge.textContent = '未连接';
    connText.textContent = '自动探测控制面中 (8081 / 3000)';
    browserIdText.textContent = '-';
    endpointText.textContent = '-';
    boundTabText.textContent = '未绑定';
  }
}

document.querySelector('#save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    endpoint: endpointInput.value.trim().replace(/\/$/, ''),
    browserId: browserIdInput.value.trim(),
    token: tokenInput.value,
    profileName: profileNameInput.value.trim(),
  });
  connText.textContent = '正在重新连接…';
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  await refresh();
});

document.querySelector('#bind').addEventListener('click', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'bindCurrent' });
  if (result.ok) {
    boundTabText.textContent = `${result.result.title || result.result.url} (#${result.result.tabId})`;
  } else {
    alert(`绑定失败: ${result.error}`);
  }
});

btnPullTabs.addEventListener('click', async () => {
  tabsContainer.style.display = 'block';
  tabsList.innerHTML = '<div style="padding:8px;color:#718096">正在拉取所有打开的标签页…</div>';

  const res = await chrome.runtime.sendMessage({ type: 'pullTabs' });
  if (!res.ok) {
    tabsList.innerHTML = `<div style="padding:8px;color:#e53e3e">拉取失败: ${res.error}</div>`;
    return;
  }

  const tabs = res.tabs || [];
  if (tabs.length === 0) {
    tabsList.innerHTML = '<div style="padding:8px;color:#718096">未发现可用标签页</div>';
    return;
  }

  tabsList.innerHTML = '';
  for (const tab of tabs) {
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.title = `${tab.title}\n${tab.url}`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = tab.title || tab.url;

    const badgeSpan = document.createElement('span');
    badgeSpan.className = `tab-badge ${tab.active ? 'active' : ''}`;
    badgeSpan.textContent = tab.active ? '当前活动' : `#${tab.tabId}`;

    item.appendChild(titleSpan);
    item.appendChild(badgeSpan);

    item.addEventListener('click', async () => {
      const switchRes = await chrome.runtime.sendMessage({ type: 'switchTab', tabId: tab.tabId });
      if (switchRes.ok) {
        boundTabText.textContent = `${tab.title || tab.url} (#${tab.tabId})`;
        await refresh();
      }
    });

    tabsList.appendChild(item);
  }
});

void refresh();
setInterval(refresh, 3000);
