// ===== パート分け（歌割り）と推し =====
// K-POP の色分け歌詞（Color Coded Lyrics）は YouTube の巨大なジャンルなのに、公式 MV の上で
// 「今だれが歌っているか」を出す道具がほとんど無い。ここでは
//   - 歌い手のデータ：LRCHub の歌い手（行ごとの番号と色）、字幕の文字色（レーベルが色分けした字幕）、
//     見ながら数字キーで付けるタグ（1〜9 = メンバー）
//   - 表示：行の左に色の帯、名前の小さな札
//   - 推し：推しのメンバーを選ぶと、推し以外の行を薄く。「.」「,」で推しのパートへ前後に移動
//   - 集計：メンバーごとの歌唱秒数（歌割りの偏り）
// を行う。データは「曲」に紐付けるので、MV・ダンス練習・ステージのどれで付けても他の動画で使える。
// 行の識別は本文の指紋（＋同じ本文の何回目か）。本文そのものは保存しない。
// content.js / lyrics_pipeline.js の後に読み込む。

const YTI_PARTS_SHOW_KEY = 'mv_parts_show';
const YTI_PART_COLORS = ['#FF6B8B', '#4FC3F7', '#FFD54F', '#81C784', '#BA68C8', '#FF8A65', '#4DB6AC', '#F06292', '#9575CD', '#AED581', '#FFB74D', '#64B5F6'];

const ytiParts = {
  videoId: '',
  songKey: '',
  artistKey: '',
  members: [],          // [{ id, name, color }]
  lines: {},            // lineKey → [memberId]
  oshi: '',             // 推しのメンバー id
  edit: false,
  selected: '',         // 編集中に選んでいるメンバー
  source: '',
};

function ytiLineKeyList(lines) {
  const seen = new Map();
  return lines.map(l => {
    if (l.isInstrumental || !l.text) return '';
    const h = YTICore.text.hash32(YTICore.text.normalizeForMatch(l.text.split(/\r?\n/)[0]));
    const n = seen.get(h) || 0;
    seen.set(h, n + 1);
    return h + '#' + n;
  });
}

async function ytiSongAndArtistKey(videoId) {
  let songKey = externalLyricsInfo && externalLyricsInfo.songKey;
  let artistKey = '';
  let res = null;
  try {
    res = await ytiWithTimeout(ytiMusicResolver.resolve(videoId), 6000);
  } catch (e) {}
  if (!songKey) songKey = (res && res.songVideoId) ? 'song:' + res.songVideoId : 'video:' + videoId;
  if (res && res.channelIds && res.channelIds[0]) artistKey = 'ch:' + res.channelIds[0];
  else {
    const a = (externalLyricsInfo && externalLyricsInfo.artistName) || (getDisplayMetadata().artist || '');
    artistKey = a ? 'name:' + YTICore.text.normalizeArtist(a) : '';
  }
  return { songKey, artistKey };
}

async function ytiPartsLoad(videoId, token) {
  if (ytiParts.videoId !== videoId) {
    Object.assign(ytiParts, { videoId, songKey: '', artistKey: '', members: [], lines: {}, oshi: '', source: '' });
  }
  const { songKey, artistKey } = await ytiSongAndArtistKey(videoId);
  if (token !== mvContentToken) return;
  ytiParts.songKey = songKey;
  ytiParts.artistKey = artistKey;
  const savedMembers = artistKey ? await ytiStoreGet('members:' + artistKey) : null;
  const savedParts = await ytiStoreGet('parts:' + songKey);
  if (savedMembers && Array.isArray(savedMembers.members)) {
    ytiParts.members = savedMembers.members;
    ytiParts.oshi = savedMembers.oshi || '';
  }
  if (savedParts && savedParts.lines) {
    ytiParts.lines = savedParts.lines;
    ytiParts.source = savedParts.source || 'local';
  }
  // 手元に無ければ、取得元の歌い手データ・字幕の色から作る
  if (!Object.keys(ytiParts.lines).length) {
    if (!ytiPartsFromLrchub()) ytiPartsFromCaptionColors(videoId);
  }
  ytiPartsApply();
}

function ytiPartsSave() {
  if (ytiParts.artistKey) ytiStoreSet('members:' + ytiParts.artistKey, { at: Date.now(), members: ytiParts.members, oshi: ytiParts.oshi });
  if (ytiParts.songKey) ytiStoreSet('parts:' + ytiParts.songKey, { at: Date.now(), lines: ytiParts.lines, source: ytiParts.source || 'local' });
}

