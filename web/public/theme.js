// Applies the remembered theme and sidebar before first paint (no flash), as homelab-management does.
// Kept external because the CSP forbids inline scripts. Sidebar: remembered choice, else rail on tablets (640–1023 px).
(function () {
  try {
    var d = document.documentElement, t = localStorage.getItem("hlm-theme");
    if (t === "dark" || t === "light") d.dataset.theme = t;
    var s = localStorage.getItem("hlm-sidebar");
    if (s ? s === "rail" : innerWidth >= 640 && innerWidth < 1024) d.dataset.sidebar = "rail";
  } catch (e) {}
})();
