const DEFAULT_ENDPOINTS = ['ws://127.0.0.1:8081', 'ws://127.0.0.1:3000'];
const MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_TARGETS = 200;

let socket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let boundTabId = null;
let activeBrowserId = null;
let activeEndpoint = null;
const attachedTabs = new Set();

function isLoopbackEndpoint(value) {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function generateRandomContextId() {
  const chars = '23456789abcdefghjkmnpqrstuvwxyz';
  let id = 'ctx_';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

async function loadConfig() {
  const value = await chrome.storage.local.get({
    endpoint: '',
    browserId: '',
    token: '',
    contextId: '',
    profileName: '',
  });

  let contextId = typeof value.contextId === 'string' && value.contextId.trim() ? value.contextId.trim() : '';
  if (!contextId) {
    contextId = generateRandomContextId();
    await chrome.storage.local.set({ contextId });
  }

  return {
    endpoint: typeof value.endpoint === 'string' ? value.endpoint.trim().replace(/\/$/, '') : '',
    browserId: typeof value.browserId === 'string' ? value.browserId.trim() : '',
    token: typeof value.token === 'string' ? value.token : '',
    contextId,
    profileName: typeof value.profileName === 'string' ? value.profileName.trim() : '',
  };
}

/** 探测本地端点是否存活（参考 OpenCLI 静默探测机制） */
async function probeEndpoint(wsEndpoint) {
  try {
    const url = new URL(wsEndpoint);
    const httpProtocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    const pingUrl = `${httpProtocol}//${url.host}/ping`;
    const res = await fetch(pingUrl, { signal: AbortSignal.timeout(1200), credentials: 'omit' });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveAvailableEndpoint(configuredEndpoint) {
  if (configuredEndpoint && isLoopbackEndpoint(configuredEndpoint)) {
    return configuredEndpoint;
  }
  for (const candidate of DEFAULT_ENDPOINTS) {
    if (await probeEndpoint(candidate)) {
      return candidate;
    }
  }
  return DEFAULT_ENDPOINTS[0];
}

function buildSocketUrl(endpoint, browserId, token) {
  const basePath = browserId ? `/ws/bridge/${encodeURIComponent(browserId)}` : '/ws/bridge';
  const url = new URL(basePath, endpoint);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

async function connect() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const config = await loadConfig();

  const chosenEndpoint = await resolveAvailableEndpoint(config.endpoint);
  if (!isLoopbackEndpoint(chosenEndpoint)) {
    updateBadge('!', '#b7791f', '需要回环地址');
    return;
  }

  activeEndpoint = chosenEndpoint;
  const urlStr = buildSocketUrl(chosenEndpoint, config.browserId, config.token);

  try {
    socket = new WebSocket(urlStr);
  } catch {
    scheduleReconnect();
    return;
  }

  const current = socket;
  current.onopen = async () => {
    if (current !== socket) return;
    reconnectAttempts = 0;
    clearReconnectTimer();
    updateBadge('ON', '#16794b', '已连接本机控制面');

    let activeTabSummary = null;
    try {
      const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTabs[0] && isPageUrl(activeTabs[0].url)) {
        activeTabSummary = tabSummary(activeTabs[0]);
      }
    } catch {
      // ignore
    }

    current.send(JSON.stringify({
      type: 'ready',
      protocol: 'antigravity-bridge.v1',
      version: chrome.runtime.getManifest().version,
      contextId: config.contextId,
      profileName: config.profileName || undefined,
      userAgent: navigator.userAgent,
      activeTab: activeTabSummary,
    }));
  };

  current.onmessage = (event) => void handleSocketMessage(current, event.data);
  current.onclose = () => {
    if (socket !== current) return;
    socket = null;
    activeBrowserId = null;
    updateBadge('OFF', '#8b2635', '控制面未连接');
    scheduleReconnect();
  };
  current.onerror = () => current.close();
}

function disconnect() {
  clearReconnectTimer();
  const current = socket;
  socket = null;
  activeBrowserId = null;
  if (current) current.close();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * (1.5 ** reconnectAttempts++), MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function updateBadge(text, color, title) {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setTitle({ title });
}

async function handleSocketMessage(current, raw) {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_COMMAND_BYTES) return;
  let command;
  try {
    command = JSON.parse(raw);
  } catch {
    return;
  }
  if (!command || typeof command !== 'object') return;

  if (command.type === 'hello' && typeof command.browserId === 'string') {
    activeBrowserId = command.browserId;
    updateBadge('ON', '#16794b', `已连接 [${activeBrowserId}]`);
    return;
  }

  if (command.type !== 'command' || typeof command.requestId !== 'string') return;
  try {
    const result = await dispatch(command);
    if (current.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify({ type: 'response', requestId: command.requestId, ok: true, result }));
    }
  } catch (error) {
    if (current.readyState === WebSocket.OPEN) {
      current.send(JSON.stringify({
        type: 'response',
        requestId: command.requestId,
        ok: false,
        error: error instanceof Error ? error.message : 'BRIDGE_COMMAND_FAILED',
      }));
    }
  }
}

async function dispatch(command) {
  switch (command.op) {
    case 'bind.current': return bindCurrentTab();
    case 'navigate': return navigate(command);
    case 'snapshot': return snapshot(command);
    case 'click': return click(command);
    case 'input': return input(command);
    case 'select': return select(command);
    case 'scroll': return scroll(command);
    case 'screenshot': return screenshot(command);
    case 'tabs.list': return listTabs();
    case 'tabs.create': return createTab(command);
    case 'tabs.switch': return switchTab(command);
    case 'tabs.close': return closeTab(command);
    default: throw new Error('BRIDGE_OPERATION_DENIED');
  }
}

async function bindCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !isPageUrl(tab.url)) throw new Error('NO_DEBUGGABLE_ACTIVE_TAB');
  boundTabId = tab.id;
  return tabSummary(tab);
}