function ytiEnsureMember(name, color) {
  let m = ytiParts.members.find(x => (name && x.name === name) || (!name && color && x.color === color));
  if (m) return m;
  const id = 'm' + (ytiParts.members.length + 1) + '_' + YTICore.text.hash32(String(name) + String(color)).slice(0, 4);
  m = { id, name: name || ('パート' + (ytiParts.members.length + 1)), color: color || YTI_PART_COLORS[ytiParts.members.length % YTI_PART_COLORS.length] };
  ytiParts.members.push(m);
  return m;
}

// LRCHub の歌い手：行番号は plain_lyrics を改行で割った位置（空行も数える）
function ytiPartsFromLrchub() {
  const sg = externalLyricsInfo && externalLyricsInfo.singers;
  if (!sg || !Array.isArray(sg.lineSingers) || !sg.plainLyrics) return false;
  const plain = String(sg.plainLyrics).split('\n');
  const byText = new Map();
  plain.forEach((t, i) => {
    const k = YTICore.text.normalizeForMatch(t);
    if (!k) return;
    if (!byText.has(k)) byText.set(k, []);
    byText.get(k).push(sg.lineSingers[i] || 1);
  });
  const lines = (lyricsData || []);
  const keys = ytiLineKeyList(lines);
  const used = new Map();
  let n = 0;
  lines.forEach((l, i) => {
    if (!keys[i]) return;
    const k = YTICore.text.normalizeForMatch(l.text.split(/\r?\n/)[0]);
    const list = byText.get(k);
    if (!list) return;
    const at = used.get(k) || 0;
    used.set(k, at + 1);
    const num = list[Math.min(at, list.length - 1)];
    const prof = (sg.singers && sg.singers[String(num)]) || {};
    const m = ytiEnsureMember(prof.artist_name || '', prof.color || YTI_PART_COLORS[(num - 1) % YTI_PART_COLORS.length]);
    ytiParts.lines[keys[i]] = [m.id];
    n++;
  });
  if (n) ytiParts.source = 'LRCHub';
  return n > 0;
}

// レーベルが色分けした字幕（json3 の文字色）
function ytiPartsFromCaptionColors(videoId) {
  if (usingExternalLyrics) return false;
  const entries = (typeof ytiLyricsCache !== 'undefined' && ytiLyricsCache[videoId]) || null;
  if (!entries) return false;
  let colored = null;
  for (const k in entries) {
    const ent = entries[k];
    if (!ent || !ent.text || ent.tlang || String(ent.text).trim().charAt(0) !== '{') continue;
    if (currentLyricsLang && ent.lang !== currentLyricsLang) continue;
    const parsed = YTICore.parsers.parseJson3Lines(ent.text);
    if (parsed && parsed.filter(l => l.color).length >= 4) {
      colored = parsed;
      break;
    }
  }
  if (!colored) return false;
  const colors = [...new Set(colored.filter(l => l.color).map(l => l.color))];
  if (colors.length < 2) return false;
  const lines = lyricsData || [];
  const keys = ytiLineKeyList(lines);
  let n = 0;
  lines.forEach((l, i) => {
    if (!keys[i]) return;
    const c = colored.find(x => Math.abs(x.start - l.time) < 0.35 && x.color);
    if (!c) return;
    const m = ytiEnsureMember('', c.color);
    ytiParts.lines[keys[i]] = [m.id];
    n++;
  });
  if (n) ytiParts.source = '字幕の色';
  return n > 0;
}

// ── 表示 ───────────────────────────────────────────────
function ytiPartsShow() {
  return getMvOption(YTI_PARTS_SHOW_KEY, true);
}
function ytiPartsApply() {
  const lines = lyricsData || [];
  const keys = ytiLineKeyList(lines);
  const byId = new Map(ytiParts.members.map(m => [m.id, m]));
  const show = ytiPartsShow() && Object.keys(ytiParts.lines).length > 0;
  const area = document.getElementById('mv-lyrics-area');
  if (area) area.classList.toggle('yti-parts-on', show);
  if (area) area.classList.toggle('yti-oshi-on', show && !!ytiParts.oshi);
  lines.forEach((l, i) => {
    l.partKey = keys[i];
    const el = l.el;
    if (!el) return;
    const ids = (keys[i] && ytiParts.lines[keys[i]]) || [];
    const ms = ids.map(id => byId.get(id)).filter(Boolean);
    let tag = el.querySelector('.yti-part-tag');
    if (!show || !ms.length) {
      el.style.removeProperty('--part-color');
      el.classList.remove('yti-has-part', 'yti-not-oshi', 'yti-is-oshi');
      if (tag) tag.remove();
      return;
    }
    el.classList.add('yti-has-part');
    el.style.setProperty('--part-color', ms.length > 1
      ? `linear-gradient(180deg, ${ms.map(m => m.color).join(', ')})` : ms[0].color);
    const isOshi = !!ytiParts.oshi && ids.includes(ytiParts.oshi);
    el.classList.toggle('yti-is-oshi', isOshi);
    el.classList.toggle('yti-not-oshi', !!ytiParts.oshi && !isOshi);
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'yti-part-tag';
      el.appendChild(tag);
    }
    tag.textContent = ms.map(m => m.name).join(' & ');
  });
  ytiPartsRenderBar();
}

