// Applied before first paint to avoid a theme flash. Kept external because the CSP forbids inline scripts.
(function () {
  var d = document.documentElement, mode = "system", palette = "classic";
  try { mode = localStorage.getItem("hlm-theme") || mode; palette = localStorage.getItem("hlm-palette") || palette; } catch (e) {}
  var dark = mode === "dark" || (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  d.dataset.theme = dark ? "dark" : "light";
  d.dataset.palette = palette;
})();
