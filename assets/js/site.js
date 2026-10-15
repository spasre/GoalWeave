(function () {
  const root = document.documentElement;
  const themeToggle = document.querySelector(".theme-toggle");
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function isDarkTheme() {
    return root.dataset.theme
      ? root.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  // 顶栏那个按钮是「跟随系统 → 亮色 → 暗色 → 跟随系统」三档循环
  function updateThemeToggle() {
    const mode = savedTheme();
    const dark = isDarkTheme();
    const label = mode === "auto"
      ? "主题：跟随系统（点一下换成亮色）"
      : mode === "dark"
        ? "主题：暗色（点一下换成跟随系统）"
        : "主题：亮色（点一下换成暗色）";
    themeToggle.setAttribute("aria-pressed", String(dark));
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
    // 图标由 CSS 按 data-theme 挑（见 style.css），这里只管标签和提示
    themeColor.content = dark ? "#121620" : "#f6f7fb";
  }

  themeToggle.addEventListener("click", () => {
    const mode = savedTheme();
    applyTheme(mode === "auto" ? "light" : mode === "light" ? "dark" : "auto");
  });

  // 主题三档：亮 / 暗 / 跟随系统（不写 data-theme，交给 CSS 的 prefers-color-scheme）
  function savedTheme() {
    try {
      const value = localStorage.getItem("spasre-theme");
      return value === "light" || value === "dark" ? value : "auto";
    } catch (error) {
      return "auto";
    }
  }

  function applyTheme(mode) {
    if (mode === "light" || mode === "dark") root.dataset.theme = mode;
    else delete root.dataset.theme;
    try {
      if (mode === "auto") localStorage.removeItem("spasre-theme");
      else localStorage.setItem("spasre-theme", mode);
    } catch (error) {
      console.error("Unable to save the theme preference.", error);
    }
    updateThemeToggle();
  }
  // 跟随系统时，系统换成夜间，顶栏那个按钮的状态也跟着变
  if (window.matchMedia) {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (savedTheme() === "auto") updateThemeToggle();
    };
    if (typeof scheme.addEventListener === "function") scheme.addEventListener("change", onChange);
    else if (typeof scheme.addListener === "function") scheme.addListener(onChange);
  }

  /* ---------- 外观：密度 / 字号 ---------- */
  // 跟主题一样只存本机（各设备自己调自己的），应用在 <html> 上，刷新时由 head 里那段先落好
  const LOOK_KEY = "spasre-look";

  function readLook() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOOK_KEY) || "null");
      return saved && typeof saved === "object" ? saved : {};
    } catch (error) {
      return {};
    }
  }

  function writeLook(patch) {
    const next = Object.assign({ density: "comfy", font: "normal" }, readLook(), patch);
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(next));
    } catch (error) {
      console.error("Unable to save the appearance preference.", error);
    }
    return next;
  }

  function applyLook(look) {
    const settings = look || readLook();
    root.dataset.density = settings.density === "compact" ? "compact" : "";
    root.dataset.font = settings.font === "small" || settings.font === "large" ? settings.font : "";
  }

  function syncLookControls() {
    const densitySelect = document.getElementById("look-density");
    const look = readLook();
    if (densitySelect) densitySelect.value = look.density === "compact" ? "compact" : "comfy";
    const fontSelect = document.getElementById("look-font");
    if (fontSelect) fontSelect.value = look.font === "small" || look.font === "large" ? look.font : "normal";
  }

  const lookDensity = document.getElementById("look-density");
  if (lookDensity) lookDensity.addEventListener("change", () => applyLook(writeLook({ density: lookDensity.value })));
  const lookFont = document.getElementById("look-font");
  if (lookFont) lookFont.addEventListener("change", () => applyLook(writeLook({ font: lookFont.value })));

  applyLook();
  syncLookControls();
  updateThemeToggle();

  const searchForm = document.querySelector(".search-form");
  const searchInput = document.querySelector(".search-input");
  const searchResults = document.querySelector("#search-results");
  const searchIndex = [];

  const postData = document.querySelector("#post-search-data");
  if (postData) {
    try {
      searchIndex.push(...JSON.parse(postData.textContent));
    } catch (error) {
      console.error("Unable to read the article index.", error);
    }
  }

  for (const node of document.querySelectorAll("[data-search]")) {
    searchIndex.push({
      title: node.dataset.search,
      detail: node.dataset.searchDetail || "",
      href: node.dataset.searchHref || "#top",
      type: node.dataset.searchType || "页面"
    });
  }

  function tokenize(query) {
    const terms = [];
    const parts = query.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9]+/giu) || [];

    for (const part of parts) {
      if (/^[a-z0-9]+$/i.test(part)) {
        terms.push(part);
      } else if (part.length === 1) {
        terms.push(part);
      } else {
        for (let i = 0; i < part.length - 1; i += 1) {
          terms.push(part.slice(i, i + 2));
        }
      }
    }

    return [...new Set(terms)];
  }

  function search(query) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const terms = tokenize(normalizedQuery);
    if (!normalizedQuery || terms.length === 0) return [];

    return searchIndex
      .map((item) => {
        const title = item.title.toLocaleLowerCase();
        const detail = item.detail.toLocaleLowerCase();
        const searchable = `${title} ${detail} ${item.type.toLocaleLowerCase()}`;
        if (!terms.every((term) => searchable.includes(term))) return null;

        const score = (title.includes(normalizedQuery) ? 100 : 0)
          + terms.reduce((total, term) => total + (title.includes(term) ? 10 : 0), 0)
          + (detail.includes(normalizedQuery) ? 5 : 0);
        return { ...item, score };
      })
      .filter((item) => item !== null)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-CN"))
      .slice(0, 5);
  }

  function closeSearchResults() {
    searchResults.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
  }

  function renderSearchResults(query) {
    searchResults.replaceChildren();
    if (!query.trim()) {
      closeSearchResults();
      return;
    }

    const results = search(query);
    if (results.length === 0) {
      const empty = document.createElement("p");
      empty.className = "search-empty";
      empty.textContent = "没有找到相关内容，试试其他关键词。";
      searchResults.append(empty);
    } else {
      for (const result of results) {
        const link = document.createElement("a");
        link.className = "search-result";
        link.href = result.href;

        const title = document.createElement("span");
        title.className = "search-result-title";
        title.textContent = result.title;

        const detail = document.createElement("span");
        detail.className = "search-result-detail";
        detail.textContent = result.detail ? `${result.type} · ${result.detail}` : result.type;

        link.append(title, detail);
        link.addEventListener("click", closeSearchResults);
        searchResults.append(link);
      }
    }

    searchResults.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  }

  if (searchForm && searchInput && searchResults) {
    searchInput.addEventListener("input", () => renderSearchResults(searchInput.value));

    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const firstResult = searchResults.querySelector(".search-result");
      if (firstResult) firstResult.click();
      else renderSearchResults(searchInput.value);
    });

    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeSearchResults();
    });
  }

  document.addEventListener("click", (event) => {
    if (!searchResults) return;
    if (!event.target.closest(".header-actions")) closeSearchResults();
  });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const mascotBase = (() => {
    const current = document.currentScript;
    const src = current && current.src ? current.src : "";
    return /\/js\/site\.js/.test(src)
      ? src.replace(/\/js\/site\.js(?:\?.*)?$/, "/images/mascot/")
      : "/assets/images/mascot/";
  })();

  function startPetals() {
    const canvas = document.querySelector("#petals");
    if (!canvas || reduceMotion.matches) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    // 樱花 + 马卡龙：粉 / 蜜桃 / 柠檬 / 薄荷 / 天蓝 / 丁香，再掺一点深粉与湖蓝
    const palette = [
      "231, 155, 176",
      "240, 195, 154",
      "230, 220, 158",
      "168, 216, 207",
      "166, 196, 232",
      "195, 174, 224",
      "222, 138, 172",
      "124, 158, 214"
    ];
    let width = 0;
    let height = 0;
    let petals = [];
    let frame = 0;

    function spawn(anywhere) {
      const scale = 0.55 + Math.random() * 0.85;
      return {
        x: Math.random() * width,
        y: anywhere ? Math.random() * height : -30,
        radius: 4.6 * scale,
        spin: Math.random() * Math.PI * 2,
        spinSpeed: (Math.random() - 0.5) * 0.022,
        fall: 0.26 + Math.random() * 0.5,
        drift: (Math.random() - 0.5) * 0.42,
        sway: Math.random() * Math.PI * 2,
        swaySpeed: 0.006 + Math.random() * 0.013,
        alpha: 0.3 + Math.random() * 0.42,
        color: palette[Math.floor(Math.random() * palette.length)]
      };
    }

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.round(Math.min(22, Math.max(9, width / 74)));
      petals = Array.from({ length: count }, () => spawn(true));
    }

    function drawPetal(petal) {
      const r = petal.radius;
      context.save();
      context.translate(petal.x, petal.y);
      context.rotate(petal.spin);
      context.globalAlpha = petal.alpha;
      context.fillStyle = `rgb(${petal.color})`;
      context.beginPath();
      context.moveTo(0, -r);
      context.bezierCurveTo(r * 1.15, -r * 0.72, r * 0.92, r * 0.62, 0, r);
      context.bezierCurveTo(-r * 0.92, r * 0.62, -r * 1.15, -r * 0.72, 0, -r);
      context.fill();
      context.restore();
    }

    function tick() {
      context.clearRect(0, 0, width, height);
      for (const petal of petals) {
        petal.sway += petal.swaySpeed;
        petal.spin += petal.spinSpeed;
        petal.y += petal.fall;
        petal.x += petal.drift + Math.sin(petal.sway) * 0.5;
        if (petal.y - petal.radius > height || petal.x < -70 || petal.x > width + 70) {
          Object.assign(petal, spawn(false));
        }
        drawPetal(petal);
      }
      frame = window.requestAnimationFrame(tick);
    }

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      } else if (!frame) {
        frame = window.requestAnimationFrame(tick);
      }
    });
    frame = window.requestAnimationFrame(tick);
  }

  function mountBackToTop() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "to-top";
    button.setAttribute("aria-label", "回到顶部");
    button.title = "回到顶部";

    const art = document.createElement("img");
    art.src = `${mascotBase}approach.webp`;
    art.alt = "";
    art.width = 240;
    art.height = 240;
    art.decoding = "async";
    button.append(art);

    button.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" });
    });

    document.body.append(button);
    return button;
  }

  function mountScrollUi() {
    const header = document.querySelector(".site-header");
    const progress = document.querySelector(".read-progress span");
    const toTop = mountBackToTop();
    let queued = false;

    function update() {
      queued = false;
      const scrolled = window.scrollY;

      if (header) header.classList.toggle("is-scrolled", scrolled > 8);
      if (toTop) toTop.classList.toggle("is-visible", scrolled > 420);

      if (progress) {
        const span = document.documentElement.scrollHeight - window.innerHeight;
        const ratio = span > 8 ? Math.min(1, Math.max(0, scrolled / span)) : 0;
        progress.style.transform = `scaleX(${ratio})`;
      }
    }

    function onScroll() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();
  }

  function startReveal() {
    const nodes = document.querySelectorAll(".home-intro, .section, .article-card, .post-body");
    if (nodes.length === 0) return;

    if (reduceMotion.matches || !("IntersectionObserver" in window)) return;

    nodes.forEach((node, index) => {
      node.classList.add("reveal");
      if (node.classList.contains("article-card")) {
        node.style.transitionDelay = `${(index % 4) * 70}ms`;
      }
    });

    const revealAll = () => {
      for (const node of nodes) node.classList.add("is-in");
    };

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });

    nodes.forEach((node) => observer.observe(node));
    window.setTimeout(revealAll, 1600);
  }

  startPetals();
  mountScrollUi();
  startReveal();
})();
