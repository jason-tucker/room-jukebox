/** Local pages that must work without the hub server: shown as `data:` URLs. */

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; font: 16px/1.5 system-ui, 'Segoe UI', sans-serif; background: #111; color: #eee; }
  main { max-width: 760px; margin: 12vh auto; padding: 0 24px; }
  h1 { font-size: 28px; margin: 0 0 16px; }
  code { background: #222; padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  form { margin: 0; padding: 20px; }
  label { display: block; margin-bottom: 8px; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; border-radius: 6px;
          border: 1px solid #555; background: #1c1c1c; color: inherit; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  button { font: inherit; padding: 6px 16px; border-radius: 6px; border: 1px solid #555;
           background: #2a2a2a; color: inherit; cursor: pointer; }
  button[type=submit] { background: #3d6be0; border-color: #3d6be0; }
  #err { color: #ff8a80; min-height: 1.5em; margin-top: 8px; }
`;

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Full-screen error: a title and plain lines (escaped). */
export function errorPageUrl(title: string, lines: readonly string[]): string {
  const body = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('\n');
  return dataUrl(`<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Room Jukebox</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>
${body}</main></body></html>`);
}

/** Owner password prompt; talks to main only through `window.ownerPrompt` (prompt preload). */
export function passwordPageUrl(reason: string): string {
  const script = `
    const form = document.getElementById('f');
    const input = document.getElementById('pw');
    const err = document.getElementById('err');
    const ok = document.getElementById('ok');
    document.getElementById('cancel').addEventListener('click', () => window.ownerPrompt.cancel());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.ownerPrompt.cancel(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      ok.disabled = true; err.textContent = '';
      const res = await window.ownerPrompt.submit(input.value);
      ok.disabled = false;
      if (!res.ok) { err.textContent = res.message; input.select(); }
    });
    input.focus();`;
  return dataUrl(`<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Owner password</title><style>${STYLE}</style></head>
<body><form id="f" autocomplete="off">
<label for="pw">${escapeHtml(reason)}: enter the owner password</label>
<input id="pw" type="password" required autofocus>
<div id="err" role="alert"></div>
<div class="row"><button type="button" id="cancel">Cancel</button><button type="submit" id="ok">OK</button></div>
</form><script>${script}</script></body></html>`);
}
