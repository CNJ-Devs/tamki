const $ = (s) => document.querySelector(s);
const dictionary = {
  en: {
    browser: "Browser",
    library: "Library",
    tasks: "Tasks",
    settings: "Settings",
    home: "Search or enter an address to start browsing.",
    libraryNote:
      "Library connections, indexing and collections are planned. This build contains the Chromium browser foundation.",
    tasksNote:
      "Video capture, series downloads and storage transfers are planned.",
    language: "Language",
    about: "Tamki 0.1.0 · Browser foundation",
    settingsNote:
      "Storage connections and library roots will be configured here.",
  },
  zh: {
    browser: "浏览器",
    library: "片库",
    tasks: "任务",
    settings: "设置",
    home: "搜索或输入地址，开始浏览。",
    libraryNote:
      "片库连接、索引与合集尚未接入。当前版本提供 Chromium 浏览器底座。",
    tasksNote: "视频抓取、全集下载和存储迁移尚未接入。",
    language: "语言",
    about: "Tamki 0.1.0 · 浏览器底座",
    settingsNote: "存储连接和片源目录将在这里配置。",
  },
};
let language =
  localStorage.getItem("language") ||
  (navigator.language.startsWith("zh") ? "zh" : "en");
let currentPage = "browser";
const t = (key) => dictionary[language][key];
async function act(type, value) {
  try {
    return await window.tamki.action(type, value);
  } catch (e) {
    $("#error").textContent = e.message;
  }
}
function translate() {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document
    .querySelectorAll("[data-i18n]")
    .forEach((el) => (el.textContent = t(el.dataset.i18n)));
  $("#address").placeholder =
    language === "zh" ? "搜索或输入网址" : "Search or enter address";
  showPage(currentPage);
}
function showPage(page) {
  currentPage = page;
  $("#browser").hidden = page !== "browser";
  $("#other").hidden = page === "browser";
  document.querySelectorAll("[data-page]").forEach((el) => {
    el.classList.toggle("active", el.dataset.page === page);
    el.setAttribute(
      "aria-current",
      el.dataset.page === page ? "page" : "false",
    );
    el.title = t(el.dataset.page);
  });
  if (page === "browser") return;
  $("#other").replaceChildren();
  const h = document.createElement("h1");
  h.textContent = t(page);
  $("#other").append(h);
  const p = document.createElement("p");
  p.textContent = t(
    page === "library"
      ? "libraryNote"
      : page === "tasks"
        ? "tasksNote"
        : "settingsNote",
  );
  $("#other").append(p);
  if (page === "settings") {
    const label = document.createElement("label");
    label.textContent = t("language");
    const select = document.createElement("select");
    select.innerHTML =
      '<option value="en">English</option><option value="zh">简体中文</option>';
    select.value = language;
    select.onchange = () => {
      language = select.value;
      localStorage.setItem("language", language);
      translate();
    };
    label.append(select);
    $("#other").append(label);
    const about = document.createElement("p");
    about.textContent = t("about");
    $("#other").append(about);
  }
}
function render(state) {
  $("#tabs").replaceChildren();
  for (const tab of state.tabs) {
    const row = document.createElement("div");
    row.className = "tab" + (tab.id === state.active ? " current" : "");
    const select = document.createElement("button");
    select.className = "tab-select";
    select.textContent =
      (tab.loading ? "◌ " : "") +
      (tab.url === "about:blank"
        ? language === "zh"
          ? "新标签页"
          : "New tab"
        : tab.title);
    select.title = tab.title;
    select.onclick = () => act("select", tab.id);
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${tab.title}`);
    close.onclick = () => act("close", tab.id);
    row.append(select, close);
    $("#tabs").append(row);
  }
  const plus = document.createElement("button");
  plus.textContent = "+";
  plus.className = "new";
  plus.setAttribute("aria-label", "New tab");
  plus.onclick = () => act("new");
  $("#tabs").append(plus);
  const active = state.tabs.find((x) => x.id === state.active);
  if (active) {
    if (document.activeElement !== $("#address"))
      $("#address").value = active.url === "about:blank" ? "" : active.url;
    $("#back").disabled = !active.back;
    $("#forward").disabled = !active.forward;
    $("#reload").textContent = active.loading ? "×" : "↻";
    $("#reload").onclick = () => act(active.loading ? "stop" : "reload");
    $("#error").textContent = active.error;
  }
  showPage(state.page);
}
$("#navigation").onsubmit = (e) => {
  e.preventDefault();
  act("navigate", $("#address").value);
  $("#address").blur();
};
$("#back").onclick = () => act("back");
$("#forward").onclick = () => act("forward");
$("#collapse").onclick = () => {
  const value = document.body.classList.toggle("collapsed");
  $("#collapse").setAttribute("aria-expanded", String(!value));
  act("collapse", value);
};
document
  .querySelectorAll("[data-page]")
  .forEach((el) => (el.onclick = () => act("page", el.dataset.page)));
document
  .querySelectorAll("[data-url]")
  .forEach((el) => (el.onclick = () => act("navigate", el.dataset.url)));
window.tamki.onState(render);
window.tamki.onFocusAddress(() => {
  $("#address").focus();
  $("#address").select();
});
translate();
act("state").then((state) => state && render(state));
