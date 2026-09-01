export interface PlatformAdapterDescriptor {
  id: string;
  label: string;
  hosts: string[];
  status: 'generic-browser' | 'adapter-ready';
  notes: string;
}

export interface ActionPackDescriptor {
  id: string;
  label: string;
  category: string;
  requiresApiKey: boolean;
  status: 'catalog-only' | 'available';
}

/**
 * These descriptors are intentionally data-only. They advertise routing
 * coverage without pretending that a site selector is stable or bypassing
 * account, region, or anti-abuse controls.
 */
export const PLATFORM_ADAPTERS: PlatformAdapterDescriptor[] = [
  { id: 'xiaohongshu', label: '小红书', hosts: ['xiaohongshu.com', 'xhslink.com'], status: 'generic-browser', notes: '通过 Bridge/CDP 使用当前登录页面；站点选择器需按页面变化维护。' },
  { id: 'bilibili', label: 'Bilibili', hosts: ['bilibili.com'], status: 'generic-browser', notes: '支持浏览器会话接管，具体动作由调用方提供。' },
  { id: 'zhihu', label: '知乎', hosts: ['zhihu.com'], status: 'generic-browser', notes: '支持浏览器会话接管，具体动作由调用方提供。' },
  { id: 'weibo', label: '微博', hosts: ['weibo.com'], status: 'generic-browser', notes: '支持浏览器会话接管，具体动作由调用方提供。' },
  { id: 'x', label: 'X', hosts: ['x.com', 'twitter.com'], status: 'generic-browser', notes: '支持浏览器会话接管，具体动作由调用方提供。' },
  { id: 'reddit', label: 'Reddit', hosts: ['reddit.com'], status: 'generic-browser', notes: '支持浏览器会话接管，具体动作由调用方提供。' },
  { id: 'youtube', label: 'YouTube', hosts: ['youtube.com'], status: 'generic-browser', notes: '支持浏览器会话接管，具体动作由调用方提供。' },
  { id: 'linkedin', label: 'LinkedIn', hosts: ['linkedin.com'], status: 'generic-browser', notes: '支持浏览器会话接管，具体动作由调用方提供。' },
  { id: 'hacker-news', label: 'Hacker News', hosts: ['news.ycombinator.com'], status: 'generic-browser', notes: '支持浏览器会话接管，具体动作由调用方提供。' },
];

export const ACTION_PACKS: ActionPackDescriptor[] = [
  { id: 'ecommerce-collect', label: '电商采集', category: 'ecommerce', requiresApiKey: false, status: 'catalog-only' },
  { id: 'social-listening', label: '社媒监听', category: 'social', requiresApiKey: false, status: 'catalog-only' },
  { id: 'video-platforms', label: '视频平台', category: 'video', requiresApiKey: false, status: 'catalog-only' },
  { id: 'search-research', label: '搜索研究', category: 'research', requiresApiKey: true, status: 'catalog-only' },
  { id: 'lead-generation', label: '线索生成', category: 'growth', requiresApiKey: true, status: 'catalog-only' },
];

