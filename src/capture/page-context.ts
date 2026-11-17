/** Read only public player identifiers; never copy a page's account or request state. */
export const capturePageContextScript = `(() => {
  const positive = v => Number.isSafeInteger(v) && v > 0;
  const pick = value => {
    if (!value || typeof value !== 'object') return;
    const info = value.episode_info || value.epInfo || value.ep_info;
    const episodeId = info?.ep_id || info?.id;
    const cid = info?.cid;
    if (positive(episodeId) || positive(cid)) return {
      ...(positive(episodeId) ? {episodeId} : {}),
      ...(positive(cid) ? {cid} : {})
    };
  };
  const initial = pick(globalThis.__INITIAL_STATE__);
  if (initial) return initial;
  const text = document.getElementById('__NEXT_DATA__')?.textContent;
  if (!text || text.length > 8 * 1024 * 1024) return {};
  try {
    const props = JSON.parse(text)?.props?.pageProps;
    const direct = pick(props);
    if (direct) return direct;
    for (const query of (props?.dehydratedState?.queries || []).slice(0, 50)) {
      const info = pick(query?.state?.data);
      if (info) return info;
    }
  } catch {}
  return {};
})()`;
