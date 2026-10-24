// UI strings — English + Simplified Chinese.
(function (global) {
  'use strict';
  const DICT = {
    en: {
      tabAll: 'Live',
      tabMovies: 'Movies',
      tabSeries: 'Series',
      tabAnime: 'Anime',
      tabVod: 'VOD',
      tabFavorites: 'Favourites',
      tabRecent: 'Recent',
      tabPlaylists: 'Playlists',
      filters: 'Filters',
      reset: 'Reset',
      country: 'Country',
      allCountries: 'All countries',
      sort: 'Sort by',
      sortName: 'Name (A–Z)',
      sortQuality: 'Best quality',
      sortStreams: 'Most sources',
      minQuality: 'Minimum quality',
      anyQuality: 'Any',
      categories: 'Categories',
      onlyLogo: 'Only channels with a logo',
      hideAdult: 'Hide adult channels',
      adultNote: 'Every channel the iptv-org API still carries a stream for is listed, including adult ones.',
      myPlaylists: 'My playlists',
      playlistHint: 'Load any M3U playlist URL (or a local file) and watch it here.',
      addUrl: 'Add URL',
      openFile: 'Open file…',
      playback: 'Playback',
      useProxy: 'Relay through this server (fixes CORS & blocked streams)',
      loadMore: 'Load more',
      retry: 'Retry',
      nextSource: 'Try next source',
      source: 'Source',
      quality: 'Quality',
      relay: 'Relay',
      footerSource: 'Channel data from the open',
      footerNote: '· streams are hosted by third parties; this site only links to them.',
      channels: 'channels',
      noResults: 'Nothing matches those filters.',
      loading: 'Loading channels…',
      connecting: 'Connecting…',
      playing: 'Playing',
      favAdded: 'Added to favourites',
      favRemoved: 'Removed from favourites',
      copied: 'Stream URL copied',
      importFailed: 'Import failed',
      imported: 'Imported',
      remove: 'Remove',
      added: 'Playlist added',
      proxyOn: 'Streams are fetched by this server — works for blocked geo-restricted sources, costs server bandwidth.',
      proxyOff: 'Direct playback from your browser. Only works for HTTPS streams that send CORS headers.',
      errGeneric: 'Stream failed to load.',
      errNext: 'Trying the next source…',
      noSources: 'No stream URL is available for this channel.',
      adult: 'Adult',
      geo: 'Geo-blocked',
      not24: 'Not 24/7',
      sourceOf: 'source of',
      updated: 'Data updated',
    },
    zh: {
      tabAll: '直播',
      tabMovies: '电影',
      tabSeries: '剧集',
      tabAnime: '动漫',
      tabVod: '点播',
      tabFavorites: '收藏',
      tabRecent: '最近',
      tabPlaylists: '播放列表',
      filters: '筛选',
      reset: '重置',
      country: '国家/地区',
      allCountries: '全部国家/地区',
      sort: '排序',
      sortName: '名称 (A–Z)',
      sortQuality: '清晰度优先',
      sortStreams: '源数量优先',
      minQuality: '最低清晰度',
      anyQuality: '不限',
      categories: '分类',
      onlyLogo: '仅显示有台标的频道',
      hideAdult: '隐藏成人频道',
      adultNote: '列表包含 iptv-org 接口中所有仍带可用流的频道（含成人频道）。',
      myPlaylists: '我的播放列表',
      playlistHint: '粘贴任意 M3U 播放列表链接（或选择本地文件），即可在此观看。',
      addUrl: '添加链接',
      openFile: '打开文件…',
      playback: '播放',
      useProxy: '通过本站服务器中转（可解决跨域与被墙的源）',
      loadMore: '加载更多',
      retry: '重试',
      nextSource: '尝试下一个源',
      source: '线路',
      quality: '清晰度',
      relay: '中转',
      footerSource: '频道数据来自开源项目',
      footerNote: '· 视频流由第三方托管，本站仅提供索引与播放。',
      channels: '个频道',
      noResults: '没有符合条件的频道。',
      loading: '正在加载频道…',
      connecting: '正在连接…',
      playing: '播放中',
      favAdded: '已加入收藏',
      favRemoved: '已取消收藏',
      copied: '已复制流地址',
      importFailed: '导入失败',
      imported: '已导入',
      remove: '删除',
      added: '播放列表已添加',
      proxyOn: '由本站服务器拉流，可播放被地理位置限制的源，会消耗服务器流量。',
      proxyOff: '浏览器直连播放，仅支持带跨域头的 HTTPS 源。',
      errGeneric: '流加载失败。',
      errNext: '正在尝试下一个源…',
      noSources: '该频道暂无可用流地址。',
      adult: '成人',
      geo: '地域限制',
      not24: '非全天候',
      sourceOf: '个源，第',
      updated: '数据更新于',
    },
  };

  let lang = 'en';
  try {
    const saved = localStorage.getItem('iptvweb.lang');
    if (saved === 'zh' || saved === 'en') lang = saved;
    else if (/^zh/i.test(navigator.language || '')) lang = 'zh';
  } catch {}

  function t(key) {
    return (DICT[lang] && DICT[lang][key]) || DICT.en[key] || key;
  }

  function apply(root) {
    (root || document).querySelectorAll('[data-i18n]').forEach((el) => {
      const v = t(el.getAttribute('data-i18n'));
      if (v) el.textContent = v;
    });
  }

  global.I18N = {
    t,
    apply,
    get lang() {
      return lang;
    },
    toggle() {
      lang = lang === 'en' ? 'zh' : 'en';
      try {
        localStorage.setItem('iptvweb.lang', lang);
      } catch {}
      apply();
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
      return lang;
    },
  };
})(window);
