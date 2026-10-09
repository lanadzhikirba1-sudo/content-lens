// Normalises Apify dataset items into the shape the frontend uses.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function normalizeProfile(it) {
  return {
    username: it.username,
    fullName: it.fullName || '',
    biography: it.biography || '',
    externalUrl: it.externalUrl || null,
    // Актор отдаёт массив {title, url}; интерфейс пока использует одну ссылку,
    // но аудиту нужны все — критерий 4.4 «перегруз ссылками».
    externalUrls: (Array.isArray(it.externalUrls) ? it.externalUrls : [])
      .map((l) => (typeof l === 'string' ? l : l && l.url))
      .filter(Boolean),
    // Только количество папок: названий этот актор не отдаёт (проверено 04.10.2026).
    highlightReelCount: num(it.highlightReelCount),
    followers: num(it.followersCount),
    following: num(it.followsCount),
    postsCount: num(it.postsCount),
    avatar: it.profilePicUrlHD || it.profilePicUrl || null,
    verified: !!it.verified,
    isPrivate: !!it.private,
    isBusiness: !!it.isBusinessAccount,
    category: it.businessCategoryName || null,
  };
}

function formatOf(it) {
  if (it.productType === 'clips') return 'Reels';
  if (it.type === 'Sidecar') return 'Карусель';
  if (it.type === 'Video') return 'Видео';
  return 'Фото';
}

function mediaOf(it) {
  if (it.type === 'Sidecar') {
    const children = (it.childPosts || []).filter((c) => c.displayUrl || c.videoUrl);
    if (children.length) {
      return children.map((c) => (c.type === 'Video' && c.videoUrl
        ? { type: 'video', url: c.videoUrl, poster: c.displayUrl || null }
        : { type: 'image', url: c.displayUrl }));
    }
    if (Array.isArray(it.images) && it.images.length) return it.images.map((u) => ({ type: 'image', url: u }));
  }
  if (it.type === 'Video' && it.videoUrl) return [{ type: 'video', url: it.videoUrl, poster: it.displayUrl || null }];
  return it.displayUrl ? [{ type: 'image', url: it.displayUrl }] : [];
}

export function normalizePost(it) {
  const isVideo = it.type === 'Video';
  return {
    id: String(it.id || it.shortCode),
    shortCode: it.shortCode || null,
    url: it.url || (it.shortCode ? `https://www.instagram.com/p/${it.shortCode}/` : null),
    timestamp: it.timestamp,
    caption: it.caption || '',
    hashtags: it.hashtags || [],
    format: formatOf(it),
    likes: num(it.likesCount),
    comments: num(it.commentsCount),
    views: isVideo ? (num(it.videoPlayCount) ?? num(it.videoViewCount)) : null,
    duration: num(it.videoDuration),
    isPinned: !!it.isPinned,
    thumb: it.displayUrl || null,
    media: mediaOf(it),
    latestComments: (it.latestComments || []).slice(0, 15).map((c) => ({
      user: c.ownerUsername, text: c.text, ts: c.timestamp,
    })),
  };
}

// Apify returns error items instead of failing the run, e.g. {error: 'not_found', errorDescription: '...'}.
export function errorItem(items) {
  return (items || []).find((i) => i && i.error);
}
