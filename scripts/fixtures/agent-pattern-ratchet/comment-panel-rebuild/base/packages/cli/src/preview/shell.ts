export function renderPreviewShell(): string {
  return `<script>
  function renderPanel() {
    if (ended) return;
    threadsEl.textContent = '';
    const ordered = annotations.slice().reverse();
    ordered.forEach((annotation, index) => {
      const thread = document.createElement('div');
      thread.className = 'thread';
      if (annotation.status === 'in_progress') thread.classList.add('working');
      if (annotation.status === 'resolved') thread.classList.add('resolved');
      if (annotation.status === 'dismissed') thread.classList.add('dismissed');
      if (orphanedThreads.has(annotation.thread) || unrestorableThreads.has(annotation.thread)) thread.classList.add('orphaned');
      const head = document.createElement('div');
      head.className = 'head';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(annotations.length - index);
      const label = document.createElement('span');
      label.className = 'anchor-label';
      label.textContent = anchorLabel(annotation.anchor);
      if (checkingThreads.has(annotation.thread)) label.textContent += ' · ' + t('preview.positionChecking');
      else if (orphanedThreads.has(annotation.thread) || unrestorableThreads.has(annotation.thread)) label.textContent += ' · ' + t('preview.positionNeedsCheck');
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = stateLabel(annotation.status);
      head.append(num, label, state);
      if (annotation.status === 'draft') {
        const del = document.createElement('button');
        del.className = 'draft-del';
        del.textContent = t('preview.delete');
        del.addEventListener('click', (event) => {
          event.stopPropagation();
          api('DELETE', '/api/annotations/' + encodeURIComponent(annotation.thread));
        });
        head.appendChild(del);
      }
      if (annotation.status === 'resolved' || annotation.status === 'dismissed') {
        const reopen = document.createElement('button');
        reopen.className = 'reopen-btn';
        reopen.textContent = t('preview.reopen');
        reopen.title = t('preview.reopenNote');
        reopen.addEventListener('click', (event) => {
          event.stopPropagation();
          api('POST', '/api/annotations/' + encodeURIComponent(annotation.thread) + '/reopen');
        });
        head.appendChild(reopen);
      }
      thread.appendChild(head);
      if (onOtherScreen(annotation)) {
        // Its own wrapping line, and a real button so keyboards can go there.
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'screen-link';
        go.textContent = t('preview.positionOtherScreen');
        go.addEventListener('click', (event) => {
          event.stopPropagation();
          restoreScreen(annotation);
        });
        thread.appendChild(go);
      }
      if (annotation.rewrite) {
        // The reader's own wording, shown before and after.
        const rewrite = document.createElement('div');
        rewrite.className = 'rewrite';
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = t('preview.rewriteHeading');
        const before = document.createElement('del');
        before.textContent = annotation.rewrite.original;
        const after = document.createElement('ins');
        after.textContent = annotation.rewrite.proposed || t('preview.rewriteRemoved');
        rewrite.append(who, before, document.createTextNode(' → '), after);
        thread.appendChild(rewrite);
      }
      (annotation.messages || []).forEach((message) => {
        const msg = document.createElement('div');
        msg.className = message.author === 'agent' ? 'msg agent' : 'msg';
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = message.author === 'agent' ? t('preview.agentName') : t('preview.you');
        msg.append(who, document.createTextNode(message.body));
        thread.appendChild(msg);
      });
      thread.addEventListener('click', () => {
        if (onOtherScreen(annotation)) {
          restoreScreen(annotation);
          return;
        }
        if (annotation.anchor && annotation.anchor.kind === 'element') {
          if (!orphanedThreads.has(annotation.thread) && !checkingThreads.has(annotation.thread)) postToFrame({ kind: 'element-ping', selector: annotation.anchor.selector });
        }
      });
      threadsEl.appendChild(thread);
    });
    panelEmpty.style.display = annotations.length === 0 ? '' : 'none';
    const drafts = annotations.filter((entry) => entry.status === 'draft');
    const hasActiveBatch = annotations.some(
      (entry) => entry.status === 'requested' || entry.status === 'in_progress');
    submitBtn.textContent = tCount('preview.requestFixes', drafts.length);
    submitBtn.disabled = hasActiveBatch;
    submitBar.classList.toggle('show', drafts.length > 0);
    const open = annotations.filter(
      (entry) => entry.status !== 'resolved' && entry.status !== 'dismissed');
    pendingCount.textContent = String(open.length);
    pendingCount.classList.toggle('show', open.length > 0);
    updateBatchStatus();
  }
</script>`
}
