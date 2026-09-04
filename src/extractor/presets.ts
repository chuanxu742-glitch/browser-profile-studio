import type { ExtractionSchema } from './types.js';

/**
 * 淘宝商品搜索结果提取预设 (融合 opencli-Razormind 实战选择器)
 */
export const TAOBAO_SEARCH_SCHEMA: ExtractionSchema = {
  containerSelector: '[id^="item_id_"], div[class*="Card--doubleCard"], div[class*="item--"], .items .item',
  fields: [
    { name: 'itemId', selector: 'a[href*="id="]', attribute: 'href', trim: true },
    { name: 'title', selector: 'div[class*="title--"], [class*="itemTitle--"], .title a, a span', trim: true },
    { name: 'price', selector: 'div[class*="price--"], [class*="priceInt--"], .price, strong', trim: true },
    { name: 'priceFloat', selector: '[class*="priceFloat--"]', trim: true, defaultValue: '' },
    { name: 'priceDesc', selector: '[class*="priceDesc--"]', trim: true, defaultValue: '券后价' },
    { name: 'sales', selector: 'div[class*="realSales--"], div[class*="deal--"], .deal-cnt', trim: true, defaultValue: '热销中' },
    { name: 'shopName', selector: 'div[class*="shopNameText--"], div[class*="shopName--"], .shop', trim: true, defaultValue: '官方旗舰店' },
    { name: 'location', selector: '[class*="provcity--"], [class*="location--"]', trim: true, defaultValue: '全国' },
    { name: 'itemUrl', selector: 'a[href*="item.taobao.com"], a[href*="detail.tmall.com"], a', attribute: 'href', trim: true },
    { name: 'imageUrl', selector: 'img[class*="mainImg"], img', attribute: 'src', trim: true },
  ],
  maxItems: 48,
};

/**
 * 东方财富股吧讨论列表提取预设
 */
export const GUBA_POST_LIST_SCHEMA: ExtractionSchema = {
  containerSelector: 'tbody tr, .listitem, div.articleh',
  fields: [
    { name: 'reads', selector: 'td:nth-child(1), .l1', trim: true },
    { name: 'replies', selector: 'td:nth-child(2), .l2', trim: true },
    { name: 'title', selector: 'td:nth-child(3) a, .l3 a, a.note', trim: true },
    { name: 'href', selector: 'td:nth-child(3) a, .l3 a, a.note', attribute: 'href', trim: true },
    { name: 'author', selector: 'td:nth-child(4) a, .l4 a', trim: true },
    { name: 'publishTime', selector: 'td:nth-child(5), .l5', trim: true },
  ],
  maxItems: 50,
};

/**
 * 东方财富股吧帖子正文详情提取预设
 */
export const GUBA_POST_DETAIL_SCHEMA: ExtractionSchema = {
  containerSelector: '#article_body, .article-body, .main-content, .article-content, #mainbody, body',
  fields: [
    { name: 'title', selector: '#newstitle, h1, .article-title', trim: true },
    { name: 'author', selector: '.author, .article-author, .user-name', trim: true },
    { name: 'sourceInfo', selector: '.source, .source_content, .time, .publish-time', trim: true },
    { name: 'content', selector: 'p, div', trim: true },
  ],
  maxItems: 1,
};

/**
 * 京东/当当/豆瓣 图书与实体商品详情预设
 */
export const PRODUCT_DETAIL_SCHEMA: ExtractionSchema = {
  containerSelector: '.itemInfo-wrap, .product-intro, #wrapper, #content, body',
  fields: [
    { name: 'productName', selector: '.sku-name, h1, .name_info h1', trim: true },
    { name: 'price', selector: '.price, .p-price, #price-num', trim: true },
    { name: 'shopName', selector: '.name a, .seller-name, .shop-name', trim: true, defaultValue: '自营旗舰店' },
    { name: 'score', selector: '.rating_num, .score, .rate', trim: true },
    { name: 'specs', selector: '#info, .spec-items, .parameter2', trim: true },
  ],
  maxItems: 1,
};

/**
 * 买家长文真实评价与书评列表预设
 */
export const PRODUCT_REVIEWS_SCHEMA: ExtractionSchema = {
  containerSelector: '.comment-item, .review-item, .comment_item, .rate-list li',
  fields: [
    { name: 'buyerNick', selector: '.comment-info a, .user_name, .nickname, .name', trim: true },
    { name: 'rating', selector: '.rating, .star', attribute: 'title', trim: true, defaultValue: '推荐' },
    { name: 'time', selector: '.comment-time, .main-meta, .time', trim: true },
    { name: 'upvotes', selector: '.vote-count, .useful-count', trim: true, defaultValue: '0' },
    { name: 'content', selector: '.comment-content, .short, .describe_detail, .p-comment', trim: true },
  ],
  maxItems: 20,
};
