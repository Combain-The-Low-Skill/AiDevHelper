"use strict";

// Клиентская логика. Токен берём из meta (его подставил сервер при отдаче страницы)
// и шлём в заголовке x-adhp-token на каждый запрос.
const TOKEN = document.querySelector('meta[name="adhp-token"]').content;
const $ = (id) => document.getElementById(id);

let pendingChanges = null; // предложенные агентом изменения (manual-режим)

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "x-adhp-token": TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let msg = `Ошибка ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ---- лог ----
function logClear() { $("log").innerHTML = ""; }
function logLine(text, cls = "") {
  const d = document.createElement("div");
  d.className = "line " + cls;
  d.textContent = text;
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
}

function describeEvent(ev) {
  if (ev.type === "tool") {
    const map = { list_dir: "смотрю папку", read_file: "читаю", search: "ищу", edit_file: "правлю", create_file: "создаю", finish: "завершаю" };
    return `→ ${map[ev.name] || ev.name}: ${ev.args || ""}`;
  }
  if (ev.type === "tool_error") return `  ошибка инструмента ${ev.name}: ${ev.error}`;
  if (ev.type === "assistant") return ev.text;
  return JSON.stringify(ev);
}

// ---- выбор папки ----
$("pickBtn").onclick = async () => {
  $("pickBtn").disabled = true;
  $("pickBtn").textContent = "Открываю…";
  logLine("Открываю окно Windows «Обзор папок»: выберите папку и нажмите OK (ищите окно в панели задач, если не видно на экране)…", "muted");
  const startedAt = Date.now();
  const ticker = setInterval(() => {
    $("pickBtn").textContent = `Жду выбор… ${Math.round((Date.now() - startedAt) / 1000)} c`;
  }, 1000);
  try {
    const r = await api("/api/select-folder");
    if (r.path) { $("folder").value = r.path; logLine("Папка выбрана: " + r.path, "done"); }
    else if (r.error) logLine(r.error + " Введите путь вручную.", "err");
    else logLine("Окно было закрыто без выбора папки (нажата «Отмена» или крестик). Нажмите «Выбрать…» снова и обязательно нажмите OK после выбора папки.", "muted");
  } catch (e) { logLine(e.message, "err"); }
  finally { clearInterval(ticker); $("pickBtn").disabled = false; $("pickBtn").textContent = "Выбрать…"; }
};

// ---- запуск агента (потоковый) ----
$("runBtn").onclick = () => runAgent(false);
$("queueBtn").onclick = () => runAgent(true);

async function runAgent(toQueue) {
  const targetDir = $("folder").value.trim();
  const task = $("task").value.trim();
  if (!targetDir) return logLine("Сначала укажите рабочую папку.", "err");
  if (!task) return logLine("Опишите задачу для агента.", "err");

  hideChanges();
  logClear();

  if (toQueue) {
    try {
      const r = await api("/api/enqueue", { method: "POST", body: { targetDir, task } });
      logLine(`Задача #${r.id} добавлена в очередь. Запустите очередь справа.`, "done");
      refreshStatus();
    } catch (e) { logLine(e.message, "err"); }
    return;
  }

  setBusy(true);
  logLine("Агент запущен…", "muted");
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "x-adhp-token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ targetDir, task })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        handleStream(JSON.parse(line));
      }
    }
  } catch (e) {
    logLine(e.message, "err");
  } finally {
    setBusy(false);
    refreshStatus();
  }
}

function handleStream(msg) {
  if (msg.type === "progress") {
    const ev = msg.event;
    logLine(describeEvent(ev), ev.type === "tool_error" ? "err" : "tool");
  } else if (msg.type === "result") {
    const r = msg.result;
    logLine("✓ " + r.summary, "done");
    if (r.mode === "auto") {
      logLine(`Применено файлов: ${(r.applied || []).length}. Бэкап: ${r.backupDir || "—"}`, "done");
    } else if (r.changes && r.changes.length) {
      pendingChanges = r.changes;
      showChanges(r.changes);
    } else {
      logLine("Изменений нет.", "muted");
    }
  } else if (msg.type === "error") {
    logLine(msg.error, "err");
  }
}

function setBusy(b) {
  $("runBtn").disabled = b;
  $("queueBtn").disabled = b;
  $("runBtn").textContent = b ? "Работает…" : "Запустить сейчас";
}

