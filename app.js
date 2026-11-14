// Search UI. Data arrives as window.ARCHIVE (offline build: data.js) or via window.startArchive()
// from the lock screen (encrypted build). `opts.imageUrl(post)` returns a Promise<string> URL.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s).normalize('NFC').toLowerCase();
  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

  let posts = [];
  let results = [];
  let currentId = null;
  let opts = {};

  function prepare(archive) {
    posts = archive.posts
      .map((p) => {
        const flat = [];
        for (const c of p.comments) {
          flat.push({ writer: c.writer, content: c.content });
          for (const r of c.replies) flat.push({ writer: r.writer, content: r.content });
        }
        // Deleted comments recovered from earlier revisions are searchable too.
        for (const r of p.removedComments ?? []) flat.push({ writer: r.writer, content: r.content, removedRev: r.rev });
        for (const r of p.editedComments ?? []) flat.push({ writer: r.writer, content: r.content, editedRev: r.rev });
        return {
          ...p,
          day: p.date.slice(0, 10),
          idx: {
            subject: norm(p.subject),
            body: norm([p.body, ...(p.files ?? []).map((f) => f.name)].join('\n')), // attachment names are searchable as body
            writer: norm(p.writer),
            comment: flat.map((c) => norm(c.content)),
            commenter: flat.map((c) => norm(c.writer)),
          },
          flat,
        };
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  // ---- board (게시판) filter; hidden boards are remembered per browser ----
  const HIDDEN_KEY = 'archive-hidden-boards';
  let hiddenBoards = new Set();

  function setupBoards() {
    const counts = new Map();
    for (const p of posts) counts.set(p.menu, (counts.get(p.menu) ?? 0) + 1);
    try { hiddenBoards = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]').filter((b) => counts.has(b))); } catch { /* storage unavailable */ }
    $('board-list').innerHTML = [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `<label>
      <input type="checkbox" value="${esc(name)}" ${hiddenBoards.has(name) ? '' : 'checked'}> <span>${esc(name)}</span> <span class="n">${n}</span></label>`).join('');
    updateBoardSummary(counts.size);
    $('board-list').addEventListener('change', () => readBoards(counts.size));
    $('boards-all').addEventListener('click', () => { $('board-list').querySelectorAll('input').forEach((i) => (i.checked = true)); readBoards(counts.size); });
    $('boards-none').addEventListener('click', () => { $('board-list').querySelectorAll('input').forEach((i) => (i.checked = false)); readBoards(counts.size); });
  }

  function readBoards(total) {
    hiddenBoards = new Set([...$('board-list').querySelectorAll('input:not(:checked)')].map((i) => i.value));
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenBoards])); } catch { /* storage unavailable */ }
    updateBoardSummary(total);
    search();
  }

  function updateBoardSummary(total) {
    const shown = total - hiddenBoards.size;
    const s = $('boards-summary');
    s.textContent = !hiddenBoards.size ? `전체 (${total})`
      : hiddenBoards.size <= 2 ? `${[...hiddenBoards].join(', ')} 제외`
      : `${shown}개 게시판`;
    s.classList.toggle('filtered', hiddenBoards.size > 0);
  }

  function selectedFields() {
    return [...$('fields').querySelectorAll('input:checked')].map((i) => i.value);
  }

  function matches(post, terms, fields) {
    return terms.every((t) => fields.some((f) => {
      const v = post.idx[f];
      return Array.isArray(v) ? v.some((x) => x.includes(t)) : v.includes(t);
    }));
  }

  function highlight(text, terms) {
    if (!terms.length) return esc(text);
    const lower = norm(text);
    const marks = new Array(text.length).fill(false);
    for (const t of terms) {
      let i = lower.indexOf(t);
      while (i !== -1) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = lower.indexOf(t, i + t.length); }
    }
    let out = '';
    let open = false;
    for (let i = 0; i < text.length; i++) {
      if (marks[i] && !open) { out += '<mark>'; open = true; }
      if (!marks[i] && open) { out += '</mark>'; open = false; }
      out += esc(text[i]);
    }
    return open ? out + '</mark>' : out;
  }

  function snippet(text, term, before = 24, after = 56) {
    const flatText = text.replace(/\s+/g, ' ');
    const i = norm(flatText).indexOf(term);
    if (i === -1) return null;
    const s = Math.max(0, i - before);
    const e = Math.min(flatText.length, i + term.length + after);
    return (s > 0 ? '…' : '') + flatText.slice(s, e) + (e < flatText.length ? '…' : '');
  }

  // Up to three lines saying where the terms were found (body / comment), title & writer are visible already.
  function hitLines(post, terms, fields) {
    const lines = [];
    const seen = new Set();
    for (const t of terms) {
      if (fields.includes('body')) {
        const s = snippet(post.body, t);
        if (s && !seen.has('b')) { seen.add('b'); lines.push({ where: '본문', who: '', text: s }); }
        for (const f of post.files ?? []) {
          if (lines.length < 3 && !seen.has(f.name) && norm(f.name).includes(t)) { seen.add(f.name); lines.push({ where: '첨부', who: '', text: f.name }); }
        }
      }
      post.flat.forEach((c, i) => {
        if (lines.length >= 3 || seen.has(i)) return;
        const inText = fields.includes('comment') && norm(c.content).includes(t);
        const byWriter = fields.includes('commenter') && norm(c.writer).includes(t);
        if (inText || byWriter) {
          seen.add(i);
          lines.push({
            where: c.removedRev ? `삭제된 댓글(rev ${c.removedRev})` : c.editedRev ? `수정 전 댓글(rev ${c.editedRev})` : '댓글',
            isComment: true, removed: !!c.removedRev, edited: !!c.editedRev,
            who: c.writer, text: snippet(c.content, t) || c.content.slice(0, 80) });
        }
      });
    }
    return lines.slice(0, 3);
  }

  function search() {
    const terms = norm($('q').value).split(/\s+/).filter(Boolean);
    const fields = selectedFields();
    const from = $('from').value;
    const to = $('to').value;
    const state = $('state').value; // all | deleted | revised
    results = posts.filter((p) => !hiddenBoards.has(p.menu) && (!from || p.day >= from) && (!to || p.day <= to)
      && (state === 'all' || (state === 'deleted' && p.deleted) || (state === 'revised' && p.rev > 1)
        || (state === 'removed' && (p.deleted || p.removedComments?.length > 0)))
      && (!terms.length || matches(p, terms, fields)));
    render(terms, fields);
  }

  function render(terms, fields) {
    const list = $('results');
    $('count').textContent = terms.length ? `${results.length}개 글에서 찾았습니다` : `${results.length}개 글`;
    if (!results.length) {
      list.innerHTML = `<li class="empty">${terms.length
        ? `‘${esc($('q').value.trim())}’이(가) 들어간 글이 없습니다. 찾을 곳이나 게시판을 더 켜거나 기간을 넓혀 보세요.`
        : '이 기간·게시판에 보관된 글이 없습니다. 기간이나 게시판을 넓혀 보세요.'}</li>`;
      return;
    }
    list.innerHTML = results.map((p) => {
      const hits = terms.length ? hitLines(p, terms, fields) : [];
      const [y, m, d] = p.day.split('-');
      return `<li><button class="entry" type="button" data-id="${p.id}" aria-current="${p.id === currentId}">
        <span class="day">${m}.${d}<small>${y}</small></span>
        <span>
          <p class="title">${tags(p)}${highlight(p.subject, fields.includes('subject') ? terms : [])}</p>
          <p class="meta"><span>${esc(p.menu)}</span><span>${highlight(p.writer, fields.includes('writer') ? terms : [])}</span><span>댓글 ${p.commentCount}</span>${p.removedComments?.length ? `<span class="tag del">삭제된 댓글 ${p.removedComments.length}</span>` : ''}${p.editedComments?.length ? `<span class="tag rev">수정된 댓글 ${new Set(p.editedComments.map((r) => r.id)).size}</span>` : ''}${p.files?.length ? `<span>첨부 ${p.files.length}</span>` : ''}</p>
          ${hits.length ? `<ul class="hits">${hits.map((h) => `<li><span class="where${h.removed ? ' removed' : h.edited ? ' edited' : ''}">${h.where}${h.who ? ` ${highlight(h.who, fields.includes('commenter') ? terms : [])}` : ''}</span>${highlight(h.text, fields.includes('comment') || !h.isComment ? terms : [])}</li>`).join('')}</ul>` : ''}
        </span>
      </button></li>`;
    }).join('');
  }

  // [삭제] in red, [수정] rev N in blue.
  function tags(p) {
    return `${p.deleted ? '<span class="tag del">[삭제]</span> ' : ''}${p.rev > 1 ? `<span class="tag rev">[수정] rev ${p.rev}</span> ` : ''}`;
  }

  // Status line + version switcher under the title (only for deleted / revised posts).
  function renderStatus(post) {
    const lines = [];
    if (post.deleted) {
      lines.push(`<span class="tag del">[삭제]</span> ${esc(post.deleted.detectedAt)} 캡처 때 삭제 확인 (그 전 확인 ${esc(post.deleted.lastSeenAt)})`);
    }
    const hist = post.history ?? [];
    if (post.rev > 1) {
      const last = hist.at(-1);
      lines.push(`<span class="tag rev">[수정] rev ${post.rev}</span> ${esc(last?.replacedAt ?? '')} 캡처 때 변경 확인${last?.change ? ` (${esc(last.change)})` : ''}`);
    }
    const removed = post.removedComments ?? [];
    if (removed.length) {
      const revs = [...new Set(removed.map((r) => r.rev))].sort((a, b) => a - b).map((r) => `rev ${r}`).join(', ');
      lines.push(`<span class="tag del">삭제된 댓글 ${removed.length}개</span> ${revs} 캡처에 남아 있음 (위 '버전'에서 보기)`);
    }
    const edited = post.editedComments ?? [];
    if (edited.length) {
      const revs = [...new Set(edited.map((r) => r.rev))].sort((a, b) => a - b).map((r) => `rev ${r}`).join(', ');
      lines.push(`<span class="tag rev">수정된 댓글 ${new Set(edited.map((r) => r.id)).size}개</span> 수정 전 내용은 ${revs} 캡처에 남아 있음`);
    }
    $('r-status').hidden = !lines.length;
    $('r-status').innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
    const versions = $('r-versions');
    versions.hidden = !hist.length;
    versions.innerHTML = hist.length ? `<li class="label">버전</li>
      <li><button class="tool" type="button" data-rev="" aria-pressed="true">rev ${post.rev} (현재, ${esc(post.capturedAt)} 캡처)</button></li>
      ${[...hist].reverse().map((h) => `<li><button class="tool" type="button" data-rev="${h.rev}" aria-pressed="false"
        title="${esc(h.replacedAt)} 변경 확인${h.change ? `: ${esc(h.change)}` : ''}">rev ${h.rev} (${esc(h.capturedAt)} 캡처)</button></li>`).join('')}` : '';
  }

  // Shows the current capture (rev = null) or a previous revision of the post.
  async function showVersion(post, rev) {
    const h = rev == null ? null : (post.history ?? []).find((x) => x.rev === rev);
    const sheet = $('sheet');
    sheet.innerHTML = '<p class="status">캡처 화면을 불러오는 중…</p>';
    sheet.scrollTop = 0;
    try {
      const url = h ? h.src : await opts.imageUrl(post);
      if (currentId !== post.id) return;
      const img = new Image();
      img.alt = `${post.subject} 캡처 화면 (본문과 댓글)${h ? ` rev ${h.rev}` : ''}`;
      if (!h) { img.width = post.imageSize.width; img.height = post.imageSize.height; }
      img.src = url;
      sheet.replaceChildren(img);
      sheet.scrollTop = 0; // every newly opened post starts at its top
      const name = post.downloadName || post.image;
      $('download').href = url;
      $('download').download = h ? name.replace(/(\.[a-z]+)$/i, `_rev${h.rev}$1`) : name;
      $('r-versions').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.rev || null) === (h ? String(h.rev) : null))));
    } catch (e) {
      sheet.innerHTML = `<p class="status">캡처 화면을 열지 못했습니다. (${esc(e.message)})</p>`;
    }
  }

  async function open(id, { push = true } = {}) {
    const post = posts.find((p) => p.id === id);
    if (!post) return;
    currentId = id;
    document.querySelectorAll('.entry').forEach((e) => e.setAttribute('aria-current', String(Number(e.dataset.id) === id)));
    $('reader-bar').hidden = false;
    $('r-title').innerHTML = `${tags(post)}${esc(post.subject)}`;
    renderStatus(post);
    $('r-meta').innerHTML = `<span>${esc(post.menu)}</span><span>${esc(post.writer)}</span><span>${esc(post.date)}</span><span>댓글 ${post.commentCount}</span>`;
    $('original').href = post.url;
    const files = post.files ?? [];
    $('r-files').hidden = !files.length;
    $('r-files').innerHTML = files.length
      ? `<li class="label">첨부파일</li>${files.map((f) => `<li><a class="file" href="${esc(f.src)}" download="${esc(f.name)}">${esc(f.name)} <small>${fmtSize(f.size)}</small></a></li>`).join('')}`
      : '';
    const pos = results.findIndex((p) => p.id === id);
    $('prev').disabled = pos <= 0;
    $('next').disabled = pos === -1 || pos >= results.length - 1;

    if (push && window.matchMedia('(max-width: 899px)').matches && !document.body.classList.contains('reading')) {
      try { history.pushState({ reading: id }, ''); } catch { /* sandboxed preview: back button just closes */ }
    }
    // Show the reader first: a hidden (display:none) element ignores scrollTop, so the old position would stick.
    document.body.classList.add('reading');
    await showVersion(post, null);
  }

  function step(delta) {
    const pos = results.findIndex((p) => p.id === currentId);
    const next = results[pos + delta];
    if (next) {
      open(next.id, { push: false });
      document.querySelector(`.entry[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  function closeReader() {
    document.body.classList.remove('reading');
  }

  function fmt(day) {
    const [y, m, d] = day.split('-').map(Number);
    return `${y}년 ${m}월 ${d}일`;
  }

  function start(archive, options) {
    opts = options;
    prepare(archive);
    const days = posts.map((p) => p.day).sort();
    const first = days[0];
    const last = days[days.length - 1];
    $('scope').textContent = `글 ${posts.length}개, ${fmt(first)} ~ ${fmt(last)}`;
    for (const id of ['from', 'to']) { $(id).min = first; $(id).max = last; }

    let timer;
    $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 120); });
    $('search').addEventListener('submit', (e) => { e.preventDefault(); search(); });
    $('fields').addEventListener('change', search);
    $('from').addEventListener('change', search);
    $('to').addEventListener('change', search);
    $('all-dates').addEventListener('click', () => { $('from').value = ''; $('to').value = ''; search(); });
    $('results').addEventListener('click', (e) => {
      const btn = e.target.closest('.entry');
      if (btn) open(Number(btn.dataset.id));
    });
    $('state').addEventListener('change', search);
    $('r-versions').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-rev]');
      const post = posts.find((p) => p.id === currentId);
      if (b && post) showVersion(post, b.dataset.rev ? Number(b.dataset.rev) : null);
    });
    $('prev').addEventListener('click', () => step(-1));
    $('next').addEventListener('click', () => step(1));
    $('back').addEventListener('click', () => (history.state?.reading ? history.back() : closeReader()));
    window.addEventListener('popstate', closeReader);
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input') || !currentId) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });

    setupBoards();
    $('app').hidden = false;
    search();
    if (window.matchMedia('(min-width: 900px)').matches) $('q').focus(); // no keyboard pop-up on phones
  }

  window.startArchive = start;
  if (window.ARCHIVE) {
    start(window.ARCHIVE, { imageUrl: async (p) => p.src });
  }
})();