// メンバーごとの歌唱秒数（同時に歌う行は人数で割る）
function ytiPartsStats() {
  const lines = (lyricsData || []).filter(l => !l.isInstrumental);
  const sec = new Map();
  lines.forEach((l, i) => {
    const ids = (l.partKey && ytiParts.lines[l.partKey]) || [];
    if (!ids.length) return;
    const next = lines[i + 1];
    let d = l.duration || (next ? next.time - l.time : 4);
    d = Math.max(0.3, Math.min(d, 8));
    for (const id of ids) sec.set(id, (sec.get(id) || 0) + d / ids.length);
  });
  const total = [...sec.values()].reduce((a, b) => a + b, 0) || 1;
  return { sec, total };
}

function ytiPartsRenderBar() {
  if (!rootContainer) return;
  let bar = document.getElementById('yti-parts-bar');
  const has = ytiParts.members.length > 0;
  if (!ytiParts.edit && (!has || !ytiPartsShow() || !Object.keys(ytiParts.lines).length)) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'yti-parts-bar';
    ['click', 'mousedown', 'pointerdown'].forEach(t => bar.addEventListener(t, e => e.stopPropagation()));
    rootContainer.appendChild(bar);
  }
  bar.classList.toggle('editing', ytiParts.edit);
  const { sec, total } = ytiPartsStats();
  bar.innerHTML = '';
  ytiParts.members.forEach((m, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'yti-part-chip' + (ytiParts.oshi === m.id ? ' oshi' : '') + (ytiParts.selected === m.id ? ' selected' : '');
    chip.style.setProperty('--c', m.color);
    const s = sec.get(m.id) || 0;
    chip.innerHTML = '<span class="dot"></span><span class="nm"></span><span class="st"></span>';
    chip.querySelector('.nm').textContent = (ytiParts.edit && i < 9 ? (i + 1) + ' ' : '') + m.name;
    chip.querySelector('.st').textContent = s ? `${Math.round(s)}秒・${Math.round(s / total * 100)}%` : '';
    chip.title = ytiParts.edit ? 'クリックで選択（行をクリックするとこのメンバーを付け外し）・右クリックで名前と色を変更' : 'クリックで推しに設定／解除';
    chip.onclick = () => {
      if (ytiParts.edit) ytiParts.selected = ytiParts.selected === m.id ? '' : m.id;
      else {
        ytiParts.oshi = ytiParts.oshi === m.id ? '' : m.id;
        ytiPartsSave();
        showToast(ytiParts.oshi ? `推し：${m.name}（「.」「,」キーで推しのパートへ移動）` : '推しを解除しました');
      }
      ytiPartsApply();
    };
    chip.oncontextmenu = (e) => {
      e.preventDefault();
      const name = prompt('メンバーの名前', m.name);
      if (name === null) return;
      const color = prompt('色（#RRGGBB）', m.color);
      if (name.trim()) m.name = name.trim();
      if (color && /^#[0-9a-f]{6}$/i.test(color.trim())) m.color = color.trim();
      ytiPartsSave();
      ytiPartsApply();
    };
    bar.appendChild(chip);
  });
  if (ytiParts.edit) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'yti-part-chip add';
    add.textContent = '＋ メンバー';
    add.onclick = () => {
      const name = prompt('メンバーの名前');
      if (!name || !name.trim()) return;
      ytiEnsureMember(name.trim(), '');
      ytiPartsSave();
      ytiPartsApply();
    };
    bar.appendChild(add);
    const hint = document.createElement('span');
    hint.className = 'yti-part-hint';
    hint.textContent = '再生しながら数字キー（1〜9）で今の行に付けられます。0 で外す';
    bar.appendChild(hint);
  }
}