// ---- diff ----
function showChanges(changes) {
  const wrap = $("diffs");
  wrap.innerHTML = "";
  for (const c of changes) {
    const card = document.createElement("div");
    card.className = "filecard";
    const head = document.createElement("div");
    head.className = "fhead";
    head.innerHTML = `<span>${escapeHtml(c.filePath)}</span><span class="badge">${c.isNew ? "новый файл" : "изменён"}</span>`;
    const diff = document.createElement("div");
    diff.className = "diff";
    diff.appendChild(renderDiff(c.oldContent || "", c.newContent || ""));
    card.appendChild(head); card.appendChild(diff);
    wrap.appendChild(card);
  }
  $("changes").style.display = "block";
}
function hideChanges() { $("changes").style.display = "none"; pendingChanges = null; }

$("cancelBtn").onclick = () => { hideChanges(); logLine("Изменения отменены, файлы не тронуты.", "muted"); };
$("applyBtn").onclick = async () => {
  if (!pendingChanges) return;
  const targetDir = $("folder").value.trim();
  try {
    const r = await api("/api/apply", { method: "POST", body: { targetDir, changes: pendingChanges.map((c) => ({ filePath: c.filePath, newContent: c.newContent })) } });
    logLine(`Применено: ${r.applied.join(", ")}. Бэкап: ${r.backupDir || "—"}`, "done");
    hideChanges();
  } catch (e) { logLine(e.message, "err"); }
};

// Простой построчный diff (LCS) — наглядно показывает добавленные/удалённые строки.
function renderDiff(oldText, newText) {
  const a = oldText.split("\n"), b = newText.split("\n");
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const frag = document.createDocumentFragment();
  let i = 0, j = 0;
  const row = (txt, cls) => { const d = document.createElement("div"); d.className = "dl " + cls; d.textContent = (cls === "add" ? "+ " : cls === "del" ? "- " : "  ") + txt; frag.appendChild(d); };
  while (i < n && j < m) {
    if (a[i] === b[j]) { row(a[i], "ctx"); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { row(a[i], "del"); i++; }
    else { row(b[j], "add"); j++; }
  }
  while (i < n) row(a[i++], "del");
  while (j < m) row(b[j++], "add");
  return frag;
}

function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// ---- очередь ----
$("startQ").onclick = async () => { await api("/api/queue/start", { method: "POST" }); logLine("Очередь запущена — задачи будут выполняться по мере освобождения лимитов.", "muted"); };
$("stopQ").onclick = async () => { await api("/api/queue/stop", { method: "POST" }); logLine("Очередь остановлена.", "muted"); };

$("saveKey").onclick = async () => {
  const value = $("apiKey").value.trim();
  if (!value) return;
  try {
    await api("/api/save-key", { method: "POST", body: { value } });
    $("apiKey").value = "";
    logLine("Ключ сохранён в .env.", "done");
    refreshStatus();
  } catch (e) { logLine(e.message, "err"); }
};

// ---- статус и шкалы лимитов ----
function gauge(id, str) {
  const [usedRaw, limitRaw] = str.split("/");
  const used = Number(usedRaw);
  const limit = limitRaw === "∞" ? 0 : Number(limitRaw);
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  $(id + "Txt").textContent = str;
  const fill = $(id + "Fill");
  fill.style.width = pct + "%";
  fill.style.background = pct > 85 ? "var(--wait)" : "var(--work)";
}

async function refreshStatus() {
  try {
    const s = await api("/api/status");
    $("prov").innerHTML = `<b>${s.provider.label}</b><br>${s.provider.model}`;
    if (s.applyMode) $("modeTag").textContent = `режим: ${s.applyMode === "auto" ? "авто-применение" : "подтверждение diff"}`;
    $("keyState").innerHTML = s.hasKey ? `<span class="ok">✓ ${s.apiKeyEnv}</span>` : `<span class="no">${s.apiKeyEnv} не задан</span>`;
    gauge("rpm", s.usage.rpm);
    gauge("tpm", s.usage.tpm);
    gauge("rpd", s.usage.rpd);
    const cd = $("cooldown");
    if (s.usage.cooldownMs > 0) { cd.classList.add("show"); cd.textContent = `Пауза по лимиту: ${(s.usage.cooldownMs / 1000).toFixed(0)} c`; }
    else cd.classList.remove("show");

    const q = $("queue");
    if (!s.queue.length) { q.innerHTML = '<span class="qempty">Очередь пуста.</span>'; }
    else {
      q.innerHTML = "";
      for (const j of s.queue.slice(-12).reverse()) {
        const el = document.createElement("div");
        el.className = "qitem";
        el.innerHTML = `<div class="qtask">#${j.id} ${escapeHtml(j.task || j.type)}</div><div class="qstatus ${j.status}">${j.status}</div>`;
        q.appendChild(el);
      }
    }
  } catch (e) { /* тихо: статус опрашивается часто */ }
}

// режим применения берём из статуса провайдера? Покажем из конфигурации через первый статус.
refreshStatus();
setInterval(refreshStatus, 2500);