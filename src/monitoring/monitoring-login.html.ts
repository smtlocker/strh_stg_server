function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMonitoringLoginHtml(params?: {
  error?: string;
  next?: string;
}): string {
  const error = params?.error ? escapeHtml(params.error) : '';
  const next = escapeHtml(params?.next ?? '/monitoring');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SmartCube 로그인</title>
<style>
  :root {
    --bg: #0a0a0f;
    --panel: #12121a;
    --panel2: #1a1a26;
    --border: #2a2a3a;
    --text: #e4e4ef;
    --muted: #9a9ab0;
    --blue: #6c8cff;
    --red: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(circle at top, #141424 0%, var(--bg) 55%);
    color: var(--text);
    font-family: Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 380px;
    background: rgba(18,18,26,0.95);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 28px 24px;
    box-shadow: 0 24px 80px rgba(0,0,0,0.45);
  }
  h1 {
    margin: 0;
    font-size: 22px;
  }
  .error {
    margin: 18px 0 0;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid rgba(248,113,113,0.24);
    background: rgba(248,113,113,0.08);
    color: var(--red);
    font-size: 12px;
    line-height: 1.6;
  }
  form {
    margin-top: 22px;
    display: grid;
    gap: 14px;
  }
  label {
    display: grid;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  input {
    width: 100%;
    height: 44px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--panel2);
    color: var(--text);
    padding: 0 14px;
    font-size: 14px;
    outline: none;
  }
  input:focus {
    border-color: rgba(108,140,255,0.5);
    box-shadow: 0 0 0 3px rgba(108,140,255,0.12);
  }
  button {
    margin-top: 6px;
    height: 44px;
    border: none;
    border-radius: 12px;
    background: linear-gradient(135deg, #6c8cff 0%, #818cf8 100%);
    color: white;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>SmartCube 로그인</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="post" action="/login" autocomplete="off">
      <input type="hidden" name="next" value="${next}">
      <label>
        관리자 ID
        <input name="mgrId" type="text" required>
      </label>
      <label>
        비밀번호
        <input name="mgrPwd" type="password" required>
      </label>
      <button type="submit">로그인</button>
    </form>
  </div>
</body>
</html>`;
}