// 行に付け外し
function ytiPartsToggleLine(line, memberId) {
  if (!line || !line.partKey || !memberId) return;
  const cur = ytiParts.lines[line.partKey] || [];
  ytiParts.lines[line.partKey] = cur.includes(memberId) ? cur.filter(x => x !== memberId) : [...cur, memberId];
  if (!ytiParts.lines[line.partKey].length) delete ytiParts.lines[line.partKey];
  ytiParts.source = 'local';
  ytiPartsSave();
  ytiPartsApply();
}

function ytiPartsJump(dir) {
  if (!ytiParts.oshi || !targetVideo) return;
  const t = targetVideo.currentTime;
  const lines = (lyricsData || []).filter(l => l.partKey && (ytiParts.lines[l.partKey] || []).includes(ytiParts.oshi));
  const target = dir > 0 ? lines.find(l => l.time > t + 0.3) : [...lines].reverse().find(l => l.time < t - 1.5);
  if (target) targetVideo.currentTime = Math.max(0, target.time - 0.3);
  else showToast(dir > 0 ? 'この先に推しのパートはありません' : 'この前に推しのパートはありません');
}

// 実験的な機能：既定では画面にも動作にも出さない（lyrics_pipeline.js の ytiExtrasEnabled）
if (ytiExtrasEnabled()) {
  // ── ヘッダーのボタン（ヘッダーは作り直されるので、無くなったら付け直す） ──────────
  function ytiPartsEnsureHeaderButton() {
    const header = document.getElementById('mv-lyrics-header');
    if (!header || header.querySelector('.yti-parts-btn')) return;
    const b = document.createElement('button');
    b.className = 'mv-lyric-action-btn yti-parts-btn';
    b.textContent = 'パート';
    b.title = '歌割り（だれがどの行を歌うか）の表示・編集';
    b.onclick = (e) => {
      e.stopPropagation();
      ytiParts.edit = !ytiParts.edit;
      if (ytiParts.edit && !ytiParts.members.length) showToast('「＋ メンバー」でメンバーを足してください');
      if (ytiParts.edit && !ytiParts.selected && ytiParts.members[0]) ytiParts.selected = ytiParts.members[0].id;
      b.classList.toggle('primary', ytiParts.edit);
      ytiPartsApply();
    };
    header.appendChild(b);
  }
  setInterval(() => {
    if (rootContainer && (lyricsData || []).length) ytiPartsEnsureHeaderButton();
  }, 1000);

  // 編集中は行のクリックでメンバーを付け外す（シークより先に横取りする）
  document.addEventListener('click', (e) => {
    if (!ytiParts.edit || !rootContainer) return;
    const c = e.target && e.target.closest && e.target.closest('#mv-lyrics-area .lyric-line-container');
    if (!c || e.target.closest('button')) return;
    const line = (lyricsData || []).find(l => l.el === c);
    if (!line) return;
    e.stopPropagation();
    e.preventDefault();
    if (!ytiParts.selected) {
      showToast('先に下のメンバーを選んでください');
      return;
    }
    ytiPartsToggleLine(line, ytiParts.selected);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!rootContainer || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (ytiParts.edit && /^[0-9]$/.test(e.key)) {
      const line = (typeof activeLyricIndex === 'number' && activeLyricIndex >= 0) ? lyricsData[activeLyricIndex] : null;
      if (!line || line.isInstrumental) return;
      if (e.key === '0') {
        delete ytiParts.lines[line.partKey];
        ytiPartsSave();
        ytiPartsApply();
      } else {
        const m = ytiParts.members[Number(e.key) - 1];
        if (m) ytiPartsToggleLine(line, m.id);
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if ((e.key === '.' || e.key === ',') && ytiParts.oshi) {
      ytiPartsJump(e.key === '.' ? 1 : -1);
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // 描き直しのたびに行の要素が作り直されるので、色を付け直す
  ytiHooks.decorateLineEl.push(() => {
    clearTimeout(ytiPartsApply._t);
    ytiPartsApply._t = setTimeout(ytiPartsApply, 0);
  });
  ytiHooks.lyricsReady.push((videoId, token) => {
    ytiPartsLoad(videoId, token).catch(() => {});
  });
  ytiHooks.settings.push((panel, makeToggle) => {
    const sec = document.createElement('div');
    sec.className = 'mv-settings-title';
    sec.textContent = '推し活';
    panel.appendChild(sec);
    panel.appendChild(makeToggle('パート（歌割り）を表示', 'だれが歌っている行かを色と名前で出します。ヘッダーの「パート」で編集できます', YTI_PARTS_SHOW_KEY, true, () => ytiPartsApply()));
  });
}
