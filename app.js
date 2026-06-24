/* ============================================================
   Wolverine PhotoStudio — app logic
   - Drag & drop / browse upload
   - Staging preview with per-photo removal
   - Publish a shoot -> persisted gallery (IndexedDB)
   - Brand filtering, lightbox, live stats
   No backend. Everything lives in this browser.
   ============================================================ */
(() => {
  "use strict";

  /* ---------- Tiny IndexedDB wrapper ---------- */
  const DB_NAME = "wolverine-photostudio";
  const STORE = "photos";
  let dbPromise;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: "id" });
          s.createIndex("createdAt", "createdAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbAll() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }
  async function dbPut(rec) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  /* ---------- DOM refs ---------- */
  const $ = (s) => document.querySelector(s);
  const dropzone = $("#dropzone");
  const fileInput = $("#fileInput");
  const staging = $("#staging");
  const stagingGrid = $("#stagingGrid");
  const stagingCount = $("#stagingCount");
  const clearStagingBtn = $("#clearStaging");
  const queueNote = $("#queueNote");
  const publishBtn = $("#publishBtn");
  const shootForm = $("#shootForm");
  const gallery = $("#gallery");
  const emptyState = $("#emptyState");
  const filters = $("#portfolioFilters");
  const lightbox = $("#lightbox");
  const lightboxImg = $("#lightboxImg");
  const lightboxCaption = $("#lightboxCaption");

  let stagedFiles = []; // { id, dataUrl, name }

  /* ---------- Helpers ---------- */
  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function readAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  // Downscale large images so the gallery stays snappy and storage stays small.
  function resizeDataUrl(dataUrl, maxDim = 1600, quality = 0.82) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (Math.max(width, height) <= maxDim) return res(dataUrl);
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const c = document.createElement("canvas");
        c.width = width;
        c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        res(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => res(dataUrl);
      img.src = dataUrl;
    });
  }

  let toastTimer;
  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /* ---------- Upload handling ---------- */
  async function ingestFiles(fileList) {
    const images = Array.from(fileList).filter((f) =>
      f.type.startsWith("image/")
    );
    if (!images.length) {
      toast("Those weren't images — try JPG, PNG or WEBP.");
      return;
    }
    for (const file of images) {
      const raw = await readAsDataURL(file);
      const dataUrl = await resizeDataUrl(raw);
      stagedFiles.push({ id: uid(), dataUrl, name: file.name });
    }
    renderStaging();
  }

  function renderStaging() {
    const n = stagedFiles.length;
    staging.hidden = n === 0;
    stagingCount.textContent = `(${n})`;
    publishBtn.disabled = n === 0;

    if (n === 0) {
      queueNote.textContent = "No photos staged yet.";
      queueNote.classList.remove("ready");
    } else {
      queueNote.textContent = `${n} photo${n > 1 ? "s" : ""} ready to publish.`;
      queueNote.classList.add("ready");
    }

    stagingGrid.innerHTML = "";
    stagedFiles.forEach((f) => {
      const cell = document.createElement("div");
      cell.className = "thumb";
      cell.innerHTML = `
        <img src="${f.dataUrl}" alt="${escapeHtml(f.name)}" />
        <button class="thumb-remove" aria-label="Remove ${escapeHtml(
          f.name
        )}">×</button>`;
      cell.querySelector(".thumb-remove").addEventListener("click", () => {
        stagedFiles = stagedFiles.filter((x) => x.id !== f.id);
        renderStaging();
      });
      stagingGrid.appendChild(cell);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  /* ---------- Dropzone events ---------- */
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", (e) => {
    ingestFiles(e.target.files);
    fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-drag");
    })
  );
  ["dragleave", "dragend", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-drag");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) ingestFiles(e.dataTransfer.files);
  });
  // Allow dropping anywhere in the upload section too.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  clearStagingBtn.addEventListener("click", () => {
    stagedFiles = [];
    renderStaging();
  });

  /* ---------- Publish ---------- */
  shootForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!stagedFiles.length) return;

    const title =
      $("#shootTitle").value.trim() || "Untitled photoshoot";
    const brand = $("#shootBrand").value;
    const photographer =
      $("#shootPhotographer").value.trim() || "Studio";
    const createdAt = Date.now();
    const shootId = uid();

    publishBtn.disabled = true;
    publishBtn.textContent = "Publishing…";

    for (let i = 0; i < stagedFiles.length; i++) {
      await dbPut({
        id: stagedFiles[i].id,
        shootId,
        title,
        brand,
        photographer,
        dataUrl: stagedFiles[i].dataUrl,
        order: i,
        createdAt,
      });
    }

    const count = stagedFiles.length;
    stagedFiles = [];
    renderStaging();
    shootForm.reset();
    publishBtn.textContent = "Publish to portfolio";

    await refreshGallery();
    toast(`Published ${count} photo${count > 1 ? "s" : ""} to “${title}”.`);
    document
      .querySelector("#portfolio")
      .scrollIntoView({ behavior: "smooth" });
  });

  /* ---------- Gallery + filters ---------- */
  let allPhotos = [];
  let activeFilter = "all";

  async function refreshGallery() {
    allPhotos = (await dbAll()).sort(
      (a, b) => b.createdAt - a.createdAt || a.order - b.order
    );
    renderFilters();
    renderGallery();
    updateStats();
  }

  function renderFilters() {
    const brands = [...new Set(allPhotos.map((p) => p.brand))].sort();
    filters.innerHTML = "";
    const make = (label, val) => {
      const b = document.createElement("button");
      b.className = "chip" + (activeFilter === val ? " is-active" : "");
      b.dataset.filter = val;
      b.textContent = label;
      b.addEventListener("click", () => {
        activeFilter = val;
        renderFilters();
        renderGallery();
      });
      return b;
    };
    filters.appendChild(make("All", "all"));
    brands.forEach((br) => filters.appendChild(make(br, br)));
  }

  function renderGallery() {
    const list =
      activeFilter === "all"
        ? allPhotos
        : allPhotos.filter((p) => p.brand === activeFilter);

    emptyState.style.display = allPhotos.length ? "none" : "block";
    gallery.innerHTML = "";

    list.forEach((p) => {
      const card = document.createElement("figure");
      card.className = "gallery-card";
      card.innerHTML = `
        <button class="card-del" aria-label="Delete photo">×</button>
        <img src="${p.dataUrl}" alt="${escapeHtml(p.title)}" loading="lazy" />
        <figcaption class="card-meta">
          <div class="m-brand">${escapeHtml(p.brand)}</div>
          <div class="m-title">${escapeHtml(p.title)}</div>
          <div class="m-by">by ${escapeHtml(p.photographer)}</div>
        </figcaption>`;
      card
        .querySelector("img")
        .addEventListener("click", () => openLightbox(p));
      card.querySelector(".card-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        await dbDelete(p.id);
        await refreshGallery();
        toast("Photo removed.");
      });
      gallery.appendChild(card);
    });
  }

  function updateStats() {
    const shoots = new Set(allPhotos.map((p) => p.shootId)).size;
    animateCount($("#stat-photos"), allPhotos.length);
    animateCount($("#stat-shoots"), shoots);
  }

  function animateCount(el, target) {
    if (!el) return;
    const start = parseInt(el.textContent, 10) || 0;
    const dur = 600;
    const t0 = performance.now();
    (function step(now) {
      const p = Math.min((now - t0) / dur, 1);
      el.textContent = Math.round(start + (target - start) * p);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ---------- Lightbox ---------- */
  function openLightbox(p) {
    lightboxImg.src = p.dataUrl;
    lightboxImg.alt = p.title;
    lightboxCaption.textContent = `${p.title} — ${p.brand} · by ${p.photographer}`;
    lightbox.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.src = "";
    document.body.style.overflow = "";
  }
  $("#lightboxClose").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.hidden) closeLightbox();
  });

  /* ---------- Mobile nav ---------- */
  const navToggle = document.querySelector(".nav-toggle");
  const nav = document.querySelector(".main-nav");
  navToggle?.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(open));
  });
  nav?.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => nav.classList.remove("open"))
  );

  /* ---------- Init ---------- */
  document.getElementById("year").textContent = new Date().getFullYear();
  refreshGallery();
})();