async function resolveTab(command, createIfMissing = false) {
  const requested = Number.isSafeInteger(command.tabId) ? command.tabId : boundTabId;
  if (requested !== null) {
    try {
      const tab = await chrome.tabs.get(requested);
      if (tab.id && isPageUrl(tab.url)) return tab;
    } catch {
      if (!createIfMissing) throw new Error('TAB_NOT_FOUND');
    }
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]?.id && isPageUrl(tabs[0].url)) return tabs[0];
  if (!createIfMissing) throw new Error('NO_DEBUGGABLE_ACTIVE_TAB');
  return chrome.tabs.create({ url: 'about:blank', active: true });
}

async function navigate(command) {
  if (typeof command.url !== 'string' || !/^https?:\/\//.test(command.url) || command.url.length > 2048) {
    throw new Error('INVALID_NAVIGATION_URL');
  }
  const tab = await resolveTab(command, true);
  const updated = await chrome.tabs.update(tab.id, { url: command.url, active: command.active !== false });
  boundTabId = updated.id ?? tab.id;
  return tabSummary(updated);
}

async function snapshot(command) {
  const tab = await resolveTab(command);
  const result = await sendCdp(tab.id, 'Runtime.evaluate', {
    expression: `(() => {
      const root = globalThis;
      const map = new Map();
      root.__antigravityBridgeTargets = map;
      const selector = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"],[tabindex]';
      const targets = [];
      for (const element of document.querySelectorAll(selector)) {
        if (targets.length >= ${MAX_TARGETS}) break;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width < 1 || rect.height < 1 || style.visibility === 'hidden' || style.display === 'none') continue;
        const ref = 'ref_' + (targets.length + 1).toString(36);
        map.set(ref, element);
        targets.push({
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || undefined,
          type: element.getAttribute('type') || undefined,
          name: (element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || element.innerText || element.value || '').trim().slice(0, 160),
          disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true')
        });
      }
      return {
        url: location.href,
        title: document.title,
        text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20000),
        targets
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value ?? { url: tab.url, title: tab.title, text: '', targets: [] };
}

async function click(command) {
  const tab = await resolveTab(command);
  const ref = safeRef(command.ref);
  return evaluateTarget(tab.id, ref, `element => {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    element.click();
    return true;
  }`);
}

async function input(command) {
  const tab = await resolveTab(command);
  const ref = safeRef(command.ref);
  if (typeof command.text !== 'string' || command.text.length > 20_000) throw new Error('INVALID_INPUT_TEXT');
  return evaluateTarget(tab.id, ref, `element => {
    const text = ${JSON.stringify(command.text)};
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    if (element.isContentEditable) element.textContent = text;
    else {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(element, text); else element.value = text;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }`);
}

async function select(command) {
  const tab = await resolveTab(command);
  const ref = safeRef(command.ref);
  if (typeof command.value !== 'string' || command.value.length > 4096) throw new Error('INVALID_SELECT_VALUE');
  return evaluateTarget(tab.id, ref, `element => {
    if (!(element instanceof HTMLSelectElement)) throw new Error('TARGET_NOT_SELECT');
    element.value = ${JSON.stringify(command.value)};
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value;
  }`);
}

async function scroll(command) {
  const tab = await resolveTab(command);
  const deltaY = Math.max(-5000, Math.min(5000, Number(command.deltaY ?? 700)));
  const result = await sendCdp(tab.id, 'Runtime.evaluate', {
    expression: `(() => { scrollBy({ top: ${JSON.stringify(deltaY)}, behavior: 'smooth' }); return { x: scrollX, y: scrollY }; })()`,
    returnByValue: true,
  });
  return result.result?.value;
}

async function screenshot(command) {
  const tab = await resolveTab(command);
  const result = await sendCdp(tab.id, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
  return { mimeType: 'image/png', imageBase64: result.data };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => tab.id && isPageUrl(tab.url)).map(tabSummary);
}

async function createTab(command) {
  const url = typeof command.url === 'string' && /^https?:\/\//.test(command.url) ? command.url : 'about:blank';
  const tab = await chrome.tabs.create({ url, active: command.active !== false });
  boundTabId = tab.id ?? null;
  return tabSummary(tab);
}

async function switchTab(command) {
  if (!Number.isSafeInteger(command.tabId)) throw new Error('INVALID_TAB_ID');
  const tab = await chrome.tabs.update(command.tabId, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  boundTabId = tab.id ?? command.tabId;
  return tabSummary(tab);
}

async function closeTab(command) {
  if (!Number.isSafeInteger(command.tabId)) throw new Error('INVALID_TAB_ID');
  await detach(command.tabId);
  await chrome.tabs.remove(command.tabId);
  if (boundTabId === command.tabId) boundTabId = null;
  return { closed: true, tabId: command.tabId };
}

async function evaluateTarget(tabId, ref, body) {
  const result = await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const element = globalThis.__antigravityBridgeTargets?.get(${JSON.stringify(ref)});
      if (!element || !element.isConnected) throw new Error('STALE_TARGET_REF');
      return (${body})(element);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'PAGE_ACTION_FAILED');
  return result.result?.value;
}

async function sendCdp(tabId, method, params = {}) {
  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* tab already closed */ }
}

function safeRef(value) {
  if (typeof value !== 'string' || !/^ref_[a-z0-9]+$/.test(value)) throw new Error('INVALID_TARGET_REF');
  return value;
}

function isPageUrl(url = '') {
  return /^(https?:\/\/|about:blank)/.test(url);
}

function tabSummary(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    title: tab.title ?? '',
    url: tab.url ?? '',
    favIconUrl: tab.favIconUrl ?? '',
  };
}

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener(tabId => {
  attachedTabs.delete(tabId);
  if (boundTabId === tabId) boundTabId = null;
});
chrome.storage.onChanged.addListener(() => {
  disconnect();
  reconnectAttempts = 0;
  void connect();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'status') {
    void loadConfig().then(config => sendResponse({
      connected: socket?.readyState === WebSocket.OPEN,
      activeBrowserId,
      activeEndpoint,
      boundTabId,
      contextId: config.contextId,
      profileName: config.profileName,
      configured: true,
    }));
    return true;
  }
  if (message?.type === 'pullTabs') {
    void listTabs().then(tabs => sendResponse({ ok: true, tabs }), err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'switchTab') {
    void switchTab({ tabId: message.tabId }).then(result => sendResponse({ ok: true, result }), err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'bindCurrent') {
    void bindCurrentTab().then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'reconnect') {
    disconnect();
    reconnectAttempts = 0;
    void connect().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'bridge-keepalive') void connect();
});
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
void connect();
